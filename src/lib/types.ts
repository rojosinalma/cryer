// Shared types for notifications/prompts (API bodies after Zod validation).

import { z } from "zod";

export const LEVELS = ["info", "success", "warning", "failure"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_COLORS: Record<Level, number> = {
  info: 0x8be9fd,
  success: 0x50fa7b,
  warning: 0xffb86c,
  failure: 0xff5555,
} as const;

export const BUTTON_STYLES = ["primary", "secondary", "success", "danger"] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];

export const MAX_OPTIONS = 25; // 5 rows × 5 buttons

export const fieldSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().min(1).max(1024),
  inline: z.boolean().optional(),
});
export type Field = z.infer<typeof fieldSchema>;

export const modalFieldSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(45),
  style: z.enum(["short", "paragraph"]).default("short"),
  required: z.boolean().optional(),
  placeholder: z.string().max(100).optional(),
});

export const modalSchema = z.object({
  title: z.string().min(1).max(45),
  fields: z.array(modalFieldSchema).min(1).max(5),
});
export type ModalSpec = z.infer<typeof modalSchema>;

export const httpCallbackSchema = z.object({
  kind: z.literal("http"),
  url: z.url(),
  method: z.enum(["POST", "PUT"]).default("POST"),
  body: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const opencodeCallbackSchema = z.object({
  kind: z.literal("opencode-session"),
  session_id: z.string().min(1),
  directory: z.string().optional(),
  mode: z.enum(["prompt", "instruction"]).optional(),
});

export const callbackSchema = z.discriminatedUnion("kind", [httpCallbackSchema, opencodeCallbackSchema]);
export type CallbackSpec = z.infer<typeof callbackSchema>;

export const sessionSchema = z.object({
  id: z.string().min(1),
  directory: z.string().optional(),
  mode: z.enum(["prompt", "instruction"]).optional(),
});
export type SessionSpec = z.infer<typeof sessionSchema>;

export const optionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  style: z.enum(BUTTON_STYLES).optional(),
  modal: modalSchema.optional(),
  callback: callbackSchema.optional(),
});
export type Option = z.infer<typeof optionSchema>;

export const optionsSchema = z.array(optionSchema).min(1).max(MAX_OPTIONS);

export const notifySchema = z.object({
  source: z.string().min(1).max(64),
  type: z.string().min(1).max(64).default("generic"),
  level: z.enum(LEVELS),
  title: z.string().min(1).max(256),
  body: z.string().max(4000).optional(),
  fields: z.array(fieldSchema).max(25).optional(),
  channel: z.string().regex(/^\d+$/).optional(),
  url: z.url().optional(),
  actions: optionsSchema.optional(),
  ttl_s: z.number().int().positive().optional(),
  callback: callbackSchema.optional(),
  session: sessionSchema.optional(),
  /** false: no number reactions on the message (reaction answers off for this prompt). */
  reactions: z.boolean().optional(),
});
export type NotifyInput = z.infer<typeof notifySchema>;

export const promptSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(4000).optional(),
  source: z.string().min(1).max(64).default("agent"),
  level: z.enum(LEVELS).default("info"),
  options: optionsSchema,
  ttl_s: z.number().int().positive().optional(),
  channel: z.string().regex(/^\d+$/).optional(),
  callback: callbackSchema.optional(),
  session: sessionSchema.optional(),
  mode: z.enum(["wait", "callback"]).optional(),
  reactions: z.boolean().optional(),
});
export type PromptInput = z.infer<typeof promptSchema>;

export type AnswerVia = "button" | "modal" | "reaction" | "reply";

/** choice_id/choice_idx are null for a free-text reply that matched no option. */
export interface AnswerView {
  choice_id: string | null;
  choice_idx: number | null;
  text: string | null;
  user_id: string;
  user_name: string;
  at: string;
  via: AnswerVia;
}
