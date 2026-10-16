// Prompt buttons: custom_id `p:<prompt_id>:<idx>`, max 5 per row, 5 rows.

import { ActionRowBuilder, ButtonBuilder } from "@discordjs/builders";
import { ButtonStyle as DiscordButtonStyle } from "discord-api-types/v10";
import { ValidationError } from "../errors.ts";
import type { ButtonStyle, Option } from "../types.ts";
import type { ActionRows } from "./types.ts";

export const CUSTOM_ID_MAX = 100;
const ROW_SIZE = 5;

const STYLE: Record<ButtonStyle, DiscordButtonStyle> = {
  primary: DiscordButtonStyle.Primary,
  secondary: DiscordButtonStyle.Secondary,
  success: DiscordButtonStyle.Success,
  danger: DiscordButtonStyle.Danger,
} as const;

export interface CustomId {
  kind: "p" | "m";
  promptId: string;
  idx: number;
}

export function encodeCustomId(kind: "p" | "m", promptId: string, idx: number): string {
  const id = `${kind}:${promptId}:${idx}`;
  if (id.length > CUSTOM_ID_MAX) throw new ValidationError(`custom_id exceeds ${CUSTOM_ID_MAX} chars`);
  return id;
}

export function decodeCustomId(raw: string): CustomId | null {
  if (raw.length > CUSTOM_ID_MAX) return null;
  const m = /^([pm]):([A-Za-z0-9_-]+):(\d{1,2})$/.exec(raw);
  if (!m) return null;
  return { kind: m[1] as "p" | "m", promptId: m[2]!, idx: Number(m[3]) };
}

export function buildButtons(promptId: string, options: Option[], disabled = false): ActionRows {
  const rows: ActionRows = [];
  for (let i = 0; i < options.length; i += ROW_SIZE) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    options.slice(i, i + ROW_SIZE).forEach((opt, j) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(encodeCustomId("p", promptId, i + j))
          .setLabel(opt.label.slice(0, 80))
          .setStyle(STYLE[opt.style ?? "secondary"])
          .setDisabled(disabled),
      );
    });
    rows.push(row.toJSON());
  }
  return rows;
}
