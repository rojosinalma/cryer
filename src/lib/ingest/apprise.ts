// apprise `json://` notifier payload → notification with source "apprise".
//
// Besides apprise's own keys the body may carry `url` (an http/https link, e.g. the deployer posting
// apprise-style JSON): it becomes the embed's title link and a "Link" field. Anything that is not an
// http(s) URL is ignored silently, so a bad link never fails the ingest.

import { z } from "zod";
import { notifySchema, type Field, type NotifyInput } from "../types.ts";
import { isHttpUrl, type IngestAdapter } from "./types.ts";

export const appriseSchema = z.object({
  version: z.string().optional(),
  title: z.string().default(""),
  message: z.string().default(""),
  attachments: z.array(z.unknown()).optional(),
  type: z.enum(["info", "success", "warning", "failure"]).default("info"),
  format: z.string().optional(),
  id: z.string().optional(),
  url: z.string().optional(),
});

export const apprise: IngestAdapter = {
  parse(body): NotifyInput {
    const p = appriseSchema.parse(body);
    const title = p.title.trim() || p.message.split("\n")[0]?.slice(0, 256) || "apprise";
    const url = isHttpUrl(p.url) ? p.url : undefined;
    const fields: Field[] = [];
    if (p.id) fields.push({ name: "id", value: p.id, inline: true });
    if (url) fields.push({ name: "Link", value: url.slice(0, 1024) });
    return notifySchema.parse({
      source: "apprise",
      type: "generic",
      level: p.type,
      title,
      body: p.message || undefined,
      fields: fields.length ? fields : undefined,
      url,
    });
  },
};
