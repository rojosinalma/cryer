import { describe, expect, test } from "bun:test";
import { authed, fakeDiscord, freshStore } from "./setup.ts";
import { createApp } from "../src/app.ts";
import { ASK_DESCRIPTION, INSTRUCTIONS, askArgsSchema, callerSession, notifyArgsSchema, runAsk } from "../src/mcp.ts";

describe("MCP ask", () => {
  test("server instructions stay within three lines; the option shape lives in the ask description", () => {
    const lines = INSTRUCTIONS.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(INSTRUCTIONS).toMatch(/notify/);
    expect(INSTRUCTIONS).toMatch(/mode=callback/);
    for (const term of ["1–25", "modal", "1️⃣..9️⃣", "replying", "choice_id", "via"]) expect(ASK_DESCRIPTION).toContain(term);
  });

  test("arg validation: options 1..25, ids/labels required, mode enum", () => {
    expect(askArgsSchema.safeParse({ title: "t", options: [] }).success).toBe(false);
    expect(askArgsSchema.safeParse({ title: "t", options: [{ id: "a" }] }).success).toBe(false);
    expect(askArgsSchema.safeParse({ title: "t", options: Array.from({ length: 26 }, (_, i) => ({ id: `${i}`, label: "x" })) }).success).toBe(false);
    expect(askArgsSchema.safeParse({ title: "t", options: [{ id: "a", label: "A" }], mode: "later" }).success).toBe(false);
    const ok = askArgsSchema.parse({ title: "t", options: [{ id: "a", label: "A", modal: { title: "m", fields: [{ id: "f", label: "F" }] } }] });
    expect(ok.mode).toBe("wait");
    expect(ok.options[0]!.modal!.fields[0]!.style).toBe("short");
    expect(notifyArgsSchema.parse({ level: "info", title: "t" }).source).toBe("agent");
    expect(notifyArgsSchema.safeParse({ level: "loud", title: "t" }).success).toBe(false);
  });

  test("callerSession reads ai.opencode/sessionID or sessionID from _meta", () => {
    expect(callerSession({ "ai.opencode/sessionID": "ses_a" })).toBe("ses_a");
    expect(callerSession({ sessionID: "ses_b" })).toBe("ses_b");
    expect(callerSession({})).toBeUndefined();
    expect(callerSession(undefined)).toBeUndefined();
  });

  test("mode=callback needs a session; with one it stores it on the prompt and returns at once", async () => {
    await freshStore();
    fakeDiscord();
    const args = askArgsSchema.parse({ title: "t", options: [{ id: "a", label: "A" }], mode: "callback" });
    await expect(runAsk(args, undefined)).rejects.toThrow(/session/);
    const r = await runAsk(args, "ses_1");
    expect(r.status).toBe("pending");
    const { getPrompt } = await import("../src/lib/prompts.ts");
    expect(JSON.parse((await getPrompt(r.id))!.sessionJson!)).toEqual({ id: "ses_1" });
  });

  test("mode=wait returns pending after wait_s", async () => {
    await freshStore();
    fakeDiscord();
    const r = await runAsk(askArgsSchema.parse({ title: "t", options: [{ id: "a", label: "A" }], wait_s: 0 }), undefined);
    expect(r.status).toBe("pending");
    expect(r.url).toContain("discord.com/channels");
  });

  test("/mcp is bearer-protected and lists the tools", async () => {
    await freshStore();
    const app = createApp();
    const anon = await app.fetch(new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(anon.status).toBe(401);
    const res = await app.fetch(
      authed("http://x/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { tools: { name: string; description?: string }[] } };
    expect(json.result.tools.map((t) => t.name).sort()).toEqual(["ask", "cancel", "get", "list", "notify", "wait"]);
    expect(json.result.tools.find((t) => t.name === "ask")!.description).toBe(ASK_DESCRIPTION);
  });

  test("initialize hands the client the three-line instructions", async () => {
    await freshStore();
    const app = createApp();
    const res = await app.fetch(
      authed("http://x/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { instructions: string } };
    expect(json.result.instructions).toBe(INSTRUCTIONS);
  });
});
