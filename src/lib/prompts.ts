// Notifications and prompts: the core flow shared by /notify, /prompts, ingest and MCP.

import { randomBytes } from "node:crypto";
import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { APIEmbed } from "discord-api-types/v10";
import { answers, messages, NO_CHOICE_ID, NO_CHOICE_IDX, prompts, type Prompt, type PromptStatus } from "../db/schema.ts";
import { deliverCallback, validateCallback, type CallbackContext } from "./callbacks/index.ts";
import { discord, guildOf, messageUrl } from "./discord.ts";
import { notFound, ValidationError } from "./errors.ts";
import { logger } from "./log.ts";
import { queue } from "./queue.ts";
import { buildButtons, rendererFor, type RenderInput } from "./render/index.ts";
import { resolveChannel, settings } from "./settings.ts";
import { getDb } from "./store.ts";
import type { AnswerVia, AnswerView, CallbackSpec, NotifyInput, Option, PromptInput, SessionSpec } from "./types.ts";

const log = logger("prompt");

export const newId = () => randomBytes(12).toString("base64url");
const now = () => new Date().toISOString();

export interface NotifyResult {
  id: string;
  channel_id: string;
  message_id: string;
  prompt_id?: string;
  url: string;
}

export interface PromptResult {
  id: string;
  url: string;
  channel_id: string;
  message_id: string;
}

const renderInputOf = (n: NotifyInput, createdAt: string): RenderInput => ({
  source: n.source,
  type: n.type,
  level: n.level,
  title: n.title,
  body: n.body,
  fields: n.fields,
  url: n.url,
  createdAt,
});

async function validateCallbacks(options: Option[], callback?: CallbackSpec) {
  if (callback) await validateCallback(callback);
  for (const o of options) if (o.callback) await validateCallback(o.callback);
}

/** Post a notification (optionally with action buttons, which makes it a prompt too). */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const channelId = await resolveChannel(input.source, input.level, input.channel);
  if (!channelId) throw new ValidationError("no channel: pass `channel` or set default_channel / route.* settings", 422);
  const createdAt = now();
  const render = renderInputOf(input, createdAt);
  const embed = rendererFor(input.type).embed(render);
  const id = newId();
  const db = getDb();

  let promptId: string | undefined;
  let components: ReturnType<typeof buildButtons> | undefined;
  if (input.actions?.length) {
    await validateCallbacks(input.actions, input.callback);
    promptId = newId();
    components = buildButtons(promptId, input.actions);
  }

  const posted = await discord().postMessage(channelId, { embeds: [embed], components });

  await db.insert(messages).values({
    id,
    source: input.source,
    type: input.type,
    level: input.level,
    channelId,
    messageId: posted.id,
    title: input.title,
    bodyJson: JSON.stringify(render),
    createdAt,
  });

  if (promptId && input.actions) {
    const ttl = input.ttl_s ?? (await settings.getInt("prompt_ttl_s"));
    await db.insert(prompts).values({
      id: promptId,
      messageId: id,
      channelId,
      discordMessageId: posted.id,
      title: input.title,
      body: input.body ?? null,
      optionsJson: JSON.stringify(input.actions),
      modalJson: null,
      ttlS: ttl,
      status: "pending",
      callbackJson: input.callback ? JSON.stringify(input.callback) : null,
      sessionJson: input.session ? JSON.stringify(input.session) : null,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttl * 1000).toISOString(),
      answeredAt: null,
    });
    if (input.reactions !== false) queueReactions(promptId, channelId, posted.id, input.actions);
  }

  const url = messageUrl(await guildOf(channelId), channelId, posted.id);
  log.info(`notify ${id} source=${input.source} level=${input.level} channel=${channelId}${promptId ? ` prompt=${promptId}` : ""}`);
  return { id, channel_id: channelId, message_id: posted.id, prompt_id: promptId, url };
}

/** Create a prompt: embed + buttons, stored pending, returns the Discord message link. */
export async function createPrompt(input: PromptInput): Promise<PromptResult> {
  const channelId = await resolveChannel(input.source, input.level, input.channel);
  if (!channelId) throw new ValidationError("no channel: pass `channel` or set default_channel / route.* settings", 422);
  await validateCallbacks(input.options, input.callback);

  const createdAt = now();
  const ttl = input.ttl_s ?? (await settings.getInt("prompt_ttl_s"));
  const id = newId();
  const messageRowId = newId();
  const render: RenderInput = {
    source: input.source,
    type: "prompt",
    level: input.level,
    title: input.title,
    body: input.body,
    createdAt,
  };
  const embed = rendererFor("prompt").embed(render);
  const db = getDb();

  await db.insert(messages).values({
    id: messageRowId,
    source: input.source,
    type: "prompt",
    level: input.level,
    channelId,
    messageId: null,
    title: input.title,
    bodyJson: JSON.stringify(render),
    createdAt,
  });
  await db.insert(prompts).values({
    id,
    messageId: messageRowId,
    channelId,
    discordMessageId: null,
    title: input.title,
    body: input.body ?? null,
    optionsJson: JSON.stringify(input.options),
    modalJson: null,
    ttlS: ttl,
    status: "pending",
    callbackJson: input.callback ? JSON.stringify(input.callback) : null,
    sessionJson: input.session ? JSON.stringify(input.session) : null,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttl * 1000).toISOString(),
    answeredAt: null,
  });

  let posted;
  try {
    posted = await discord().postMessage(channelId, { embeds: [embed], components: buildButtons(id, input.options) });
  } catch (err) {
    await db.update(prompts).set({ status: "failed" }).where(eq(prompts.id, id));
    throw err;
  }
  await db.update(messages).set({ messageId: posted.id }).where(eq(messages.id, messageRowId));
  await db.update(prompts).set({ discordMessageId: posted.id }).where(eq(prompts.id, id));
  if (input.reactions !== false) queueReactions(id, channelId, posted.id, input.options);

  const url = messageUrl(await guildOf(channelId), channelId, posted.id);
  log.info(`prompt ${id} created source=${input.source} channel=${channelId} ttl=${ttl}s options=${input.options.length}`);
  return { id, url, channel_id: channelId, message_id: posted.id };
}

// ---------- reactions ----------

/** 1️⃣..9️⃣ — option index i is answered by NUMBER_EMOJI[i]; the gateway leader maps them back. */
export const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"] as const;
export const MAX_REACTION_OPTIONS = NUMBER_EMOJI.length;

/** Index of a number emoji (variation selector tolerated), or undefined for anything else. */
export function emojiIndex(name: string | null | undefined): number | undefined {
  if (!name) return undefined;
  const bare = name.replace(/\uFE0F/g, "");
  const idx = NUMBER_EMOJI.findIndex((e) => e.replace(/\uFE0F/g, "") === bare);
  return idx === -1 ? undefined : idx;
}

/** Options answerable by reaction: the first nine, minus those that need a modal (nothing to type). */
export const reactionIndexes = (options: readonly Option[]): number[] =>
  options
    .slice(0, MAX_REACTION_OPTIONS)
    .map((o, i) => (o.modal ? -1 : i))
    .filter((i) => i >= 0);

/** Add the number reactions through REST (any replica, independent of gateway leadership), off the request path. */
function queueReactions(promptId: string, channelId: string, discordMessageId: string, options: readonly Option[]) {
  const idxs = reactionIndexes(options);
  if (!idxs.length) return;
  queue.push(`reactions:${promptId}`, async () => {
    for (const i of idxs) {
      try {
        await discord().addReaction(channelId, discordMessageId, NUMBER_EMOJI[i]!);
      } catch (err) {
        log.warn(`prompt ${promptId}: reaction ${i + 1} failed, stopping: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }
    log.debug(`prompt ${promptId}: ${idxs.length} reaction(s) added`);
  });
}

// ---------- reading ----------

export const optionsOf = (p: Prompt): Option[] => JSON.parse(p.optionsJson) as Option[];

/** The prompt behind a Discord message id (reactions and replies arrive with the message id only). */
export async function promptByMessageId(discordMessageId: string): Promise<Prompt | undefined> {
  return getDb().select().from(prompts).where(eq(prompts.discordMessageId, discordMessageId)).get();
}

export async function getPrompt(id: string): Promise<Prompt | undefined> {
  return getDb().select().from(prompts).where(eq(prompts.id, id)).get();
}

export async function getAnswer(promptId: string): Promise<AnswerView | undefined> {
  const a = await getDb().select().from(answers).where(eq(answers.promptId, promptId)).get();
  if (!a) return undefined;
  const free = a.choiceIdx === NO_CHOICE_IDX;
  return {
    choice_id: free ? null : a.choiceId,
    choice_idx: free ? null : a.choiceIdx,
    text: a.text,
    user_id: a.userId,
    user_name: a.userName,
    at: a.createdAt,
    via: a.via,
  };
}

export interface PromptView {
  id: string;
  status: PromptStatus;
  title: string;
  body: string | null;
  options: Option[];
  channel_id: string;
  message_id: string | null;
  url: string | null;
  created_at: string;
  expires_at: string;
  answered_at: string | null;
  answer?: AnswerView;
}

export async function promptView(p: Prompt): Promise<PromptView> {
  const answer = p.status === "answered" ? await getAnswer(p.id) : undefined;
  return {
    id: p.id,
    status: p.status,
    title: p.title,
    body: p.body,
    options: optionsOf(p),
    channel_id: p.channelId,
    message_id: p.discordMessageId,
    url: p.discordMessageId ? messageUrl(await guildOf(p.channelId), p.channelId, p.discordMessageId) : null,
    created_at: p.createdAt,
    expires_at: p.expiresAt,
    answered_at: p.answeredAt,
    answer,
  };
}

export async function requirePrompt(id: string): Promise<Prompt> {
  const p = await getPrompt(id);
  if (!p) throw notFound("prompt", { id });
  return p;
}

export async function listPrompts(status: PromptStatus | undefined, limit: number): Promise<PromptView[]> {
  const db = getDb();
  const q = db.select().from(prompts);
  const rows = await (status ? q.where(eq(prompts.status, status)) : q).orderBy(desc(prompts.createdAt)).limit(limit);
  return Promise.all(rows.map(promptView));
}

// ---------- answering ----------

export interface AnswerInput {
  /** Option index; null = free-text answer (reply matching no option), `text` then carries it. */
  idx: number | null;
  text?: string | null;
  userId: string;
  userName: string;
  via?: AnswerVia;
}

export type AnswerOutcome =
  | { ok: true; prompt: Prompt; option: Option | null; answer: AnswerView }
  | { ok: false; status: PromptStatus | "unknown-option" | "missing" };

/** Label shown for an answer: the option's, or the free text itself. */
export const answerLabel = (option: Option | null, answer: AnswerView) => option?.label ?? (answer.text || "free text");

/** First writer wins: UPDATE … WHERE status='pending' decides, the loser sees the new status. */
export async function answerPrompt(promptId: string, input: AnswerInput): Promise<AnswerOutcome> {
  const db = getDb();
  const prompt = await getPrompt(promptId);
  if (!prompt) return { ok: false, status: "missing" };
  const option = input.idx === null ? null : optionsOf(prompt)[input.idx];
  if (option === undefined) return { ok: false, status: "unknown-option" };
  if (prompt.status !== "pending") return { ok: false, status: prompt.status };
  const via: AnswerVia = input.via ?? "button";

  const at = now();
  const won = await db
    .update(prompts)
    .set({ status: "answered", answeredAt: at })
    .where(and(eq(prompts.id, promptId), eq(prompts.status, "pending")))
    .returning({ id: prompts.id });
  if (!won.length) {
    const fresh = await getPrompt(promptId);
    return { ok: false, status: fresh?.status ?? "missing" };
  }

  const answer: AnswerView = {
    choice_id: option?.id ?? null,
    choice_idx: option ? input.idx : null,
    text: input.text ?? null,
    user_id: input.userId,
    user_name: input.userName,
    at,
    via,
  };
  await db.insert(answers).values({
    id: newId(),
    promptId,
    choiceIdx: option ? input.idx! : NO_CHOICE_IDX,
    choiceId: option?.id ?? NO_CHOICE_ID,
    text: answer.text,
    userId: input.userId,
    userName: input.userName,
    createdAt: at,
    via,
  });
  log.info(`prompt ${promptId} answered ${option ? `idx=${input.idx} id=${option.id}` : "free-text"} via ${via} by ${input.userName}`);

  enqueueCallbacks({ ...prompt, status: "answered", answeredAt: at }, option, answer);
  return { ok: true, prompt: { ...prompt, status: "answered", answeredAt: at }, option, answer };
}

function callbackSpecs(prompt: Prompt, option: Option | null): CallbackSpec[] {
  const specs: CallbackSpec[] = [];
  if (option?.callback) specs.push(option.callback);
  if (prompt.callbackJson) specs.push(JSON.parse(prompt.callbackJson) as CallbackSpec);
  if (prompt.sessionJson) {
    const s = JSON.parse(prompt.sessionJson) as SessionSpec;
    specs.push({ kind: "opencode-session", session_id: s.id, directory: s.directory, mode: s.mode });
  }
  return specs;
}

export function enqueueCallbacks(prompt: Prompt, option: Option | null, answer: AnswerView) {
  const label = answerLabel(option, answer);
  const ctx: CallbackContext = { promptId: prompt.id, title: prompt.title, answer, label };
  const specs = callbackSpecs(prompt, option);
  const outcomes: string[] = []; // bounded by specs.length (≤ 3); lives only while this answer's callbacks run
  for (const spec of specs) {
    queue.push(`callback:${spec.kind}:${prompt.id}`, async () => {
      const who = specs.length > 1 ? `${label} (${spec.kind})` : label;
      try {
        await deliverCallback(spec, ctx);
        outcomes.push(outcomeLine(who, true));
      } catch (err) {
        outcomes.push(outcomeLine(who, false, err instanceof Error ? err.message : String(err)));
        await editOutcome(prompt, option, answer, outcomes);
        throw err; // the queue logs it with its stack
      }
      await editOutcome(prompt, option, answer, outcomes);
    });
  }
}

// ---------- message updates ----------

export const OUTCOME_REASON_MAX = 120;

/** One footer line per callback: "⚙ Retry run: ✓ ok" or "⚙ Retry run: ✗ HTTP 404". */
export function outcomeLine(label: string, ok: boolean, reason?: string): string {
  if (ok) return `⚙ ${label}: ✓ ok`;
  const short = (reason ?? "failed").replace(/\s+/g, " ").trim().slice(0, OUTCOME_REASON_MAX);
  return `⚙ ${label}: ✗ ${short}`;
}

/** Re-edit the answered message once a callback has finished so the outcome is visible in Discord. */
async function editOutcome(p: Prompt, option: Option | null, answer: AnswerView, outcomes: readonly string[]) {
  if (!p.discordMessageId) return;
  try {
    const closed = closedMessage(await storedEmbed(p), p, answeredField(answerLabel(option, answer), answer));
    const embed = closed.embeds[0]!;
    const base = embed.footer?.text ? [embed.footer.text] : [];
    await discord().editMessage(p.channelId, p.discordMessageId, {
      ...closed,
      embeds: [{ ...embed, footer: { text: [...base, ...outcomes].join("\n").slice(0, 2048) } }],
    });
  } catch (err) {
    log.warn(`prompt ${p.id}: could not edit callback outcome: ${err instanceof Error ? err.message : err}`);
  }
}

async function storedEmbed(p: Prompt): Promise<APIEmbed> {
  const row = p.messageId ? await getDb().select().from(messages).where(eq(messages.id, p.messageId)).get() : undefined;
  const render: RenderInput = row
    ? (JSON.parse(row.bodyJson) as RenderInput)
    : { source: "cryer", type: "prompt", level: "info", title: p.title, body: p.body ?? undefined, createdAt: p.createdAt };
  return rendererFor(render.type).embed(render);
}

/** "✅ label — user at time UTC", with "via reaction" / "via reply" when it did not come from a click. */
export const answeredField = (label: string, answer: Pick<AnswerView, "user_name" | "at" | "via">) => {
  const via = answer.via === "reaction" || answer.via === "reply" ? ` via ${answer.via}` : "";
  return { name: "Answer", value: `✅ ${label} — ${answer.user_name}${via} at ${answer.at.replace("T", " ").slice(0, 19)} UTC` };
};

/** Edit the prompt's Discord message to its answered state (used by the gateway, where no interaction response exists). */
export async function editAnswered(outcome: Extract<AnswerOutcome, { ok: true }>): Promise<void> {
  await editClosed(outcome.prompt, answeredField(answerLabel(outcome.option, outcome.answer), outcome.answer));
}

export const expiredField = () => ({ name: "Status", value: "⏱ expired" });
export const cancelledField = () => ({ name: "Status", value: "🚫 cancelled" });

/** Final message content once a prompt is closed (buttons disabled + status field). */
export function closedMessage(embed: APIEmbed, p: Prompt, field: { name: string; value: string }) {
  return {
    embeds: [{ ...embed, fields: [...(embed.fields ?? []), field] }],
    components: buildButtons(p.id, optionsOf(p), true),
  };
}

async function editClosed(p: Prompt, field: { name: string; value: string }) {
  if (!p.discordMessageId) return;
  try {
    await discord().editMessage(p.channelId, p.discordMessageId, closedMessage(await storedEmbed(p), p, field));
  } catch (err) {
    log.warn(`prompt ${p.id}: could not edit message: ${err instanceof Error ? err.message : err}`);
  }
}

/** Mark a pending prompt expired; only the winner (rows affected) edits the Discord message. */
async function closePending(id: string, field: { name: string; value: string }): Promise<Prompt | null> {
  const won = await getDb()
    .update(prompts)
    .set({ status: "expired" })
    .where(and(eq(prompts.id, id), eq(prompts.status, "pending")))
    .returning();
  const p = won[0];
  if (!p) return null;
  await editClosed(p, field);
  return p;
}

export async function cancelPrompt(id: string): Promise<Prompt> {
  const existing = await requirePrompt(id);
  if (existing.status !== "pending") throw new ValidationError(`prompt is already ${existing.status}`, 409, { status: existing.status });
  const closed = await closePending(id, cancelledField());
  if (!closed) throw new ValidationError("prompt was answered or expired concurrently", 409);
  log.info(`prompt ${id} cancelled`);
  return closed;
}

/** Expire everything past its deadline. Idempotent across replicas. */
export async function sweepExpired(): Promise<number> {
  const due = await getDb()
    .select({ id: prompts.id })
    .from(prompts)
    .where(and(eq(prompts.status, "pending"), lt(prompts.expiresAt, now())))
    .limit(100);
  let n = 0;
  for (const { id } of due) {
    if (await closePending(id, expiredField())) n++;
  }
  if (n) log.info(`expired ${n} prompt(s)`);
  return n;
}

// ---------- waiting ----------

export interface WaitResult {
  status: PromptStatus;
  answer?: AnswerView;
}

/** Long-poll the store (not memory) so a click on the other replica is seen. */
export async function waitForAnswer(id: string, timeoutS: number): Promise<WaitResult> {
  const cap = await settings.getInt("ask_wait_max_s");
  const pollMs = await settings.getInt("wait_poll_ms");
  const deadline = Date.now() + Math.min(Math.max(timeoutS, 0), cap) * 1000;
  for (;;) {
    const p = await requirePrompt(id);
    if (p.status !== "pending") return { status: p.status, answer: await getAnswer(id) };
    if (Date.now() >= deadline) return { status: "pending" };
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(deadline - Date.now(), 1))));
  }
}

// ---------- purge ----------

export async function purge(days: number): Promise<{ messages: number; prompts: number; answers: number }> {
  if (days <= 0) throw new ValidationError("purge_days must be positive");
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = getDb();
  const oldPrompts = db.select({ id: prompts.id }).from(prompts).where(lt(prompts.createdAt, cutoff));
  const a = await db.delete(answers).where(sql`${answers.promptId} IN ${oldPrompts}`).returning({ id: answers.id });
  const p = await db.delete(prompts).where(lt(prompts.createdAt, cutoff)).returning({ id: prompts.id });
  const stillReferenced = db.select({ id: prompts.messageId }).from(prompts).where(isNotNull(prompts.messageId));
  const m = await db
    .delete(messages)
    .where(and(lt(messages.createdAt, cutoff), sql`${messages.id} NOT IN ${stillReferenced}`))
    .returning({ id: messages.id });
  log.info(`purge older than ${days}d: messages=${m.length} prompts=${p.length} answers=${a.length}`);
  return { messages: m.length, prompts: p.length, answers: a.length };
}
