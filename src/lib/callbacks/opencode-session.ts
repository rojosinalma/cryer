// opencode-session callback: hand the answer to an agent session on the opencode server.
//   prompt      → POST /api/session/:id/prompt {text, delivery:"queue"}  (starts a turn)
//   instruction → PUT  /api/experimental/session/:id/instructions/entries/cryer {value:{note, answers}}

import type { z } from "zod";
import { env } from "../env.ts";
import { logger } from "../log.ts";
import { settings } from "../settings.ts";
import type { opencodeCallbackSchema } from "../types.ts";
import type { CallbackContext, CallbackHandler } from "./types.ts";

const log = logger("callback");

type OpencodeSpec = z.infer<typeof opencodeCallbackSchema>;
export type SessionMode = "prompt" | "instruction";

export const OPENCODE_TIMEOUT_MS = 10_000;
const MAX_INSTRUCTION_ANSWERS = 3;

/** Per-session ring of recent answers for instruction mode (bounded: 100 sessions × 3 answers). */
const recent = new Map<string, Record<string, unknown>[]>();
const RECENT_SESSIONS_MAX = 100;

function remember(sessionId: string, entry: Record<string, unknown>) {
  const list = recent.get(sessionId) ?? [];
  list.push(entry);
  while (list.length > MAX_INSTRUCTION_ANSWERS) list.shift();
  recent.delete(sessionId);
  if (recent.size >= RECENT_SESSIONS_MAX) recent.delete(recent.keys().next().value!);
  recent.set(sessionId, list);
  return list;
}

export const answerText = (ctx: CallbackContext) => {
  const via = ctx.answer.via === "reaction" || ctx.answer.via === "reply" ? ` via ${ctx.answer.via}` : "";
  const by = `by ${ctx.answer.user_name}${via} at ${ctx.answer.at}`;
  if (ctx.answer.choice_id === null) return `cryer: free-text reply to "${ctx.title}": ${ctx.answer.text ?? ""} ${by}`;
  const text = ctx.answer.text ? ` (${ctx.answer.text})` : "";
  return `cryer: answer to "${ctx.title}": ${ctx.label}${text} ${by}`;
};

export function buildRequest(spec: OpencodeSpec, mode: SessionMode, ctx: CallbackContext) {
  const auth = "Basic " + Buffer.from(`${env.opencodeUsername}:${env.opencodePassword}`).toString("base64");
  const base = env.opencodeUrl;
  const query = spec.directory ? `?directory=${encodeURIComponent(spec.directory)}` : "";
  if (mode === "instruction") {
    const answers = remember(spec.session_id, { prompt_id: ctx.promptId, title: ctx.title, label: ctx.label, ...ctx.answer });
    return {
      method: "PUT",
      url: `${base}/api/experimental/session/${encodeURIComponent(spec.session_id)}/instructions/entries/cryer${query}`,
      headers: { authorization: auth, "content-type": "application/json" },
      body: { value: { note: answerText(ctx), answers } },
    };
  }
  return {
    method: "POST",
    url: `${base}/api/session/${encodeURIComponent(spec.session_id)}/prompt${query}`,
    headers: { authorization: auth, "content-type": "application/json" },
    body: { text: answerText(ctx), delivery: "queue" },
  };
}

export const opencodeSession: CallbackHandler<OpencodeSpec> = {
  async validate() {},

  async deliver(spec, ctx) {
    if (!env.opencodeUrl) throw new Error("OPENCODE_URL is not set");
    const mode = (spec.mode ?? (await settings.get("session_callback_mode"))) as SessionMode;
    const req = buildRequest(spec, mode === "instruction" ? "instruction" : "prompt", ctx);
    const path = new URL(req.url).pathname;
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
    });
    log.info(`opencode ${req.method} ${path} -> ${res.status} (prompt ${ctx.promptId}, mode ${mode})`);
    if (!res.ok) throw new Error(`opencode ${req.method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  },
};
