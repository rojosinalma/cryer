import { describe, expect, test } from "bun:test";
import { TEST_CHANNEL, authed, fakeDiscord, freshStore } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { answerPrompt, cancelPrompt, createPrompt, getPrompt, notify, purge, sweepExpired, waitForAnswer } from "../src/lib/prompts.ts";
import { settings } from "../src/lib/settings.ts";
import { getDb } from "../src/lib/store.ts";
import { prompts } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";

const options = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No", style: "danger" as const },
];

describe("prompt state machine", () => {
  test("create → pending, posts embed + buttons, url is a message link", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await createPrompt({ title: "Deploy?", source: "agent", level: "info", options });
    expect(r.url).toBe(`https://discord.com/channels/999/${TEST_CHANNEL}/msg1`);
    const p = await getPrompt(r.id);
    expect(p?.status).toBe("pending");
    expect(p?.discordMessageId).toBe("msg1");
    expect(p?.ttlS).toBe(3600);
    const payload = d.posts[0]!.payload as { embeds: unknown[]; components: { components: unknown[] }[] };
    expect(payload.embeds).toHaveLength(1);
    expect(payload.components[0]!.components).toHaveLength(2);
  });

  test("first writer wins; the second click sees 'answered'", async () => {
    await freshStore();
    fakeDiscord();
    const r = await createPrompt({ title: "Deploy?", source: "agent", level: "info", options });
    const [a, b] = await Promise.all([
      answerPrompt(r.id, { idx: 0, userId: "u1", userName: "alice" }),
      answerPrompt(r.id, { idx: 1, userId: "u2", userName: "other" }),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.ok)!;
    expect(loser.ok ? null : loser.status).toBe("answered");
    const p = await getPrompt(r.id);
    expect(p?.status).toBe("answered");
    expect(p?.answeredAt).toBeTruthy();
    const w = await waitForAnswer(r.id, 1);
    expect(w.status).toBe("answered");
    expect(w.answer?.choice_id).toMatch(/yes|no/);
  });

  test("unknown option and missing prompt are reported", async () => {
    await freshStore();
    fakeDiscord();
    const r = await createPrompt({ title: "x", source: "agent", level: "info", options });
    expect(await answerPrompt(r.id, { idx: 5, userId: "u", userName: "n" })).toEqual({ ok: false, status: "unknown-option" });
    expect(await answerPrompt("nope", { idx: 0, userId: "u", userName: "n" })).toEqual({ ok: false, status: "missing" });
  });

  test("sweeper expires overdue prompts once and edits the message with disabled buttons", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await createPrompt({ title: "x", source: "agent", level: "info", options, ttl_s: 1 });
    expect(await sweepExpired()).toBe(0);
    await getDb().update(prompts).set({ expiresAt: "2000-01-01T00:00:00.000Z" }).where(eq(prompts.id, r.id));
    expect(await sweepExpired()).toBe(1);
    expect(await sweepExpired()).toBe(0);
    expect((await getPrompt(r.id))?.status).toBe("expired");
    const edit = d.edits[0]!.payload as { embeds: { fields: { value: string }[] }[]; components: { components: { disabled: boolean }[] }[] };
    expect(edit.embeds[0]!.fields.at(-1)!.value).toContain("expired");
    expect(edit.components[0]!.components.every((c) => c.disabled)).toBe(true);
    expect(await answerPrompt(r.id, { idx: 0, userId: "u", userName: "n" })).toEqual({ ok: false, status: "expired" });
  });

  test("cancel marks expired and refuses twice", async () => {
    await freshStore();
    fakeDiscord();
    const r = await createPrompt({ title: "x", source: "agent", level: "info", options });
    expect((await cancelPrompt(r.id)).status).toBe("expired");
    await expect(cancelPrompt(r.id)).rejects.toThrow(/already expired/);
  });

  test("wait returns pending at timeout and answered once a click lands (store polling)", async () => {
    await freshStore();
    fakeDiscord();
    const r = await createPrompt({ title: "x", source: "agent", level: "info", options });
    expect((await waitForAnswer(r.id, 0)).status).toBe("pending");
    const waiting = waitForAnswer(r.id, 5);
    setTimeout(() => void answerPrompt(r.id, { idx: 1, userId: "u", userName: "alice" }), 30);
    const w = await waiting;
    expect(w.status).toBe("answered");
    expect(w.answer).toMatchObject({ choice_id: "no", choice_idx: 1, user_name: "alice" });
  });

  test("discord failure marks the prompt failed", async () => {
    await freshStore();
    const d = fakeDiscord();
    d.failPost = true;
    await expect(createPrompt({ title: "x", source: "agent", level: "info", options })).rejects.toThrow(/discord down/);
    const rows = await getDb().select().from(prompts);
    expect(rows[0]?.status).toBe("failed");
  });
});

describe("notify", () => {
  test("posts an embed, routes by settings, and becomes a prompt when actions are given", async () => {
    await freshStore();
    const d = fakeDiscord();
    await settings.set("route.dagu.failure", "555");
    const plain = await notify({ source: "dagu", type: "generic", level: "failure", title: "boom" });
    expect(plain.channel_id).toBe("555");
    expect(plain.prompt_id).toBeUndefined();
    const withActions = await notify({ source: "dagu", type: "generic", level: "info", title: "retry?", actions: options });
    expect(withActions.channel_id).toBe(TEST_CHANNEL);
    expect(withActions.prompt_id).toBeTruthy();
    expect((await getPrompt(withActions.prompt_id!))?.status).toBe("pending");
    expect(d.posts).toHaveLength(2);
  });
});

describe("purge", () => {
  test("deletes old rows and keeps recent ones", async () => {
    await freshStore();
    fakeDiscord();
    const r = await createPrompt({ title: "old", source: "agent", level: "info", options });
    await answerPrompt(r.id, { idx: 0, userId: "u", userName: "n" });
    await createPrompt({ title: "new", source: "agent", level: "info", options });
    await getDb().update(prompts).set({ createdAt: "2000-01-01T00:00:00.000Z" }).where(eq(prompts.id, r.id));
    const counts = await purge(30);
    expect(counts).toEqual({ messages: 0, prompts: 1, answers: 1 });
    expect(await getPrompt(r.id)).toBeUndefined();
  });
});

describe("dm targets", () => {
  test("notify with channel dm:<user> posts into the DM channel; the stored/returned channel_id is the DM channel", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await notify({ source: "s", type: "generic", level: "info", title: "hi", channel: "dm:123" });
    expect(d.dms).toEqual(["123"]);
    expect(r.channel_id).toBe("dm-123");
    expect(d.posts[0]!.channelId).toBe("dm-123");
    const second = await notify({ source: "s", type: "generic", level: "info", title: "again", channel: "dm:123" });
    expect(second.channel_id).toBe("dm-123");
    expect(d.dms).toEqual(["123"]);
  });

  test("createPrompt routed to a DM via default_channel stores the DM channel id", async () => {
    await freshStore();
    const d = fakeDiscord();
    await settings.set("default_channel", "dm:42");
    const r = await createPrompt({ title: "Deploy?", source: "agent", level: "info", options });
    expect(r.channel_id).toBe("dm-42");
    expect((await getPrompt(r.id))?.channelId).toBe("dm-42");
    expect(d.posts[0]!.channelId).toBe("dm-42");
  });

  test("POST /notify accepts channel dm:<user>; a refused DM is a 502 with the reason", async () => {
    await freshStore();
    const d = fakeDiscord();
    const app = createApp();
    const body = (channel: string) => JSON.stringify({ source: "s", level: "info", title: "t", channel });
    const ok = await app.fetch(authed("http://x/notify", { method: "POST", body: body("dm:123") }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ ok: true, channel_id: "dm-123", message_id: "msg1" });

    const bad = await app.fetch(authed("http://x/notify", { method: "POST", body: body("dm:abc") }));
    expect(bad.status).toBe(400);

    d.refuseDm = 50278;
    const refused = await app.fetch(authed("http://x/notify", { method: "POST", body: body("dm:777") }));
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({
      ok: false,
      kind: "system",
      message: expect.stringMatching(/refuses DMs to user 777 \(code 50278\)/),
    });
    expect(d.posts).toHaveLength(1);
  });
});
