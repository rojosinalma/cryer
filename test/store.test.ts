import { afterEach, describe, expect, mock, test } from "bun:test";
import "./setup.ts";
import { sql } from "drizzle-orm";
import { runMigrations } from "../src/db/migrate.ts";
import { settings as table } from "../src/db/schema.ts";
import { openRqlite, openSqlite, weak } from "../src/lib/store.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("migrations", () => {
  test("idempotent: second run applies nothing, duplicate insert is ignored", async () => {
    const s = openSqlite(":memory:");
    expect(await runMigrations(s)).toEqual(["0001_init.sql", "0002_gateway.sql", "0003_dm.sql"]);
    expect(await runMigrations(s)).toEqual([]);
    const names = await s.db.all<{ name: string }>(sql`SELECT name FROM migrations`);
    expect(names).toHaveLength(3);
  });

  test("a replica that lost the race on an ALTER TABLE treats the migration as applied", async () => {
    const s = openSqlite(":memory:");
    await runMigrations(s);
    // Simulate the other replica having applied 0002 between our read of `migrations` and our batch.
    await s.execBatch(["DELETE FROM migrations WHERE name = '0002_gateway.sql'"]);
    expect(await runMigrations(s)).toEqual([]); // "duplicate column name: via" is tolerated, not thrown
  });
});

describe("rqlite driver", () => {
  test("maps rqlite rows to drizzle, fails over to the next node, honours weak reads", async () => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: JSON.parse(init!.body as string) });
      if (u.startsWith("http://node1")) return new Response("", { status: 503 });
      if (u.startsWith("http://node2")) throw new Error("ECONNREFUSED");
      return new Response(
        JSON.stringify({ results: [{ columns: ["key", "value", "updated_at"], types: ["text", "text", "text"], values: [["a", "1", "t"], ["b", "2", "t"]] }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const s = openRqlite(["http://node1:4001", "http://node2:4001", "http://node3:4001"]);
    const rows = await s.db.select().from(table);
    expect(rows).toEqual([
      { key: "a", value: "1", updatedAt: "t" },
      { key: "b", value: "2", updatedAt: "t" },
    ]);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["node1", "node2", "node3"]);
    expect(calls[2]!.url).toContain("/db/request?level=strong");
    expect(calls[2]!.body).toEqual([[`select "key", "value", "updated_at" from "settings"`]]);

    // Sticks to the last good node and uses level=none inside weak().
    calls.length = 0;
    const one = await weak(() => s.db.select().from(table).get());
    expect(one).toEqual({ key: "a", value: "1", updatedAt: "t" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://node3:4001/db/request?level=none&timings");
  });

  test("gives up after one full round with a 503 system error", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const s = openRqlite(["http://a:4001", "http://b:4001"]);
    await expect(s.ping()).rejects.toMatchObject({ status: 503, kind: "system" });
  });

  test("per-statement errors surface as system errors", async () => {
    globalThis.fetch = mock(async () => Response.json({ results: [{ error: "no such table: nope" }] })) as unknown as typeof fetch;
    const s = openRqlite(["http://a:4001"]);
    await expect(s.execBatch(["SELECT * FROM nope"])).rejects.toThrow(/no such table/);
  });
});
