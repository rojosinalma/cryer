// Command registry: definitions (registered at boot by register.ts) + dispatcher for chat-input
// interactions. One handler per file, like ingest/<source>.ts. The only commands cryer has are the
// ones that configure cryer itself — never chat or general-bot features.

import { SlashCommandBuilder } from "@discordjs/builders";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionResponse,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import { forget } from "./forget.ts";
import { ephemeral, here } from "./here.ts";
import { status } from "./status.ts";

export type CommandHandler = (i: APIChatInputApplicationCommandInteraction) => Promise<APIInteractionResponse>;

export const cryerCommand = new SlashCommandBuilder()
  .setName("cryer")
  .setDescription("Configure cryer")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
  .addSubcommand((s) => s.setName("here").setDescription("Send cryer's notifications and prompts to this channel or DM"))
  .addSubcommand((s) => s.setName("status").setDescription("Show where cryer posts and the gateway state"))
  .addSubcommand((s) => s.setName("forget").setDescription("Reset the default target"));

/** Every command cryer registers (bulk-overwritten at boot). */
export const commandDefinitions: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[] = Object.freeze([cryerCommand.toJSON()]);

/** `<command>` or `<command> <subcommand>` → handler. */
const handlers: Readonly<Record<string, CommandHandler>> = Object.freeze({
  "cryer here": here,
  "cryer status": status,
  "cryer forget": forget,
});

/** Key of the handler table for an interaction: command name plus the first subcommand, if any. */
export function commandKey(i: APIChatInputApplicationCommandInteraction): string {
  const sub = i.data.options?.find((o) => o.type === ApplicationCommandOptionType.Subcommand);
  return sub ? `${i.data.name} ${sub.name}` : i.data.name;
}

export async function handleCommand(i: APIChatInputApplicationCommandInteraction): Promise<APIInteractionResponse> {
  if (i.data.type !== ApplicationCommandType.ChatInput) return ephemeral("cryer does not handle this kind of command.");
  const handler = handlers[commandKey(i)];
  if (!handler) return ephemeral(`Unknown command \`/${commandKey(i)}\`.`);
  return handler(i);
}
