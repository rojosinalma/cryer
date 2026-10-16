// apprise `json://` notifier payload → notification with source "apprise".

import { z } from "zod";
import { notifySchema, type NotifyInput } from "../types.ts";
import type { IngestAdapter } from "./types.ts";

export const appriseSchema = z.object({
  version: z.string().optional(),
  title: z.string().default(""),
  message: z.string().default(""),
  attachments: z.array(z.unknown()).optional(),
  type: z.enum(["info", "success", "warning", "failure"]).default("info"),
  format: z.string().optional(),
  id: z.string().optional(),
});

export const apprise: IngestAdapter = {
  parse(body): NotifyInput {
    const p = appriseSchema.parse(body);
    const title = p.title.trim() || p.message.split("\n")[0]?.slice(0, 256) || "apprise";
    return notifySchema.parse({
      source: "apprise",
      type: "generic",
      level: p.type,
      title,
      body: p.message || undefined,
      fields: p.id ? [{ name: "id", value: p.id, inline: true }] : undefined,
    });
  },
};
