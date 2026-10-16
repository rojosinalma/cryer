import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Timestamps are ISO-8601 strings (UTC) so both bun:sqlite and rqlite return the same shape.

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  type: text("type").notNull(),
  level: text("level").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  title: text("title").notNull(),
  bodyJson: text("body_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const PROMPT_STATUSES = ["pending", "answered", "expired", "failed"] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  messageId: text("message_id").references(() => messages.id),
  channelId: text("channel_id").notNull(),
  discordMessageId: text("discord_message_id"),
  title: text("title").notNull(),
  body: text("body"),
  optionsJson: text("options_json").notNull(),
  modalJson: text("modal_json"),
  ttlS: integer("ttl_s").notNull(),
  status: text("status", { enum: PROMPT_STATUSES }).notNull().default("pending"),
  callbackJson: text("callback_json"),
  sessionJson: text("session_json"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  answeredAt: text("answered_at"),
});

export const ANSWER_VIAS = ["button", "modal", "reaction", "reply"] as const;
export type AnswerVia = (typeof ANSWER_VIAS)[number];

/**
 * Free-text answers (a reply that matches no option) have no choice. SQLite cannot relax a NOT NULL
 * column additively, so they are stored with these sentinels and mapped to null in every view.
 */
export const NO_CHOICE_IDX = -1;
export const NO_CHOICE_ID = "";

export const answers = sqliteTable("answers", {
  id: text("id").primaryKey(),
  promptId: text("prompt_id")
    .notNull()
    .references(() => prompts.id),
  choiceIdx: integer("choice_idx").notNull(),
  choiceId: text("choice_id").notNull(),
  text: text("text"),
  userId: text("user_id").notNull(),
  userName: text("user_name").notNull(),
  createdAt: text("created_at").notNull(),
  via: text("via", { enum: ANSWER_VIAS }).notNull().default("button"),
});

// Gateway leader election (v0.3.0): one row per lease name, held while expires_at is in the future.
export const leases = sqliteTable("leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const migrations = sqliteTable("migrations", {
  name: text("name").primaryKey(),
  appliedAt: text("applied_at").notNull(),
});

export type Prompt = typeof prompts.$inferSelect;
export type Answer = typeof answers.$inferSelect;
export type Message = typeof messages.$inferSelect;
