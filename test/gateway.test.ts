import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { TEST_CHANNEL, authed, fakeDiscord, freshStore } from "./setup.ts";
import { GatewayCloseCodes, GatewayIntentBits } from "discord-api-types/v10";
import { createApp } from "../src/app.ts";
import { queue } from "../src/lib/queue.ts";
import { answerPrompt, createPrompt, getAnswer, getPrompt, NUMBER_EMOJI, notify, waitForAnswer } from "../src/lib/prompts.ts";
import { readLease } from "../src/lib/lease.ts";
import {
  BASE_INTENTS,
  CONTENT_INTENT,
  Gateway,
  gatewayHealth,
  handleReaction,
  handleReply,
  matchReply,
  REACT_LATE,
  REACT_OK,
  startGateway,
  stopGateway,
  type GatewayClient,
} from "../src/lib/transports/gateway.ts";

const options = [
  { id: "yes", label: "Deploy now" },
  { id: "no", label: "Skip" },
  { id: "later", label: "Later tonight" },
  { id: "other", label: "Other…", modal: { title: "Say more", fields: [{ id: "t", label: "Text", style: "short" as const }] } },
];

const alice = { id: "42", bot: false, name: "alice" };
const bot = { id: "7", bot: true, name: "cryer" };

async function pendingPrompt(extra: Record<string, unknown> = {}) {
  const r = await createPrompt({ title: "Deploy?", source: "agent", level: "info", options, ...extra });
  await queue.idle();
  return r;
}

// ---------- fake discord.js client ----------

class FakeClient extends EventEmitter implements GatewayClient {
  user: { id: string; tag: string } | null = null;
  destroyed = false;
  constructor(
    readonly intents: number,
    private readonly allowContent: boolean,
    private readonly behaviour: "ready" | "silent" | "throw" = "ready",
  ) {
    super();
  }
  async login() {
    if (this.behaviour === "throw") throw new Error("invalid token");
    if (this.behaviour === "silent") return "t";
    queueMicrotask(() => {
      if (this.intents & CONTENT_INTENT && !this.allowContent) {
        this.emit("shardDisconnect", { code: GatewayCloseCodes.DisallowedIntents }, 0);
        return;
      }
      this.user = { id: bot.id, tag: "cryer#0" };
      this.emit("clientReady");
    });
    return "t";
  }
  async destroy() {
    this.destroyed = true;
  }
}

function fakeFactory(allowContent: boolean, behaviour: "ready" | "silent" | "throw" = "ready") {
  const made: FakeClient[] = [];
  const factory = (intents: number) => {
    const c = new FakeClient(intents, allowContent, behaviour);
    made.push(c);
    return c;
  };
  return { factory, made };
}

const quick = { ttlS: 1, renewS: 0.02 };
const cfg = (enabled = true) => async () => ({ enabled, ...quick });
const until = async (pred: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(pred()).toBe(true);
};

afterEach(async () => {
  await stopGateway();
});

// ---------- reactions on create ----------

describe("number reactions on prompt creation", () => {
  test("createPrompt adds 1️⃣..n via REST for non-modal options; notify with actions too; reactions:false opts out", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await pendingPrompt();
    expect(d.reactions.map((x) => x.emoji)).toEqual([NUMBER_EMOJI[0], NUMBER_EMOJI[1], NUMBER_EMOJI[2]]); // option 4 has a modal
    expect(d.reactions[0]).toMatchObject({ channelId: TEST_CHANNEL, messageId: r.message_id });

    d.reactions.length = 0;
    await notify({ source: "dagu", type: "generic", level: "failure", title: "boom", actions: [{ id: "retry", label: "Retry" }] });
    await queue.idle();
    expect(d.reactions.map((x) => x.emoji)).toEqual([NUMBER_EMOJI[0]]);

    d.reactions.length = 0;
    await pendingPrompt({ reactions: false });
    await notify({ source: "dagu", type: "generic", level: "failure", title: "boom", actions: [{ id: "retry", label: "Retry" }], reactions: false });
    await queue.idle();
    expect(d.reactions).toHaveLength(0);
  });

  test("more than nine options: only the first nine get a reaction", async () => {
    await freshStore();
    const d = fakeDiscord();
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    await createPrompt({ title: "pick", source: "agent", level: "info", options: many });
    await queue.idle();
    expect(d.reactions).toHaveLength(9);
  });
});

// ---------- reaction answers ----------

describe("reaction answers", () => {
  test("happy path: 2️⃣ by a human answers option 1 via reaction, edits the message", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await pendingPrompt();
    expect(await handleReaction({ messageId: r.message_id, channelId: TEST_CHANNEL, emoji: "2️⃣", user: alice })).toBe("answered");
    const a = await getAnswer(r.id);
    expect(a).toMatchObject({ choice_id: "no", choice_idx: 1, text: null, via: "reaction", user_name: "alice" });
    expect((await getPrompt(r.id))?.status).toBe("answered");
    const edit = d.edits.at(-1)!.payload as { embeds: { fields: { name: string; value: string }[] }[] };
    expect(edit.embeds[0]!.fields.at(-1)!.value).toContain("✅ Skip — alice via reaction at");
  });

  test("a number reaction in a DM answers too", async () => {
    await freshStore();
    fakeDiscord();
    const r = await pendingPrompt();
    expect(await handleReaction({ messageId: r.message_id, channelId: "dm-chan", emoji: "1️⃣", user: alice, isDm: true })).toBe("answered");
    expect(await getAnswer(r.id)).toMatchObject({ choice_id: "yes", via: "reaction" });
  });

  test("variation-selector-less keycap matches too", async () => {
    await freshStore();
    fakeDiscord();
    const r = await pendingPrompt();
    expect(await handleReaction({ messageId: r.message_id, channelId: TEST_CHANNEL, emoji: "3\u20E3", user: alice })).toBe("answered");
    expect((await getAnswer(r.id))?.choice_id).toBe("later");
  });

  test("ignored: bot's own reactions, unknown emoji, unknown message, modal option, non-pending prompt", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await pendingPrompt();
    expect(await handleReaction({ messageId: r.message_id, channelId: TEST_CHANNEL, emoji: "1️⃣", user: bot })).toBe("ignored-bot");
    expect(await handleReaction({ messageId: r.message_id, channelId: TEST_CHANNEL, emoji: "👍", user: alice })).toBe("ignored-emoji");
    expect(await handleReaction({ messageId: "nope", channelId: TEST_CHANNEL, emoji: "1️⃣", user: alice })).toBe("not-prompt");
    expect(await handleReaction({ messageId: r.message_id, channelId: TEST_CHANNEL, emoji: "4️⃣", user: alice })).toBe("ignored-option");
    expect(await handleReaction({ messageId: r.message_id, channelId: TEST_CHANNEL, emoji: "9️⃣", user: alice })).toBe("ignored-option");
    expect((await getPrompt(r.id))?.status).toBe("pending");
    const edits = d.edits.length;
    await answerPrompt(r.id, { idx: 0, userId: "1", userName: "x" });
    expect(await handleReaction({ messageId: r.message_id, channelId: TEST_CHANNEL, emoji: "1️⃣", user: alice })).toBe("not-pending");
    expect(d.edits.length).toBe(edits); // no error, no extra edit for the loser
  });
});

// ---------- reply answers ----------

describe("matchReply", () => {
  test("exact id, exact label (case-insensitive), bare number, unambiguous prefix, ambiguous → null", () => {
    expect(matchReply("no", options)).toBe(1);
    expect(matchReply("  SKIP ", options)).toBe(1);
    expect(matchReply("deploy now", options)).toBe(0);
    expect(matchReply("3", options)).toBe(2);
    expect(matchReply("9", options)).toBeNull();
    expect(matchReply("lat", options)).toBe(2);
    expect(matchReply("dep", options)).toBe(0);
    expect(matchReply("ot", options)).toBe(3); // id and label of the same option both match: still unambiguous
    expect(matchReply("something else entirely", options)).toBeNull();
    expect(matchReply("", options)).toBeNull();
  });

  test("a prefix shared by two options is ambiguous", () => {
    const opts = [
      { id: "restart", label: "Restart" },
      { id: "resume", label: "Resume" },
    ];
    expect(matchReply("res", opts)).toBeNull();
    expect(matchReply("rest", opts)).toBe(0);
  });
});

describe("reply answers", () => {
  const reply = (referenceId: string | null, content: string, author = alice, id = "reply1") => ({
    id,
    channelId: TEST_CHANNEL,
    content,
    referenceId,
    author,
  });

  test("matching reply answers that option with the full text via reply, reacts ✅, edits the prompt", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await pendingPrompt();
    d.reactions.length = 0;
    expect(await handleReply(reply(r.message_id, "Skip"), true)).toBe("answered");
    expect(await getAnswer(r.id)).toMatchObject({ choice_id: "no", choice_idx: 1, text: "Skip", via: "reply" });
    expect(d.reactions).toEqual([{ channelId: TEST_CHANNEL, messageId: "reply1", emoji: REACT_OK }]);
    const edit = d.edits.at(-1)!.payload as { embeds: { fields: { value: string }[] }[]; components: { components: { disabled: boolean }[] }[] };
    expect(edit.embeds[0]!.fields.at(-1)!.value).toContain("✅ Skip — alice via reply at");
    expect(edit.components.flatMap((c) => c.components).every((c) => c.disabled)).toBe(true);
  });

  test("a reply to a modal option carries the text as the modal would have", async () => {
    await freshStore();
    fakeDiscord();
    const r = await pendingPrompt();
    expect(await handleReply(reply(r.message_id, "other"), true)).toBe("answered");
    expect(await getAnswer(r.id)).toMatchObject({ choice_id: "other", text: "other", via: "reply" });
  });

  test("unmatched reply is a free-text answer with null choice, visible through wait and the API", async () => {
    await freshStore();
    fakeDiscord();
    const r = await pendingPrompt();
    expect(await handleReply(reply(r.message_id, "ship it but only after the backup finishes"), true)).toBe("answered-free-text");
    const w = await waitForAnswer(r.id, 1);
    expect(w.status).toBe("answered");
    expect(w.answer).toMatchObject({ choice_id: null, choice_idx: null, text: "ship it but only after the backup finishes", via: "reply" });
    const res = await createApp().fetch(authed(`http://x/prompts/${r.id}`));
    const body = (await res.json()) as { prompt: { answer: { choice_id: null; via: string } } };
    expect(body.prompt.answer).toMatchObject({ choice_id: null, choice_idx: null, via: "reply" });
  });

  test("free-text answer runs the callbacks (opencode-session) with the raw text", async () => {
    await freshStore();
    fakeDiscord();
    const calls: { url: string; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const r = await createPrompt({ title: "Deploy?", source: "agent", level: "info", options, session: { id: "ses_1" } });
      await queue.idle();
      expect(await handleReply(reply(r.message_id, "hold on"), true)).toBe("answered-free-text");
      await queue.idle();
      const call = calls.find((c) => c.url.includes("/api/session/ses_1/prompt"))!;
      expect(call).toBeDefined();
      expect((call.body as { text: string }).text).toBe(
        `cryer: free-text reply to "Deploy?": hold on by alice via reply at ${(await getAnswer(r.id))!.at}`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("ignored: bots, non-replies, replies to unknown messages; late replies get ⏱ once; no content → no-content", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await pendingPrompt();
    d.reactions.length = 0;
    expect(await handleReply(reply(r.message_id, "yes", bot), true)).toBe("ignored-bot");
    expect(await handleReply(reply(null, "yes"), true)).toBe("not-reply");
    expect(await handleReply(reply("unknown", "yes"), true)).toBe("not-prompt");
    expect(await handleReply(reply(r.message_id, "", alice), true)).toBe("no-content");
    expect(await handleReply(reply(r.message_id, "yes", alice), false)).toBe("no-content");
    expect(d.reactions).toHaveLength(0);
    expect((await getPrompt(r.id))?.status).toBe("pending");
    await answerPrompt(r.id, { idx: 0, userId: "1", userName: "x" });
    expect(await handleReply(reply(r.message_id, "no", alice, "late1"), true)).toBe("not-pending");
    expect(d.reactions).toEqual([{ channelId: TEST_CHANNEL, messageId: "late1", emoji: REACT_LATE }]);
  });

  test("DM reply answers without the MessageContent intent; a guild reply still needs it", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await pendingPrompt();
    d.reactions.length = 0;
    expect(await handleReply({ ...reply(r.message_id, "no"), isDm: false }, false)).toBe("no-content");
    expect((await getPrompt(r.id))?.status).toBe("pending");
    expect(await handleReply({ ...reply(r.message_id, "no", alice, "dm1"), channelId: "dm-chan", isDm: true }, false)).toBe("answered");
    expect(await getAnswer(r.id)).toMatchObject({ choice_id: "no", choice_idx: 1, text: "no", via: "reply", user_name: "alice" });
    expect(d.reactions).toEqual([{ channelId: "dm-chan", messageId: "dm1", emoji: REACT_OK }]);

    const r2 = await pendingPrompt();
    expect(await handleReply({ ...reply(r2.message_id, "whatever you think", alice, "dm2"), isDm: true }, false)).toBe("answered-free-text");
    expect(await getAnswer(r2.id)).toMatchObject({ choice_id: null, text: "whatever you think", via: "reply" });
    const r3 = await pendingPrompt();
    expect(await handleReply({ ...reply(r3.message_id, "", alice, "dm3"), isDm: true }, false)).toBe("no-content"); // empty stays empty
  });

  test("race: a reply that loses to a click gets ⏱, not an error", async () => {
    await freshStore();
    const d = fakeDiscord();
    const r = await pendingPrompt();
    d.reactions.length = 0;
    const [a, b] = await Promise.all([answerPrompt(r.id, { idx: 0, userId: "1", userName: "x" }), handleReply(reply(r.message_id, "no"), true)]);
    expect([a.ok ? "answered" : "lost", b]).toContain("lost");
    expect(d.reactions.map((x) => x.emoji)).toEqual([a.ok ? REACT_LATE : REACT_OK]);
  });
});

// ---------- the transport: leadership + client lifecycle ----------

describe("Gateway", () => {
  test("leader connects with MessageContent; follower does not; stop releases and destroys", async () => {
    await freshStore();
    fakeDiscord();
    const a = fakeFactory(true);
    const b = fakeFactory(true);
    const ga = new Gateway({ factory: a.factory, token: "t", holder: "node-a", config: cfg() });
    const gb = new Gateway({ factory: b.factory, token: "t", holder: "node-b", config: cfg() });
    ga.start();
    await until(() => ga.isConnected);
    gb.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(ga.isLeader).toBe(true);
    expect(ga.replyParsing).toBe(true);
    expect(a.made).toHaveLength(1);
    expect(a.made[0]!.intents).toBe(BASE_INTENTS | CONTENT_INTENT);
    expect(gb.isLeader).toBe(false);
    expect(b.made).toHaveLength(0);
    expect((await readLease("gateway"))?.holder).toBe("node-a");

    await ga.stop();
    expect(a.made[0]!.destroyed).toBe(true);
    expect(ga.isConnected).toBe(false);
    // b picks the released lease up at its next poll and connects.
    await until(() => gb.isLeader && gb.isConnected);
    expect((await readLease("gateway"))?.holder).toBe("node-b");
    await gb.stop();
  });

  test("disallowed MessageContent (4014): reconnects without it, reactions work, reply parsing reported off", async () => {
    await freshStore();
    const d = fakeDiscord();
    const f = fakeFactory(false);
    const g = new Gateway({ factory: f.factory, token: "t", holder: "n1", config: cfg() });
    g.start();
    await until(() => g.isConnected);
    expect(f.made).toHaveLength(2);
    expect(f.made[0]!.intents & CONTENT_INTENT).toBe(CONTENT_INTENT);
    expect(f.made[0]!.destroyed).toBe(true);
    expect(f.made[1]!.intents).toBe(BASE_INTENTS);
    expect(g.isLeader).toBe(true);
    expect(g.replyParsing).toBe(false);

    // Events flow through the fallback client: a reaction answers, a (content-less) reply does not.
    const r = await pendingPrompt();
    f.made[1]!.emit("messageCreate", { id: "m1", channelId: TEST_CHANNEL, guildId: "g1", content: "", reference: { messageId: r.message_id }, author: { id: "42", bot: false, username: "alice" } });
    await new Promise((res) => setTimeout(res, 50));
    expect((await getPrompt(r.id))?.status).toBe("pending");
    expect(g.replyParsingDm).toBe(true);
    f.made[1]!.emit("messageReactionAdd", { message: { id: r.message_id, channelId: TEST_CHANNEL }, emoji: { name: "1️⃣" } }, { id: "42", bot: false, globalName: "alice" });
    await until(() => d.edits.length > 0);
    expect(await getAnswer(r.id)).toMatchObject({ choice_id: "yes", via: "reaction", user_name: "alice" });
    await g.stop();
  });

  test("a client that never becomes ready, or a failing login, drops leadership so the other replica can try", async () => {
    await freshStore();
    fakeDiscord();
    const f = fakeFactory(true, "throw");
    const g = new Gateway({ factory: f.factory, token: "t", holder: "n1", config: cfg() });
    const d = await g.runner.tick();
    expect(g.isLeader).toBe(false);
    expect(d).toBe(40); // one backoff step on renewS=0.02
    expect(await readLease("gateway")).toBeUndefined();
    expect(f.made[0]!.destroyed).toBe(true);
  });

  test("an unrecoverable close after READY abdicates; the lease is released", async () => {
    await freshStore();
    fakeDiscord();
    const f = fakeFactory(true);
    const g = new Gateway({ factory: f.factory, token: "t", holder: "n1", config: cfg() });
    await g.runner.tick();
    expect(g.isLeader).toBe(true);
    f.made[0]!.emit("shardDisconnect", { code: GatewayCloseCodes.AuthenticationFailed }, 0);
    await until(() => !g.isLeader && f.made[0]!.destroyed);
    for (let i = 0; i < 50 && (await readLease("gateway")); i++) await new Promise((r) => setTimeout(r, 5));
    expect(await readLease("gateway")).toBeUndefined();
  });

  test("gateway_enabled=false: nothing connects; /health reports the block without failing", async () => {
    await freshStore();
    fakeDiscord();
    const f = fakeFactory(true);
    const g = startGateway({ factory: f.factory, token: "t", holder: "n1", config: cfg(false) });
    await new Promise((r) => setTimeout(r, 80));
    expect(g.isLeader).toBe(false);
    expect(f.made).toHaveLength(0);
    const res = await createApp().fetch(new Request("http://x/health"));
    const body = (await res.json()) as { ok: boolean; gateway: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.gateway).toEqual({ enabled: true, leader: false, holder: null, connected: false, reply_parsing: false, reply_parsing_dm: false });
  });

  test("/health shows the current holder while the lease is live", async () => {
    await freshStore();
    fakeDiscord();
    const f = fakeFactory(true);
    const g = startGateway({ factory: f.factory, token: "t", holder: "node-a", config: cfg() });
    await until(() => g.isConnected);
    expect(await gatewayHealth()).toEqual({ enabled: true, leader: true, holder: "node-a", connected: true, reply_parsing: true, reply_parsing_dm: true });
  });

  test("intents include DMs; without MessageContent reply_parsing is off but reply_parsing_dm stays on", async () => {
    expect(BASE_INTENTS & GatewayIntentBits.DirectMessages).toBe(GatewayIntentBits.DirectMessages);
    expect(BASE_INTENTS & GatewayIntentBits.DirectMessageReactions).toBe(GatewayIntentBits.DirectMessageReactions);
    await freshStore();
    const d = fakeDiscord();
    const f = fakeFactory(false);
    const g = startGateway({ factory: f.factory, token: "t", holder: "node-a", config: cfg() });
    await until(() => g.isConnected);
    expect(await gatewayHealth()).toEqual({ enabled: true, leader: true, holder: "node-a", connected: true, reply_parsing: false, reply_parsing_dm: true });

    // A DM reply through the fallback client (no guildId) answers even though the content intent is off.
    const r = await pendingPrompt();
    f.made[1]!.emit("messageCreate", { id: "dm1", channelId: "dm-chan", guildId: null, content: "Skip", reference: { messageId: r.message_id }, author: { id: "42", bot: false, username: "alice" } });
    await until(() => d.edits.length > 0);
    expect(await getAnswer(r.id)).toMatchObject({ choice_id: "no", text: "Skip", via: "reply" });
  });
});
