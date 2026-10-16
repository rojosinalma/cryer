// Runtime configuration from the `settings` table, with a short in-process cache (bounded).

import { eq } from "drizzle-orm";
import { settings as table } from "../db/schema.ts";
import { env } from "./env.ts";
import { logger, setLevel } from "./log.ts";
import { getDb, weak } from "./store.ts";

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
  },
};

/** Default channel: settings row, then the env fallback for when the store is down. */
export async function defaultChannel(): Promise<string> {
  return settings.get("default_channel", env.defaultChannelId);
}

/**
 * Routing: explicit channel > route.<source>.<level> > route.<source>.* > default_channel (> env).
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

/** Re-apply log_level from the store on an interval. Returns the timer so callers can stop it. */
export function watchLogLevel(intervalMs = 30_000) {
  const timer = setInterval(async () => setLevel(await settings.get("log_level")), intervalMs);
  timer.unref?.();
  return timer;
}
