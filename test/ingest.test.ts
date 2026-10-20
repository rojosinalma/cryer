import { describe, expect, test } from "bun:test";
import { fakeDiscord, freshStore, authed, TEST_TOKEN } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { adapterFor, adapters, knownSources } from "../src/lib/ingest/index.ts";
import { levelFromStatus, retryUrl, RETRY_ACTION_ID, RETRY_ACTION_LABEL } from "../src/lib/ingest/dagu.ts";
import { settings } from "../src/lib/settings.ts";

describe("ingest registry", () => {
  test("knows apprise and dagu", () => {
    expect(knownSources().sort()).toEqual(["apprise", "dagu"]);
    expect(adapterFor("nope")).toBeUndefined();
  });

  test("apprise json:// payload → notify input", async () => {
    const n = await adapters.apprise!.parse({ version: "1.0", title: "Disk", message: "95% full", type: "warning", format: "text", id: "abc" });
    expect(n).toMatchObject({ source: "apprise", level: "warning", title: "Disk", body: "95% full" });
    expect(n.fields).toEqual([{ name: "id", value: "abc", inline: true }]);
    const noTitle = await adapters.apprise!.parse({ message: "first line\nsecond", type: "info" });
    expect(noTitle.title).toBe("first line");
  });

  test("apprise rejects an unknown type", () => {
    expect(() => adapters.apprise!.parse({ title: "x", type: "loud" })).toThrow();
  });

  test("apprise: http(s) url → embed url + Link field, id field kept", async () => {
    const n = await adapters.apprise!.parse({ title: "Deploy", message: "done", type: "success", id: "r1", url: "https://deployer.example.internal/requests/7" });
    expect(n.url).toBe("https://deployer.example.internal/requests/7");
    expect(n.fields).toEqual([
      { name: "id", value: "r1", inline: true },
      { name: "Link", value: "https://deployer.example.internal/requests/7" },
    ]);
    const noId = await adapters.apprise!.parse({ title: "Deploy", message: "done", url: "http://deployer.example.internal/" });
    expect(noId.url).toBe("http://deployer.example.internal/");
    expect(noId.fields).toEqual([{ name: "Link", value: "http://deployer.example.internal/" }]);
  });

  test("apprise: no url → unchanged shape", async () => {
    const n = await adapters.apprise!.parse({ title: "Disk", message: "95% full", type: "warning" });
    expect(n.url).toBeUndefined();
    expect(n.fields).toBeUndefined();
    const withId = await adapters.apprise!.parse({ title: "Disk", message: "95% full", id: "abc" });
    expect(withId.url).toBeUndefined();
    expect(withId.fields).toEqual([{ name: "id", value: "abc", inline: true }]);
  });

  test("apprise: non-http or unparseable url is ignored, ingest still succeeds", async () => {
    for (const url of ["ftp://files.example.internal/x", "deployer/requests/7", "javascript:alert(1)", "https://bad url", ""]) {
      const n = await adapters.apprise!.parse({ title: "Disk", message: "95% full", id: "abc", url });
      expect(n.url).toBeUndefined();
      expect(n.fields).toEqual([{ name: "id", value: "abc", inline: true }]);
    }
  });

  test("dagu: lenient fallback, title from name, level from status, scalars become fields", async () => {
    await freshStore();
    const n = await adapters.dagu!.parse({ dag_name: "cryer-purge", status: "failed", duration: "3s", nested: { a: 1 }, message: "exit 1" });
    expect(n).toMatchObject({ source: "dagu", level: "failure", title: "cryer-purge: failed", body: "exit 1" });
    expect(n.actions).toBeUndefined();
    expect(n.fields).toEqual([
      { name: "status", value: "failed", inline: true },
      { name: "duration", value: "3s", inline: true },
    ]);
    expect((await adapters.dagu!.parse({ name: "x", status: "succeeded" })).level).toBe("success");
    expect((await adapters.dagu!.parse({ name: "x", status: "running" })).level).toBe("warning");
    expect((await adapters.dagu!.parse({})).title).toBe("dagu");
    expect(levelFromStatus("ABORTED")).toBe("failure");
    expect(levelFromStatus("partially_succeeded")).toBe("success");
    expect(levelFromStatus("rejected")).toBe("failure");
  });

  test("POST /ingest/:source posts and 404s on unknown sources", async () => {
    await freshStore();
    const d = fakeDiscord();
    const app = createApp();
    const ok = await app.fetch(authed("http://x/ingest/apprise", { method: "POST", body: JSON.stringify({ title: "hi", message: "m", type: "success" }) }));
    expect(ok.status).toBe(201);
    expect(d.posts).toHaveLength(1);
    const linked = await app.fetch(
      authed("http://x/ingest/apprise", { method: "POST", body: JSON.stringify({ title: "hi", message: "m", url: "https://deployer.example.internal/requests/7" }) }),
    );
    expect(linked.status).toBe(201);
    const embed = (d.posts[1]!.payload as { embeds: { url?: string; fields?: { name: string; value: string; inline?: boolean }[] }[] }).embeds[0]!;
    expect(embed.url).toBe("https://deployer.example.internal/requests/7");
    expect(embed.fields).toEqual([{ name: "Link", value: "https://deployer.example.internal/requests/7", inline: false }]);
    const bad = await app.fetch(authed("http://x/ingest/slack", { method: "POST", body: "{}" }));
    expect(bad.status).toBe(404);
    const j = (await bad.json()) as { kind: string; message: string };
    expect(j.kind).toBe("validation");
    expect(j.message).toContain("apprise");
  });
});

describe("dagu adapter v2 (bodyTemplate payload)", () => {
  const failed = {
    source: "dagu",
    dag: "cryer-purge",
    status: "failed",
    error: "step purge: exit status 1",
    run_id: "20261011T0300-abcd",
    link: "https://dagu.example.internal/dag-runs/cryer-purge/20261011T0300-abcd",
    event: "dag.run.failed",
    failed_steps: "purge",
    started_at: "2026-10-11T03:00:00Z",
    finished_at: "2026-10-11T03:00:03Z",
    message: "**cryer-purge** — failed",
  };

  test("failed run → failure embed with dag in the title, error as body, link, and a Retry action", async () => {
    await freshStore();
    await settings.set("dagu_url", "https://dagu.example.internal");
    const n = await adapters.dagu!.parse(failed);
    expect(n).toMatchObject({ source: "dagu", level: "failure", title: "cryer-purge: failed", body: failed.error, url: failed.link });
    expect(n.fields).toEqual([
      { name: "Failed steps", value: "purge" },
      { name: "Run", value: failed.run_id, inline: true },
      { name: "Finished", value: failed.finished_at, inline: true },
      { name: "Link", value: failed.link },
    ]);
    expect(n.actions).toHaveLength(1);
    const retry = n.actions![0]!;
    expect(retry).toMatchObject({ id: RETRY_ACTION_ID, label: RETRY_ACTION_LABEL, style: "danger" });
    expect(retry.callback).toEqual({
      kind: "http",
      method: "POST",
      url: "https://dagu.example.internal/api/v1/dag-runs/cryer-purge/20261011T0300-abcd/retry",
      body: { dagRunId: failed.run_id },
    });
  });

  test("no Retry action while dagu_url is empty (the default); the notification still posts", async () => {
    await freshStore();
    expect(await settings.get("dagu_url")).toBe("");
    const n = await adapters.dagu!.parse(failed);
    expect(n).toMatchObject({ source: "dagu", level: "failure", title: "cryer-purge: failed", body: failed.error, url: failed.link });
    expect(n.actions).toBeUndefined();
    const d = fakeDiscord();
    const res = await createApp().fetch(authed("http://x/ingest/dagu", { method: "POST", body: JSON.stringify(failed) }));
    expect(res.status).toBe(201);
    expect(d.posts).toHaveLength(1);
    expect((d.posts[0]!.payload as { components?: unknown[] }).components ?? []).toHaveLength(0);
  });

  test("retry url honours the dagu_url setting and escapes path parts", async () => {
    await freshStore();
    await settings.set("dagu_url", "http://dagu.test:8080/");
    const n = await adapters.dagu!.parse({ dag: "a/b", status: "aborted", run_id: "r 1" });
    expect(n.actions![0]!.callback).toMatchObject({ url: "http://dagu.test:8080/api/v1/dag-runs/a%2Fb/r%201/retry" });
    expect(retryUrl("https://d/", "x", "y")).toBe("https://d/api/v1/dag-runs/x/y/retry");
  });

  test("no Retry without run_id or on non-retryable statuses; empty template values are dropped", async () => {
    await freshStore();
    const noRun = await adapters.dagu!.parse({ dag: "x", status: "failed", error: "", run_id: "", link: "" });
    expect(noRun.actions).toBeUndefined();
    expect(noRun.body).toBeUndefined();
    expect(noRun.fields).toBeUndefined();
    expect(noRun.url).toBeUndefined();
    const ok = await adapters.dagu!.parse({ dag: "x", status: "succeeded", run_id: "r1" });
    expect(ok.level).toBe("success");
    expect(ok.actions).toBeUndefined();
    const rejected = await adapters.dagu!.parse({ dag: "x", status: "rejected", run_id: "r1" });
    expect(rejected.level).toBe("failure");
    expect(rejected.actions).toBeUndefined();
    // message is used as the body only when there is no error
    const msgOnly = await adapters.dagu!.parse({ dag: "x", status: "failed", message: "hello" });
    expect(msgOnly.body).toBe("hello");
  });

  test("POST /ingest/dagu with the v2 payload posts an embed with a button and creates a prompt", async () => {
    await freshStore();
    await settings.set("dagu_url", "https://dagu.example.internal");
    await settings.set("callback_allowlist", "*.example.internal");
    const d = fakeDiscord();
    const app = createApp();
    const res = await app.fetch(authed("http://x/ingest/dagu", { method: "POST", body: JSON.stringify(failed) }));
    expect(res.status).toBe(201);
    const j = (await res.json()) as { prompt_id?: string };
    expect(j.prompt_id).toBeString();
    expect(d.posts).toHaveLength(1);
    const payload = d.posts[0]!.payload as { embeds: { title: string }[]; components: unknown[] };
    expect(payload.embeds[0]!.title).toBe("cryer-purge: failed");
    expect(payload.components).toHaveLength(1);
  });
});

describe("ingest ?token= auth", () => {
  const body = JSON.stringify({ title: "hi", message: "m", type: "info" });
  const post = (url: string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  test("accepts the right token on /ingest/*, rejects wrong/missing", async () => {
    await freshStore();
    const d = fakeDiscord();
    const app = createApp();
    expect((await app.fetch(post(`http://x/ingest/apprise?token=${TEST_TOKEN}`))).status).toBe(201);
    expect(d.posts).toHaveLength(1);
    expect((await app.fetch(post("http://x/ingest/apprise?token=wrong"))).status).toBe(401);
    expect((await app.fetch(post("http://x/ingest/apprise?token="))).status).toBe(401);
    expect((await app.fetch(post("http://x/ingest/apprise"))).status).toBe(401);
    // header still works on ingest
    expect((await app.fetch(post("http://x/ingest/apprise", { authorization: `Bearer ${TEST_TOKEN}` }))).status).toBe(201);
  });

  test("query token is NOT accepted outside /ingest/*", async () => {
    await freshStore();
    fakeDiscord();
    const app = createApp();
    for (const path of ["/notify", "/prompts", "/purge"]) {
      const res = await app.fetch(new Request(`http://x${path}?token=${TEST_TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      expect(res.status).toBe(401);
    }
    const get = await app.fetch(new Request(`http://x/settings?token=${TEST_TOKEN}`));
    expect(get.status).toBe(401);
  });

  test("the token never reaches stdout (request log, 401, 404, bad body)", async () => {
    await freshStore();
    fakeDiscord();
    const { setLevel } = await import("../src/lib/log.ts");
    const chunks: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    setLevel("debug");
    try {
      const app = createApp();
      await app.fetch(post(`http://x/ingest/apprise?token=${TEST_TOKEN}`));
      await app.fetch(new Request(`http://x/ingest/apprise?token=${TEST_TOKEN}`, { method: "POST", body: "not json" }));
      await app.fetch(new Request(`http://x/ingest/nope?token=${TEST_TOKEN}`, { method: "POST", body: "{}" }));
      await app.fetch(new Request(`http://x/nowhere?token=${TEST_TOKEN}`));
      await app.fetch(post(`http://x/notify?token=${TEST_TOKEN}`));
    } finally {
      process.stdout.write = realWrite;
      setLevel(process.env.LOG_LEVEL!);
    }
    const out = chunks.join("");
    expect(out).toContain("/ingest/apprise?token=***");
    expect(out).not.toContain(TEST_TOKEN);
  });
});
