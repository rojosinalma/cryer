// HTTP interactions transport (v1): verify, then handle PING / slash command / button / modal submit.
// Everything answered within Discord's 3 s deadline comes straight from here; slow work
// (callbacks) is enqueued by answerPrompt.

import { ActionRowBuilder, ModalBuilder, TextInputBuilder } from "@discordjs/builders";
import {
  ApplicationCommandType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  TextInputStyle,
  type APIInteraction,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionResponse,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
  type APIUser,
} from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { handleCommand } from "../commands/index.ts";
import { env } from "../env.ts";
import { logger } from "../log.ts";
import { answeredField, answerLabel, answerPrompt, closedMessage, getPrompt, optionsOf, type AnswerOutcome } from "../prompts.ts";
import { decodeCustomId, encodeCustomId } from "../render/index.ts";
import type { ModalSpec } from "../types.ts";

const log = logger("discord");

export const verifySignature = (rawBody: string, signature: string | undefined, timestamp: string | undefined, publicKey = env.discordPublicKey) =>
  Boolean(signature && timestamp && publicKey) && verifyKey(rawBody, signature!, timestamp!, publicKey);

const ephemeral = (content: string): APIInteractionResponse => ({
  type: InteractionResponseType.ChannelMessageWithSource,
  data: { content, flags: MessageFlags.Ephemeral },
});

const userOf = (i: APIInteraction): APIUser | undefined => i.member?.user ?? i.user;
const nameOf = (u: APIUser | undefined) => u?.global_name || u?.username || "unknown";

function modalResponse(promptId: string, idx: number, spec: ModalSpec): APIInteractionResponse {
  const modal = new ModalBuilder().setCustomId(encodeCustomId("m", promptId, idx)).setTitle(spec.title.slice(0, 45));
  for (const f of spec.fields.slice(0, 5)) {
    const input = new TextInputBuilder()
      .setCustomId(f.id.slice(0, 100))
      .setLabel(f.label.slice(0, 45))
      .setStyle(f.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(f.required ?? true);
    if (f.placeholder) input.setPlaceholder(f.placeholder.slice(0, 100));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return { type: InteractionResponseType.Modal, data: modal.toJSON() };
}

/** Collect text input values from a modal submission (action rows and label wrappers). */
export function modalValues(i: APIModalSubmitInteraction): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of i.data.components) {
    if (row.type === ComponentType.ActionRow) {
      for (const c of row.components) if (c.type === ComponentType.TextInput) out[c.custom_id] = c.value;
    } else if (row.type === ComponentType.Label && row.component.type === ComponentType.TextInput) {
      out[row.component.custom_id] = row.component.value;
    }
  }
  return out;
}

const formatText = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([k, v]) => (Object.keys(values).length === 1 ? v : `${k}: ${v}`))
    .join("\n");

async function finish(i: APIInteraction, outcome: AnswerOutcome): Promise<APIInteractionResponse> {
  if (!outcome.ok) {
    if (outcome.status === "missing") return ephemeral("This prompt no longer exists.");
    if (outcome.status === "unknown-option") return ephemeral("Unknown option for this prompt.");
    return ephemeral(`This prompt is already ${outcome.status}.`);
  }
  const message = "message" in i && i.message ? i.message : undefined;
  const embed = message?.embeds?.[0] ?? { title: outcome.prompt.title, description: outcome.prompt.body ?? undefined };
  const field = answeredField(answerLabel(outcome.option, outcome.answer), outcome.answer);
  return { type: InteractionResponseType.UpdateMessage, data: closedMessage(embed, outcome.prompt, field) };
}

async function onComponent(i: APIMessageComponentInteraction): Promise<APIInteractionResponse> {
  const cid = decodeCustomId(i.data.custom_id);
  if (!cid || cid.kind !== "p") return ephemeral("Unrecognised button.");
  const prompt = await getPrompt(cid.promptId);
  if (!prompt) return ephemeral("This prompt no longer exists.");
  if (prompt.status !== "pending") return ephemeral(`This prompt is already ${prompt.status}.`);
  const option = optionsOf(prompt)[cid.idx];
  if (!option) return ephemeral("Unknown option for this prompt.");
  if (option.modal) return modalResponse(prompt.id, cid.idx, option.modal);
  const user = userOf(i);
  return finish(i, await answerPrompt(prompt.id, { idx: cid.idx, userId: user?.id ?? "0", userName: nameOf(user), via: "button" }));
}

async function onModal(i: APIModalSubmitInteraction): Promise<APIInteractionResponse> {
  const cid = decodeCustomId(i.data.custom_id);
  if (!cid || cid.kind !== "m") return ephemeral("Unrecognised modal.");
  const user = userOf(i);
  const text = formatText(modalValues(i));
  return finish(i, await answerPrompt(cid.promptId, { idx: cid.idx, text, userId: user?.id ?? "0", userName: nameOf(user), via: "modal" }));
}

export async function handleInteraction(i: APIInteraction): Promise<APIInteractionResponse> {
  try {
    switch (i.type) {
      case InteractionType.Ping:
        return { type: InteractionResponseType.Pong };
      case InteractionType.ApplicationCommand:
        if (i.data.type !== ApplicationCommandType.ChatInput) break;
        return await handleCommand(i as APIChatInputApplicationCommandInteraction);
      case InteractionType.MessageComponent:
        return await onComponent(i);
      case InteractionType.ModalSubmit:
        return await onModal(i);
    }
    log.warn(`unsupported interaction type ${i.type}`);
    return ephemeral("cryer does not handle this kind of interaction.");
  } catch (err) {
    log.error(`interaction ${i.id} failed`, err);
    return ephemeral(`cryer could not record that: ${err instanceof Error ? err.message : String(err)}`);
  }
}
