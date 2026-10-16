// `/cryer forget`: undo `/cryer here` — default_channel goes back to the env fallback
// (DEFAULT_CHANNEL_ID, "" when unset). route.* settings are untouched.

import type { APIChatInputApplicationCommandInteraction, APIInteractionResponse } from "discord-api-types/v10";
import { env } from "../env.ts";
import { logger } from "../log.ts";
import { settings } from "../settings.ts";
import { commandAllowed, ephemeral, nameOf, NOT_ALLOWED, userOf } from "./here.ts";

const log = logger("command");

export async function forget(i: APIChatInputApplicationCommandInteraction): Promise<APIInteractionResponse> {
  const user = userOf(i);
  if (!(await commandAllowed(user?.id))) return ephemeral(NOT_ALLOWED);
  const fallback = env.defaultChannelId;
  await settings.set("default_channel", fallback);
  log.info(`cryer forget by ${nameOf(user)} (${user?.id ?? "?"}) -> ${fallback || "unset"}`);
  const tail = fallback
    ? `Notifications without a \`route.*\` match go to \`${fallback}\` (the \`DEFAULT_CHANNEL_ID\` fallback) until /cryer here is run again.`
    : "Notifications without a `route.*` match will fail until /cryer here is run again.";
  return ephemeral(`Default target reset to ${fallback ? `\`${fallback}\`` : "unset"}. ${tail}`);
}
