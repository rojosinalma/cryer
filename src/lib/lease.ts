// Lease-based leader election on the `leases` table (one row per name). Used by the gateway
// transport so exactly one replica holds the Discord websocket. Every write is strong-consistency;
// acquisition is a single conditional upsert, so two contenders against one store get one winner.

import { hostname } from "node:os";
import { and, eq, lt, or } from "drizzle-orm";
import { leases } from "../db/schema.ts";
import { logger } from "./log.ts";
import { getDb, weak } from "./store.ts";

const log = logger("lease");

export const GATEWAY_LEASE = "gateway";

/** Identity of this replica: CRYER_NODE or the hostname. */
export const nodeName = (): string => process.env.CRYER_NODE || hostname();

const iso = (ms: number) => new Date(ms).toISOString();

export interface LeaseRow {
  holder: string;
  expires_at: string;
}

/**
 * Take the lease when it is free, expired, or already ours; never steal a live lease.
 * One statement: INSERT … ON CONFLICT DO UPDATE … WHERE (expired OR own) RETURNING — the store
 * serialises it, so of two concurrent contenders exactly one gets a row back.
 */
export async function acquireLease(name: string, holder: string, ttlS: number, nowMs = Date.now()): Promise<boolean> {
  const expiresAt = iso(nowMs + ttlS * 1000);
  const won = await getDb()
    .insert(leases)
    .values({ name, holder, expiresAt })
    .onConflictDoUpdate({
      target: leases.name,
      set: { holder, expiresAt },
      setWhere: or(lt(leases.expiresAt, iso(nowMs)), eq(leases.holder, holder)),
    })
    .returning({ holder: leases.holder });
  return won.length > 0;
}

/** Extend our own lease; false when it is no longer ours (someone took it after it expired). */
export async function renewLease(name: string, holder: string, ttlS: number, nowMs = Date.now()): Promise<boolean> {
  const won = await getDb()
    .update(leases)
    .set({ expiresAt: iso(nowMs + ttlS * 1000) })
    .where(and(eq(leases.name, name), eq(leases.holder, holder)))
    .returning({ holder: leases.holder });
  return won.length > 0;
}

/** Give the lease up (only if ours) so a follower can take it at its next poll. */
export async function releaseLease(name: string, holder: string): Promise<void> {
  await getDb()
    .delete(leases)
    .where(and(eq(leases.name, name), eq(leases.holder, holder)));
}

/** Current row (weak read; for /health). */
export async function readLease(name: string): Promise<LeaseRow | undefined> {
  const row = await weak(() =>
    getDb().select({ holder: leases.holder, expires_at: leases.expiresAt }).from(leases).where(eq(leases.name, name)).get(),
  );
  return row ?? undefined;
}

// ---------- runner ----------

export interface LeaseConfig {
  /** Off: a leader steps down, a follower stops trying (polling continues so a flip is picked up). */
  enabled: boolean;
  ttlS: number;
  renewS: number;
}

export interface LeaseRunnerOptions {
  name: string;
  holder: string;
  config: () => Promise<LeaseConfig>;
  /** Called once per transition to leader; a throw drops leadership again (lease released). */
  onLeader: () => Promise<void>;
  /** Called once per transition back to follower (after a lost/failed renew, disable, or stop). */
  onFollower: (reason: string) => Promise<void>;
  /** Tests: fixed clock / sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Follower: poll every renew interval and try to acquire. Leader: renew every renew interval; a renew
 * that finds the lease gone steps down at once; a store error keeps leadership only while the last
 * acknowledged expiry is still in the future (nobody else can hold it before then), then steps down.
 * Store errors back off exponentially, capped at the ttl.
 */
export class LeaseRunner {
  private leader = false;
  private stopped = false;
  private errors = 0;
  private leaseUntil = 0;
  private running: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LeaseRunnerOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get isLeader() {
    return this.leader;
  }

  get holder() {
    return this.opts.holder;
  }

  start() {
    if (this.running) return this.running;
    this.stopped = false;
    this.running = this.loop();
    return this.running;
  }

  /** Step down (release the lease) and end the loop. */
  async stop() {
    this.stopped = true;
    this.wake?.();
    await this.running;
    this.running = null;
  }

  /** Leader gives the lease up early (e.g. its connection died for good); the loop keeps polling as a follower. */
  async abdicate(reason: string) {
    if (!this.leader) return;
    await this.stepDown(reason);
  }

  /** One iteration; exported for tests. Returns the delay (ms) until the next one. */
  async tick(): Promise<number> {
    const cfg = await this.opts.config();
    const renewMs = Math.max(cfg.renewS, 0.001) * 1000;
    const backoff = () => Math.min(renewMs * 2 ** this.errors, Math.max(cfg.ttlS, cfg.renewS) * 1000);

    if (!cfg.enabled) {
      if (this.leader) await this.stepDown("disabled by gateway_enabled");
      return renewMs;
    }

    let phase = this.leader ? "renew" : "acquire";
    try {
      if (!this.leader) {
        if (await acquireLease(this.opts.name, this.opts.holder, cfg.ttlS, this.now())) {
          this.leaseUntil = this.now() + cfg.ttlS * 1000;
          phase = "leader start";
          await this.becomeLeader();
        }
      } else if (await renewLease(this.opts.name, this.opts.holder, cfg.ttlS, this.now())) {
        this.leaseUntil = this.now() + cfg.ttlS * 1000;
      } else {
        await this.stepDown("lease taken by another holder");
      }
      this.errors = 0;
      return renewMs;
    } catch (err) {
      this.errors = Math.min(this.errors + 1, 10);
      const msg = err instanceof Error ? err.message : String(err);
      if (this.leader && this.now() >= this.leaseUntil) {
        await this.stepDown(`store unreachable past lease expiry: ${msg}`);
      } else {
        log.warn(`${this.opts.name}: ${phase} failed (${msg}), retry in ${backoff()}ms`);
      }
      // A leader re-checks no later than its own expiry so it never outlives the lease unnoticed.
      return this.leader ? Math.max(Math.min(backoff(), this.leaseUntil - this.now()), 100) : backoff();
    }
  }

  private async becomeLeader() {
    this.leader = true;
    log.info(`${this.opts.name}: ${this.opts.holder} is leader`);
    try {
      await this.opts.onLeader();
    } catch (err) {
      log.error(`${this.opts.name}: onLeader failed, stepping down`, err);
      await this.stepDown("leader start failed");
      throw err;
    }
  }

  private async stepDown(reason: string) {
    if (!this.leader) return;
    this.leader = false;
    log.info(`${this.opts.name}: ${this.opts.holder} is follower (${reason})`);
    try {
      await this.opts.onFollower(reason);
    } catch (err) {
      log.error(`${this.opts.name}: onFollower failed`, err);
    }
    try {
      await releaseLease(this.opts.name, this.opts.holder);
    } catch (err) {
      log.warn(`${this.opts.name}: release failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async loop() {
    while (!this.stopped) {
      let delay: number;
      try {
        delay = await this.tick();
      } catch {
        delay = 1000;
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        void this.sleep(delay).then(resolve);
      });
      this.wake = null;
    }
    await this.stepDown("stopped");
  }
}
