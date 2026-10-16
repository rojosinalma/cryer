// MCP endpoint at /mcp (Streamable HTTP, stateless: one server+transport per request, so either
// replica can answer any call). Bearer auth is applied by the router that mounts it.

import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Hono } from "hono";
import { z } from "zod";
import { PROMPT_STATUSES } from "./db/schema.ts";
import { ValidationError } from "./lib/errors.ts";
import { logger } from "./lib/log.ts";
import { cancelPrompt, createPrompt, listPrompts, notify, promptView, requirePrompt, waitForAnswer } from "./lib/prompts.ts";
import { settings } from "./lib/settings.ts";
import { fieldSchema, LEVELS, optionsSchema, type PromptInput } from "./lib/types.ts";
import { version } from "./version.ts";

const log = logger("mcp");

export const SESSION_META_KEYS = ["ai.opencode/sessionID", "sessionID"] as const;

/** The calling opencode session, when the client put it in the tool call's _meta. */
export function callerSession(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  for (const k of SESSION_META_KEYS) {
    const v = meta[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

// Injected into every client session: keep it to these three lines, the detail lives in the tool descriptions.
export const INSTRUCTIONS = [
  "cryer posts to Discord and asks the user for decisions there.",
  "`notify` = one-way message; `ask` = the user picks an option (mode=wait blocks and returns the answer or {status:pending, id} → `wait`).",
  "ask mode=callback returns at once and the answer is delivered into this session later.",
].join("\n");

export const ASK_DESCRIPTION =
  "Ask the user to pick an option in Discord; wait for the answer or get it delivered later. " +
  "Options: 1–25 of {id, label}; add `modal` to an option to collect free text. " +
  "The user answers with a button, a number reaction (1️⃣..9️⃣) or by replying to the message: a reply matching an option " +
  "id/label picks it, any other reply is a free-text answer (choice_id/choice_idx null, `text` = the reply); " +
  "`via` says how it arrived (button|modal|reaction|reply).";

export const notifyArgs = {
  source: z.string().min(1).max(64).default("agent").describe("Who sends it (used for routing)"),
  level: z.enum(LEVELS),
  title: z.string().min(1).max(256),
  body: z.string().max(4000).optional(),
  fields: z.array(fieldSchema).max(25).optional(),
  channel: z.string().regex(/^\d+$/).optional().describe("Channel id override"),
};

export const askArgs = {
  title: z.string().min(1).max(256),
  body: z.string().max(4000).optional(),
  options: optionsSchema,
  ttl_s: z.number().int().positive().optional(),
  channel: z.string().regex(/^\d+$/).optional(),
  mode: z.enum(["wait", "callback"]).default("wait"),
  wait_s: z.number().int().min(0).optional().describe("Seconds to block in wait mode (capped by ask_wait_max_s)"),
  reactions: z.boolean().optional().describe("false: no number reactions on the message (reaction answers off)"),
  session: z
    .object({ id: z.string().min(1), directory: z.string().optional(), mode: z.enum(["prompt", "instruction"]).optional() })
    .optional()
    .describe("Override the session that receives the answer; normally detected from the request"),
};

export const notifyArgsSchema = z.object(notifyArgs);
export const askArgsSchema = z.object(askArgs);

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const failure = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

export async function runAsk(args: z.infer<typeof askArgsSchema>, sessionId: string | undefined) {
  const session = args.session ?? (sessionId ? { id: sessionId } : undefined);
  const input: PromptInput = {
    title: args.title,
    body: args.body,
    source: "agent",
    level: "info",
    options: args.options,
    ttl_s: args.ttl_s,
    channel: args.channel,
    session: args.mode === "callback" ? session : undefined,
    mode: args.mode,
    reactions: args.reactions,
  };
  if (args.mode === "callback" && !session) {
    throw new ValidationError("mode=callback needs a session (none detected in the request; pass `session`)");
  }
  const created = await createPrompt(input);
  if (args.mode === "callback") return { id: created.id, url: created.url, status: "pending" as const };
  const cap = await settings.getInt("ask_wait_max_s");
  const result = await waitForAnswer(created.id, args.wait_s ?? cap);
  return { id: created.id, url: created.url, ...result };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "cryer", version }, { instructions: INSTRUCTIONS });

  server.registerTool("notify", { description: "Post a notification embed to Discord.", inputSchema: notifyArgs }, async (args) => {
    try {
      const r = await notify({ ...args, type: "generic" });
      return text(r);
    } catch (err) {
      return failure(err);
    }
  });

  server.registerTool(
    "ask",
    { description: ASK_DESCRIPTION, inputSchema: askArgs },
    async (args, extra) => {
      const sessionId = callerSession(extra._meta as Record<string, unknown> | undefined);
      log.info(`ask "${args.title}" mode=${args.mode} session=${sessionId ?? "-"}`);
      try {
        return text(await runAsk(args, sessionId));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "wait",
    { description: "Block until a prompt is answered/expired or timeout_s passes.", inputSchema: { id: z.string(), timeout_s: z.number().int().min(0).optional() } },
    async ({ id, timeout_s }) => {
      try {
        const cap = await settings.getInt("ask_wait_max_s");
        return text({ id, ...(await waitForAnswer(id, timeout_s ?? cap)) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool("get", { description: "One prompt with its answer.", inputSchema: { id: z.string() } }, async ({ id }) => {
    try {
      return text(await promptView(await requirePrompt(id)));
    } catch (err) {
      return failure(err);
    }
  });

  server.registerTool("cancel", { description: "Cancel a pending prompt.", inputSchema: { id: z.string() } }, async ({ id }) => {
    try {
      const p = await cancelPrompt(id);
      return text({ id: p.id, status: p.status });
    } catch (err) {
      return failure(err);
    }
  });

  server.registerTool(
    "list",
    { description: "List prompts, newest first.", inputSchema: { status: z.enum(PROMPT_STATUSES).optional(), limit: z.number().int().min(1).max(200).default(20) } },
    async ({ status, limit }) => {
      try {
        return text(await listPrompts(status, limit));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

export function mountMcp(router: Hono) {
  router.all("/mcp", async (c) => {
    // Stateless + JSON responses: the reply is complete when handleRequest returns, so the
    // per-request server can be closed right away and nothing lingers in memory.
    const server = buildServer();
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return (await transport.handleRequest(c)) ?? c.body(null, 204);
    } finally {
      await server.close().catch(() => {});
    }
  });
}
