import { afterEach, describe, expect, mock, test } from "bun:test";
import { fakeDiscord, freshStore } from "./setup.ts";
import { hostAllowed, parseAllowlist, urlAllowed } from "../src/lib/callbacks/allowlist.ts";
import { callbacks, deliverCallback, validateCallback } from "../src/lib/callbacks/index.ts";
import { answerText, buildRequest } from "../src/lib/callbacks/opencode-session.ts";
import { answerPrompt, createPrompt, outcomeLine, OUTCOME_REASON_MAX } from "../src/lib/prompts.ts";
import { queue } from "../src/lib/queue.ts";
import { DEFAULTS, settings } from "../src/lib/settings.ts";

const ctx = {
  promptId: "p1",
  title: "Deploy?",
  label: "Go",
  answer: { choice_id: "go", choice_idx: 0, text: null, user_id: "42", user_name: "alice", at: "2026-10-11T00:00:00.000Z", via: "button" as const },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("callback registry", () => {
  test("has http and opencode-session", () => {
    expect(Object.keys(callbacks).sort()).toEqual(["http", "opencode-session"]);
  });
});

describe("http callback allowlist", () => {
  test("default allows private networks and loopback only", () => {
    const def = parseAllowlist(DEFAULTS.callback_allowlist);
    for (const h of ["127.0.0.1", "localhost", "10.1.2.3", "172.20.0.5", "192.168.1.9"]) expect(hostAllowed(h, def)).toBe(true);
    for (const h of ["8.8.8.8", "172.32.0.1", "example.com", "jobs.example.internal"]) expect(hostAllowed(h, def)).toBe(false);
  });

  const allow = parseAllowlist("192.168.1.0/24, *.example.internal,*.example.test, jobs.example.org");

  test("CIDR, glob and exact host matching", () => {
    expect(hostAllowed("192.168.1.20", allow)).toBe(true);
    expect(hostAllowed("192.168.2.20", allow)).toBe(false);
    expect(hostAllowed("hooks.example.internal", allow)).toBe(true);
    expect(hostAllowed("a.b.example.internal", allow)).toBe(false);
    expect(hostAllowed("example.internal", allow)).toBe(false);
    expect(hostAllowed("jobs.example.org", allow)).toBe(true);
    expect(hostAllowed("evil.com", allow)).toBe(false);
  });

  test("urlAllowed needs http(s) and an allowed host", () => {
    expect(urlAllowed("https://hooks.example.internal/api/x", allow)).toBe(true);
    expect(urlAllowed("http://192.168.1.50:8080/hook", allow)).toBe(true);
    expect(urlAllowed("ftp://hooks.example.internal/", allow)).toBe(false);
    expect(urlAllowed("https://example.com/", allow)).toBe(false);
    expect(urlAllowed("not a url", allow)).toBe(false);
  });

  test("prompt creation refuses a callback outside the allowlist (validation error)", async () => {
    await freshStore();
    await settings.set("callback_allowlist", "*.example.internal");
    fakeDiscord();
    await expect(
      createPrompt({ title: "x", source: "agent", level: "info", options: [{ id: "a", label: "A" }], callback: { kind: "http", url: "https://example.com/hook", method: "POST" } }),
    ).rejects.toThrow(/callback_allowlist/);
    await expect(validateCallback({ kind: "http", url: "https://hooks.example.internal/hook", method: "POST" })).resolves.toBeUndefined();
  });

  test("delivers the answer JSON, retrying on failure", async () => {
    await freshStore();
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response("", { status: ++n < 2 ? 500 : 200 });
    }) as unknown as typeof fetch;
    await deliverCallback({ kind: "http", url: "https://hooks.example.internal/hook", method: "PUT", headers: { "x-k": "v" }, body: { extra: 1 } }, ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>)["x-k"]).toBe("v");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ prompt_id: "p1", title: "Deploy?", choice_id: "go", user_name: "alice", extra: 1 });
  });
});

describe("opencode-session callback", () => {
  test("prompt mode: POST /api/session/:id/prompt with Basic auth and delivery=queue", () => {
    const req = buildRequest({ kind: "opencode-session", session_id: "ses_abc", directory: "/x/y" }, "prompt", ctx);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://opencode.test:4096/api/session/ses_abc/prompt?directory=%2Fx%2Fy");
    expect(req.headers.authorization).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"));
    expect(req.body).toEqual({ text: answerText(ctx), delivery: "queue" });
    expect(answerText(ctx)).toBe('cryer: answer to "Deploy?": Go by alice at 2026-10-11T00:00:00.000Z');
    expect(answerText({ ...ctx, answer: { ...ctx.answer, text: "hi" } })).toContain("Go (hi) by alice");
  });

  test("instruction mode: PUT instructions/entries/cryer with the last answers", () => {
    const req = buildRequest({ kind: "opencode-session", session_id: "ses_x" }, "instruction", ctx);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("http://opencode.test:4096/api/experimental/session/ses_x/instructions/entries/cryer");
    const body = req.body as { value: { note: string; answers: unknown[] } };
    expect(body.value.note).toBe(answerText(ctx));
    expect(body.value.answers).toHaveLength(1);
    expect(body.value.answers[0]).toMatchObject({ prompt_id: "p1", label: "Go" });
  });

  test("an answered prompt with a session enqueues the callback and hits opencode (mock fetch)", async () => {
    await freshStore();
    fakeDiscord();
    await settings.set("session_callback_mode", "prompt");
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createPrompt({ title: "Deploy?", source: "agent", level: "info", options: [{ id: "go", label: "Go" }], session: { id: "ses_1" } });
    await answerPrompt(r.id, { idx: 0, userId: "42", userName: "alice" });
    await queue.idle();
    expect(calls).toEqual(["http://opencode.test:4096/api/session/ses_1/prompt"]);
  });
});

describe("callback outcome is edited into the Discord message", () => {
  const retryOption = {
    id: "retry",
    label: "Retry run",
    callback: { kind: "http" as const, url: "https://dagu.example.internal/api/v1/dag-runs/x/r1/retry", method: "POST" as const, body: { dagRunId: "r1" } },
  };
  type Edit = { payload: { embeds: { footer?: { text: string }; fields?: { name: string }[] }[]; components: unknown[] } };

  test("success → footer gets '⚙ Retry run: ✓ ok' after the queue task finishes", async () => {
    await freshStore();
    await settings.set("callback_allowlist", "*.example.internal");
    const d = fakeDiscord();
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createPrompt({ title: "cryer-purge: failed", source: "dagu", level: "failure", options: [retryOption] });
    await answerPrompt(r.id, { idx: 0, userId: "42", userName: "alice" });
    await queue.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(retryOption.callback.url);
    expect(calls[0]!.body).toMatchObject({ dagRunId: "r1", prompt_id: r.id, choice_id: "retry" });
    expect(d.edits).toHaveLength(1);
    const edit = d.edits[0] as unknown as Edit;
    const embed = edit.payload.embeds[0]!;
    expect(embed.footer!.text).toBe("dagu · failure\n⚙ Retry run: ✓ ok");
    expect(embed.fields!.map((f) => f.name)).toContain("Answer");
    expect(edit.payload.components).toHaveLength(1); // buttons present (disabled)
  });

  test("failure → footer gets '⚙ Retry run: ✗ <reason>' and the error still reaches the log", async () => {
    await freshStore();
    await settings.set("callback_allowlist", "*.example.internal");
    const d = fakeDiscord();
    globalThis.fetch = mock(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const r = await createPrompt({ title: "cryer-purge: failed", source: "dagu", level: "failure", options: [retryOption] });
    await answerPrompt(r.id, { idx: 0, userId: "42", userName: "alice" });
    await queue.idle();
    expect(d.edits).toHaveLength(1);
    const text = (d.edits[0] as unknown as Edit).payload.embeds[0]!.footer!.text;
    expect(text).toContain("⚙ Retry run: ✗ ");
    expect(text).toContain("HTTP 404");
    expect(text.split("\n")).toHaveLength(2);
  });

  test("two callbacks on one answer → two lines, kind-suffixed, accumulated across edits", async () => {
    await freshStore();
    await settings.set("callback_allowlist", "*.example.internal");
    const d = fakeDiscord();
    await settings.set("session_callback_mode", "prompt");
    globalThis.fetch = mock(async (url: string | URL | Request) => new Response("", { status: String(url).includes("opencode") ? 500 : 200 })) as unknown as typeof fetch;
    const r = await createPrompt({ title: "t", source: "agent", level: "info", options: [retryOption], session: { id: "ses_1" } });
    await answerPrompt(r.id, { idx: 0, userId: "42", userName: "alice" });
    await queue.idle();
    expect(d.edits).toHaveLength(2);
    const last = (d.edits[1] as unknown as Edit).payload.embeds[0]!.footer!.text.split("\n");
    expect(last).toHaveLength(3);
    expect(last).toContain("⚙ Retry run (http): ✓ ok");
    expect(last.some((l) => l.startsWith("⚙ Retry run (opencode-session): ✗ "))).toBe(true);
  });

  test("outcomeLine shortens and flattens reasons", () => {
    expect(outcomeLine("Go", true)).toBe("⚙ Go: ✓ ok");
    expect(outcomeLine("Go", false, "a\n  b   c")).toBe("⚙ Go: ✗ a b c");
    expect(outcomeLine("Go", false, "x".repeat(500)).length).toBe("⚙ Go: ✗ ".length + OUTCOME_REASON_MAX);
    expect(outcomeLine("Go", false)).toBe("⚙ Go: ✗ failed");
  });
});
