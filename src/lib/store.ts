// One `getDb()` over two drivers: bun:sqlite (RQLITE_URLS unset) or rqlite over HTTP (set).
// Reads run at rqlite level=strong unless wrapped in `weak(() => …)`, which uses level=none.

import { AsyncLocalStorage } from "node:async_hooks";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle as drizzleBun } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleProxy, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "../db/schema.ts";
import { env, storeKind } from "./env.ts";
import { SystemError } from "./errors.ts";
import { logger } from "./log.ts";

const log = logger("store");

type Schema = typeof schema;
// Both drivers are used through the async (remote) type; awaiting bun:sqlite's sync results is a no-op.
// Never use db.transaction(): the two drivers differ there — use Store.execBatch instead.
export type Db = SqliteRemoteDatabase<Schema>;

export interface Store {
  kind: "sqlite" | "rqlite";
  db: Db;
  /** Run statements as one transaction (bun:sqlite tx / one rqlite request with ?transaction). */
  execBatch(statements: string[]): Promise<void>;
  ping(): Promise<boolean>;
  close(): void;
}

const consistency = new AsyncLocalStorage<"none" | "strong">();

/** Run `fn` with rqlite reads at level=none (routing lookups, settings). No effect on bun:sqlite. */
export const weak = <T>(fn: () => Promise<T> | T): Promise<T> => Promise.resolve(consistency.run("none", fn));

// ---------- bun:sqlite ----------

export function openSqlite(path: string): Store {
  if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
  const sqlite = new Database(path, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = drizzleBun(sqlite, { schema }) as unknown as Db;
  return {
    kind: "sqlite",
    db,
    execBatch: async (statements) => {
      sqlite.transaction(() => {
        for (const s of statements) sqlite.run(s);
      })();
    },
    ping: async () => sqlite.query("SELECT 1").get() !== null,
    close: () => sqlite.close(),
  };
}

// ---------- rqlite ----------

interface RqliteResult {
  columns?: string[];
  types?: string[];
  values?: unknown[][];
  error?: string;
  rows_affected?: number;
}

interface RqliteResponse {
  results?: RqliteResult[];
  error?: string;
}

const RETRY_STATUSES = new Set([503, 301, 302, 307, 308]);

export function openRqlite(urls: readonly string[]): Store {
  let lastGood = 0;

  async function request(path: string, body: unknown[]): Promise<RqliteResult[]> {
    const n = urls.length;
    let lastErr: unknown;
    for (let i = 0; i < n; i++) {
      const idx = (lastGood + i) % n;
      const base = urls[idx]!;
      try {
        const res = await fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (RETRY_STATUSES.has(res.status)) {
          log.warn(`POST ${base}${path} -> ${res.status} (not leader / unavailable), trying next`);
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          log.warn(`POST ${base}${path} -> ${res.status} ${text.slice(0, 200)}`);
          throw new SystemError(`rqlite HTTP ${res.status}: ${text.slice(0, 200)}`, 502);
        }
        const json = (await res.json()) as RqliteResponse;
        if (json.error) throw new SystemError(`rqlite: ${json.error}`, 502);
        log.debug(`POST ${base}${path} -> ${res.status} ${body.length} stmt`);
        lastGood = idx;
        return json.results ?? [];
      } catch (err) {
        if (err instanceof SystemError) throw err;
        lastErr = err;
        log.warn(`POST ${base}${path} failed: ${err instanceof Error ? err.message : err}, trying next`);
      }
    }
    throw new SystemError(`store unavailable: all ${n} rqlite nodes failed (${String(lastErr)})`, 503);
  }

  const db: Db = drizzleProxy(
    async (sql, params, method) => {
      const level = consistency.getStore() === "none" && method !== "run" ? "none" : "strong";
      const [result] = await request(`/db/request?level=${level}&timings`, [[sql, ...params]]);
      if (!result) throw new SystemError("rqlite: empty result", 502);
      if (result.error) throw new SystemError(`rqlite: ${result.error}`, 502);
      const values = result.values ?? [];
      if (method === "get") return { rows: values[0] ?? (undefined as unknown as unknown[]) };
      return { rows: values };
    },
    { schema },
  );

  return {
    kind: "rqlite",
    db,
    execBatch: async (statements) => {
      const results = await request("/db/request?level=strong&transaction&timings", statements);
      const failed = results.find((r) => r.error);
      if (failed) throw new SystemError(`rqlite: ${failed.error}`, 502);
    },
    ping: async () => {
      const [r] = await request("/db/request?level=weak", ["SELECT 1"]);
      return Boolean(r && !r.error);
    },
    close: () => {},
  };
}

// ---------- singleton ----------

let store: Store | null = null;

export function getStore(): Store {
  if (store) return store;
  store = storeKind() === "rqlite" ? openRqlite(env.rqliteUrls) : openSqlite(join(env.dataDir, "cryer.db"));
  log.info(`store: ${store.kind}${store.kind === "rqlite" ? " " + env.rqliteUrls.join(",") : " " + env.dataDir}`);
  return store;
}

export const getDb = (): Db => getStore().db;

/** Tests inject their own store (e.g. openSqlite(":memory:")). */
export function setStore(s: Store | null) {
  store = s;
}
