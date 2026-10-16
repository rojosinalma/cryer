// Runtime configuration from the `settings` table, with a short in-process cache (bounded).

import { eq } from "drizzle-orm";
import { dmChannels, settings as table } from "../db/schema.ts";
import { discord } from "./discord.ts";
import { env } from "./env.ts";
import { ValidationError } from "./errors.ts";
import { logger, setLevel } from "./log.ts";
import { getDb, weak } from "./store.ts";
import { TARGET_RE } from "./types.ts";

const log = logger("settings");

export const CACHE_TTL_MS = 5_000;
const CACHE_MAX = 500;

export const DEFAULTS = {
  default_channel: "",
  prompt_ttl_s: "3600",
  purge_days: "30",
  log_level: "info",
  callback_allowlist: "127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
  max_queue: "200",
  ask_wait_max_s: "300",
  wait_poll_ms: "1000",
  session_callback_mode: "prompt",
  dagu_url: "",
  gateway_enabled: "true",
  gateway_lease_ttl_s: "30",
  gateway_lease_renew_s: "10",
  command_users: "",
  commands_register: "true",
} as const;

export type SettingKey = keyof typeof DEFAULTS;

const cache = new Map<string, { value: string | null; at: number }>();

function remember(key: string, value: string | null) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
}

async function read(key: string): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const row = await weak(() => getDb().select({ value: table.value }).from(table).where(eq(table.key, key)).get());
  const value = row?.value ?? null;
  remember(key, value);
  return value;
}

export const settings = {
  /** Read a key; falls back to `def` (or the built-in default) when missing or when the store errors. */
  async get(key: string, def?: string): Promise<string> {
    const fallback = def ?? (key in DEFAULTS ? DEFAULTS[key as SettingKey] : "");
    try {
      const v = await read(key);
      return v === null || v === "" ? fallback : v;
    } catch (err) {
      log.warn(`get ${key} failed, using fallback: ${err instanceof Error ? err.message : err}`);
      return fallback;
    }
  },

  async getInt(key: SettingKey): Promise<number> {
    const n = Number(await this.get(key));
    return Number.isFinite(n) ? n : Number(DEFAULTS[key]);
  },

  /** "true"/"1"/"yes"/"on" → true; anything else false. */
  async getBool(key: SettingKey): Promise<boolean> {
    return /^(true|1|yes|on)$/i.test((await this.get(key)).trim());
  },

  /** Strict read: throws on store failure (used by routes that must not guess). */
  async getOrThrow(key: string): Promise<string | null> {
    return read(key);
  },

  async set(key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    await getDb()
      .insert(table)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: table.key, set: { value, updatedAt: now } });
    remember(key, value);
    if (key === "log_level") setLevel(value);
  },

  async all(): Promise<Record<string, string>> {
    const rows = await weak(() => getDb().select().from(table).orderBy(table.key));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  /** Insert defaults that are missing (INSERT OR IGNORE – safe with two replicas booting at once). */
  async seed(): Promise<void> {
    const now = new Date().toISOString();
    const values = Object.entries({ ...DEFAULTS, default_channel: env.defaultChannelId }).map(([key, value]) => ({
      key,
      value,
      updatedAt: now,
    }));
    await getDb().insert(table).values(values).onConflictDoNothing();
    setLevel(await this.get("log_level"));
  },

  clearCache() {
    cache.clear();
    dmChannelByUser.clear();
  },
};

/** Default channel: settings row, then the env fallback for when the store is down. */
export async function defaultChannel(): Promise<string> {
  return settings.get("default_channel", env.defaultChannelId);
}

/**
 * Routing: explicit channel > route.<source>.<level> > route.<source>.* > default_channel (> env).
 * Returns the raw *target* (channel id or `dm:<user_id>`); `targetToChannel` turns it into a postable channel.
 * Pure helper over a lookup fn so it can be unit-tested without a store.
 */
export async function resolveChannel(
  source: string,
  level: string,
  explicit: string | undefined,
  lookup: (key: string) => Promise<string> = (k) => settings.get(k, ""),
): Promise<string> {
  if (explicit) return explicit;
  for (const key of [`route.${source}.${level}`, `route.${source}.*`]) {
    const v = await lookup(key);
    if (v) return v;
  }
  return (await lookup("default_channel")) || env.defaultChannelId;
}

// ---------- targets (channel id or dm:<user_id>) ----------

export const DM_PREFIX = "dm:";
export { TARGET_RE };

export type Target = { kind: "channel"; channelId: string } | { kind: "dm"; userId: string };

/** `dm:<user_id>` → the user id, anything else → undefined. */
export const dmUserId = (target: string): string | undefined =>
  target.startsWith(DM_PREFIX) ? target.slice(DM_PREFIX.length) : undefined;

export const isDmTarget = (target: string): boolean => dmUserId(target) !== undefined;

/** Build the `dm:<user_id>` target string (what `default_channel` / `route.*` hold for a DM). */
export const dmTarget = (userId: string) => `${DM_PREFIX}${userId}`;

/** Parse a target string; throws ValidationError 422 on anything that is neither a snowflake nor `dm:<snowflake>`. */
export function parseTarget(target: string): Target {
  if (!TARGET_RE.test(target)) {
    throw new ValidationError(`invalid target "${target}": expected a channel id or dm:<user_id>`, 422, { target });
  }
  const userId = dmUserId(target);
  return userId === undefined ? { kind: "channel", channelId: target } : { kind: "dm", userId };
}

const DM_CACHE_MAX = 200;
const dmChannelByUser = new Map<string, string>();

function rememberDm(userId: string, channelId: string) {
  if (dmChannelByUser.size >= DM_CACHE_MAX) {
    const oldest = dmChannelByUser.keys().next().value;
    if (oldest !== undefined) dmChannelByUser.delete(oldest);
  }
  dmChannelByUser.delete(userId);
  dmChannelByUser.set(userId, channelId);
}

/**
 * DM channel id for a user: in-process cache → `dm_channels` table → `POST /users/@me/channels` (then stored).
 * Discord returns the same DM channel for a user forever, so the mapping never needs invalidation.
 */
export async function dmChannelFor(userId: string): Promise<string> {
  const hit = dmChannelByUser.get(userId);
  if (hit) return hit;
  const row = await weak(() =>
    getDb().select({ channelId: dmChannels.channelId }).from(dmChannels).where(eq(dmChannels.userId, userId)).get(),
  );
  if (row) {
    rememberDm(userId, row.channelId);
    return row.channelId;
  }
  const ch = await discord().createDm(userId);
  const now = new Date().toISOString();
  await getDb()
    .insert(dmChannels)
    .values({ userId, channelId: ch.id, createdAt: now })
    .onConflictDoUpdate({ target: dmChannels.userId, set: { channelId: ch.id } });
  rememberDm(userId, ch.id);
  log.info(`dm channel ${ch.id} opened for user ${userId}`);
  return ch.id;
}

/** Postable channel id for a target: a channel id is itself, `dm:<user_id>` becomes the user's DM channel. */
export async function targetToChannel(target: string): Promise<string> {
  const t = parseTarget(target);
  return t.kind === "channel" ? t.channelId : dmChannelFor(t.userId);
}

/** Tests: forget the in-process DM mapping (the table is the next layer). */
export const clearDmCache = () => dmChannelByUser.clear();

/** Re-apply log_level from the store on an interval. Returns the timer so callers can stop it. */
export function watchLogLevel(intervalMs = 30_000) {
  const timer = setInterval(async () => setLevel(await settings.get("log_level")), intervalMs);
  timer.unref?.();
  return timer;
}
