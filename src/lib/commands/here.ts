// `/cryer here`: point default_channel at the invoking channel (server install) or the invoker's DM
// (user install). Sugar over the `default_channel` setting — the setting stays the contract.

import { InteractionResponseType, InteractionContextType, MessageFlags, type APIChatInputApplicationCommandInteraction, type APIInteractionResponse, type APIUser } from "discord-api-types/v10";
import { logger } from "../log.ts";
import { settings } from "../settings.ts";

const log = logger("command");

export const ephemeral = (content: string): APIInteractionResponse => ({
  type: InteractionResponseType.ChannelMessageWithSource,
  data: { content, flags: MessageFlags.Ephemeral },
});

const userOf = (i: APIChatInputApplicationCommandInteraction): APIUser | undefined => i.member?.user ?? i.user;
const nameOf = (u: APIUser | undefined) => u?.global_name || u?.username || "unknown";

/** `command_users` ("" = anyone who can invoke) → is this user allowed to configure cryer? */
export async function commandAllowed(userId: string | undefined): Promise<boolean> {
  const list = (await settings.get("command_users", "")).split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || (userId !== undefined && list.includes(userId));
}

export const NOT_ALLOWED = "You are not allowed to configure cryer.";
export const NOT_INSTALLED_HERE =
  "cryer is not added to this server, so it cannot post here. Add it to the server first, or run /cryer here in my DM.";
export const UNSUPPORTED_CONTEXT = "cryer can only be pointed at a server channel or at your DM with it.";

/** Decide the target string for this interaction, or the refusal text. Pure; no I/O. */
export function targetOf(i: APIChatInputApplicationCommandInteraction): { target: string; guild: boolean } | { refuse: string } {
  const user = userOf(i);
  if (i.context === InteractionContextType.BotDM) {
    return user ? { target: `dm:${user.id}`, guild: false } : { refuse: UNSUPPORTED_CONTEXT };
  }
  if (i.context === InteractionContextType.Guild) {
    const owners = (i.authorizing_integration_owners ?? {}) as Record<string, string>;
    if (!("0" in owners)) return { refuse: NOT_INSTALLED_HERE };
    return i.channel_id ? { target: i.channel_id, guild: true } : { refuse: UNSUPPORTED_CONTEXT };
  }
  return { refuse: UNSUPPORTED_CONTEXT };
}

export async function here(i: APIChatInputApplicationCommandInteraction): Promise<APIInteractionResponse> {
  const user = userOf(i);
  if (!(await commandAllowed(user?.id))) return ephemeral(NOT_ALLOWED);
  const decision = targetOf(i);
  if ("refuse" in decision) return ephemeral(decision.refuse);
  await settings.set("default_channel", decision.target);
  log.info(`cryer here by ${nameOf(user)} (${user?.id ?? "?"}) -> ${decision.target}`);
  const tail = decision.guild ? " Per-source `route.*` settings still override this." : "";
  return ephemeral(`Notifications and prompts will land here (\`${decision.target}\`).${tail}`);
}
