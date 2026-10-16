import { describe, expect, test } from "bun:test";
import { TEST_CHANNEL, authed, fakeDiscord, freshStore } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { answerPrompt } from "../src/lib/prompts.ts";

describe("HTTP API", () => {
  test("/health is open; everything else fails closed without a bearer", async () => {
    await freshStore();
    const app = createApp();
    const h = await app.fetch(new Request("http://x/health"));
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ ok: true, store: "sqlite", app_id: "222222222222222222" });
    for (const path of ["/notify", "/prompts", "/settings", "/purge", "/ingest/apprise"]) {
      const res = await app.fetch(new Request(`http://x${path}`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" }));
      expect(res.status).toBe(401);
    }
  });

  test("POST /notify validates and posts; bad level is a validation error", async () => {
    await freshStore();
    const d = fakeDiscord();
    const app = createApp();
    const bad = await app.fetch(authed("http://x/notify", { method: "POST", body: JSON.stringify({ source: "s", level: "loud", title: "t" }) }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, kind: "validation" });
    const ok = await app.fetch(authed("http://x/notify", { method: "POST", body: JSON.stringify({ source: "s", level: "success", title: "t", fields: [{ name: "a", value: "b" }] }) }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ ok: true, channel_id: TEST_CHANNEL, message_id: "msg1" });
    expect(d.posts).toHaveLength(1);
  });

  test("prompts: create, get, wait (answer lands while waiting), list, cancel", async () => {
    await freshStore();
    fakeDiscord();
    const app = createApp();
    const created = await app.fetch(authed("http://x/prompts", { method: "POST", body: JSON.stringify({ title: "Go?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }) }));
    expect(created.status).toBe(201);
    const { id, url } = (await created.json()) as { id: string; url: string };
    expect(url).toContain(`/${TEST_CHANNEL}/msg1`);

    const got = (await (await app.fetch(authed(`http://x/prompts/${id}`))).json()) as { prompt: { status: string } };
    expect(got.prompt.status).toBe("pending");

    setTimeout(() => void answerPrompt(id, { idx: 0, userId: "1", userName: "alice" }), 30);
    const waited = (await (await app.fetch(authed(`http://x/prompts/${id}/wait?timeout=5`))).json()) as { status: string; answer: { choice_id: string } };
    expect(waited.status).toBe("answered");
    expect(waited.answer.choice_id).toBe("y");

    const list = (await (await app.fetch(authed("http://x/prompts?status=answered"))).json()) as { prompts: unknown[] };
    expect(list.prompts).toHaveLength(1);

    const cancel = await app.fetch(authed(`http://x/prompts/${id}/cancel`, { method: "POST" }));
    expect(cancel.status).toBe(409);
    const missing = await app.fetch(authed("http://x/prompts/nope"));
    expect(missing.status).toBe(404);
    const tooMany = await app.fetch(authed("http://x/prompts", { method: "POST", body: JSON.stringify({ title: "x", options: Array.from({ length: 26 }, (_, i) => ({ id: `${i}`, label: "l" })) }) }));
    expect(tooMany.status).toBe(400);
  });

  test("settings GET/PUT and purge", async () => {
    await freshStore();
    const app = createApp();
    const put = await app.fetch(authed("http://x/settings/route.dagu.failure", { method: "PUT", body: JSON.stringify({ value: "123" }) }));
    expect(put.status).toBe(200);
    const get = (await (await app.fetch(authed("http://x/settings/route.dagu.failure"))).json()) as { value: string };
    expect(get.value).toBe("123");
    const all = (await (await app.fetch(authed("http://x/settings"))).json()) as { settings: Record<string, string> };
    expect(all.settings.purge_days).toBe("30");
    const purge = (await (await app.fetch(authed("http://x/purge", { method: "POST" }))).json()) as { ok: boolean; days: number };
    expect(purge).toMatchObject({ ok: true, days: 30, messages: 0, prompts: 0, answers: 0 });
  });
});
