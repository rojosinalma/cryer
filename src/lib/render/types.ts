import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed } from "discord-api-types/v10";
import type { Field, Level, Option } from "../types.ts";

export interface RenderInput {
  source: string;
  type: string;
  level: Level;
  title: string;
  body?: string;
  fields?: Field[];
  url?: string;
  createdAt: string;
}

export interface PromptButtons {
  promptId: string;
  options: Option[];
  disabled?: boolean;
}

export type ActionRows = APIActionRowComponent<APIComponentInMessageActionRow>[];

export interface Renderer {
  /** Build the embed for a notification of this type. */
  embed(input: RenderInput): APIEmbed;
}
