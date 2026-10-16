import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { logger } from "../lib/log.ts";
import type { Store } from "../lib/store.ts";

const log = logger("store");
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export const listMigrationFiles = (dir = MIGRATIONS_DIR) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

const splitStatements = (text: string) =>
  text
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Idempotent: both replicas may run this at once (IF NOT EXISTS everywhere, duplicate inserts ignored). */
export async function runMigrations(store: Store, dir = MIGRATIONS_DIR): Promise<string[]> {
  await store.execBatch([
    "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  ]);
  const applied = new Set(
    (await store.db.all<{ name: string }>(sql`SELECT name FROM migrations`)).map((r) => r.name),
  );
  const done: string[] = [];
  for (const file of listMigrationFiles(dir)) {
    if (applied.has(file)) continue;
    const statements = splitStatements(readFileSync(join(dir, file), "utf8"));
    const stamp = new Date().toISOString();
    statements.push(`INSERT OR IGNORE INTO migrations (name, applied_at) VALUES ('${file}', '${stamp}')`);
    try {
      await store.execBatch(statements);
      log.info(`migration applied: ${file} (${statements.length - 1} statements)`);
      done.push(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists|UNIQUE constraint|duplicate column/i.test(msg)) {
        log.info(`migration ${file} raced with another replica, treating as applied`);
        continue;
      }
      throw err;
    }
  }
  return done;
}
