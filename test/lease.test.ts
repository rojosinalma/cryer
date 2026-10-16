import { describe, expect, test } from "bun:test";
import { freshStore } from "./setup.ts";
import { acquireLease, LeaseRunner, readLease, releaseLease, renewLease, type LeaseConfig } from "../src/lib/lease.ts";

const cfg = (over: Partial<LeaseConfig> = {}): (() => Promise<LeaseConfig>) =>
  async () => ({ enabled: true, ttlS: 30, renewS: 10, ...over });

describe("lease primitives", () => {
  test("two contenders against one store: exactly one acquires; the loser cannot steal a live lease", async () => {
    await freshStore();
    const t0 = Date.parse("2026-10-11T12:00:00.000Z");
    const [a, b] = await Promise.all([acquireLease("gateway", "node-a", 30, t0), acquireLease("gateway", "node-b", 30, t0)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ? "node-a" : "node-b";
    const loser = a ? "node-b" : "node-a";
    expect((await readLease("gateway"))?.holder).toBe(winner);
    // Repeated attempts by the loser while the lease is live never succeed.
    for (let i = 0; i < 5; i++) expect(await acquireLease("gateway", loser, 30, t0 + i * 1000)).toBe(false);
    // The holder re-acquiring (idempotent) and renewing both work.
    expect(await acquireLease("gateway", winner, 30, t0 + 5000)).toBe(true);
    expect(await renewLease("gateway", winner, 30, t0 + 6000)).toBe(true);
    expect((await readLease("gateway"))?.expires_at).toBe(new Date(t0 + 36_000).toISOString());
  });

  test("an expired lease can be taken over; the old holder's renew then fails", async () => {
    await freshStore();
    const t0 = Date.parse("2026-10-11T12:00:00.000Z");
    expect(await acquireLease("gateway", "node-a", 30, t0)).toBe(true);
    expect(await acquireLease("gateway", "node-b", 30, t0 + 29_000)).toBe(false);
    expect(await acquireLease("gateway", "node-b", 30, t0 + 31_000)).toBe(true);
    expect((await readLease("gateway"))?.holder).toBe("node-b");
    expect(await renewLease("gateway", "node-a", 30, t0 + 32_000)).toBe(false);
    expect(await renewLease("gateway", "node-b", 30, t0 + 32_000)).toBe(true);
  });

  test("release frees the lease immediately, but only for its holder", async () => {
    await freshStore();
    const t0 = Date.now();
    expect(await acquireLease("gateway", "a", 30, t0)).toBe(true);
    await releaseLease("gateway", "b");
    expect((await readLease("gateway"))?.holder).toBe("a");
    await releaseLease("gateway", "a");
    expect(await readLease("gateway")).toBeUndefined();
    expect(await acquireLease("gateway", "b", 30, t0)).toBe(true);
  });
});

describe("LeaseRunner", () => {
  const runner = (holder: string, log: string[], over: Partial<LeaseConfig> = {}, clock?: { now: number }) =>
    new LeaseRunner({
      name: "gateway",
      holder,
      config: cfg(over),
      onLeader: async () => void log.push(`${holder}:leader`),
      onFollower: async (reason) => void log.push(`${holder}:follower:${reason}`),
      now: clock ? () => clock.now : undefined,
    });

  test("ticks: follower acquires, leader renews, a lost lease steps down", async () => {
    await freshStore();
    const log: string[] = [];
    const clock = { now: Date.parse("2026-10-11T12:00:00.000Z") };
    const a = runner("a", log, {}, clock);
    const b = runner("b", log, {}, clock);
    expect(await a.tick()).toBe(10_000);
    expect(a.isLeader).toBe(true);
    await b.tick();
    expect(b.isLeader).toBe(false);
    clock.now += 10_000;
    await a.tick();
    expect(a.isLeader).toBe(true);
    // a dies silently (no more ticks); after the ttl, b takes over at its next poll.
    clock.now += 31_000;
    await b.tick();
    expect(b.isLeader).toBe(true);
    // a comes back: its renew finds the lease gone and it steps down.
    await a.tick();
    expect(a.isLeader).toBe(false);
    expect(log).toEqual(["a:leader", "b:leader", "a:follower:lease taken by another holder"]);
  });

  test("gateway_enabled=false makes a leader step down and release", async () => {
    await freshStore();
    const log: string[] = [];
    let enabled = true;
    const r = new LeaseRunner({
      name: "gateway",
      holder: "a",
      config: async () => ({ enabled, ttlS: 30, renewS: 10 }),
      onLeader: async () => void log.push("leader"),
      onFollower: async (reason) => void log.push(`follower:${reason}`),
    });
    await r.tick();
    expect(r.isLeader).toBe(true);
    enabled = false;
    await r.tick();
    expect(r.isLeader).toBe(false);
    expect(await readLease("gateway")).toBeUndefined();
    expect(log).toEqual(["leader", "follower:disabled by gateway_enabled"]);
  });

  test("a failing onLeader drops leadership and backs off; the loop runs and stop() releases", async () => {
    await freshStore();
    const log: string[] = [];
    let fail = true;
    const r = new LeaseRunner({
      name: "gateway",
      holder: "a",
      config: cfg({ ttlS: 1, renewS: 0.01 }),
      onLeader: async () => {
        if (fail) throw new Error("connect failed");
        log.push("leader");
      },
      onFollower: async (reason) => void log.push(`follower:${reason}`),
    });
    const delay = await r.tick();
    expect(r.isLeader).toBe(false);
    expect(delay).toBe(20); // renew × 2^1 after one error
    expect(await readLease("gateway")).toBeUndefined();
    fail = false;
    void r.start();
    for (let i = 0; i < 50 && !r.isLeader; i++) await new Promise((res) => setTimeout(res, 10));
    expect(r.isLeader).toBe(true);
    await r.stop();
    expect(r.isLeader).toBe(false);
    expect(await readLease("gateway")).toBeUndefined();
    expect(log).toEqual(["follower:leader start failed", "leader", "follower:stopped"]);
  });
});
