// `/cryer status`: where cryer posts right now (default target, route.* overrides) and the gateway
// state. Read-only, ephemeral; two settings reads plus the local health view, well inside Discord's 3 s.

import type { APIChatInputApplicationCommandInteraction, APIInteractionResponse } from "discord-api-types/v10";
import { settings } from "../settings.ts";
import { gatewayHealth } from "../transports/gateway.ts";
import { version } from "../../version.ts";
import { commandAllowed, ephemeral, NOT_ALLOWED, userOf } from "./here.ts";

/** Max `route.*` lines shown before "… and N more". */
export const ROUTE_LINES = 10;

/** Render a target the way a Discord user reads it. Pure. */
export function describeTarget(target: string, invokerId: string | undefined): string {
  if (!target) return "unset";
  if (target.startsWith("dm:")) {
    const id = target.slice(3);
    return invokerId !== undefined && id === invokerId ? `your DM (\`${target}\`)` : `DM of user <@${id}> (\`${target}\`)`;
  }
  if (/^\d+$/.test(target)) return `channel <#${target}>`;
  return `\`${target}\``;
}

export async function status(i: APIChatInputApplicationCommandInteraction): Promise<APIInteractionResponse> {
  const user = userOf(i);
  if (!(await commandAllowed(user?.id))) return ephemeral(NOT_ALLOWED);
  const [defaultTarget, all, gw] = await Promise.all([settings.get("default_channel", ""), settings.all(), gatewayHealth()]);
  const routes = Object.entries(all).filter(([k]) => k.startsWith("route."));
  const lines = [`**cryer ${version}**`, `Default target: ${describeTarget(defaultTarget, user?.id)}`];
  if (routes.length === 0) lines.push("Routes: none (`route.*` settings)");
  else {
    lines.push(`Routes (${routes.length}):`);
    for (const [k, v] of routes.slice(0, ROUTE_LINES)) lines.push(`• \`${k}\` → ${describeTarget(v, user?.id)}`);
    if (routes.length > ROUTE_LINES) lines.push(`• … and ${routes.length - ROUTE_LINES} more`);
  }
  const role = !gw.enabled ? "disabled" : gw.leader ? "leader (this replica)" : `follower (holder: ${gw.holder ?? "none"})`;
  lines.push(
    `Gateway: ${role}, connected: ${gw.connected ? "yes" : "no"}, reply parsing: ${gw.reply_parsing ? "yes" : "no"}, in DMs: ${gw.reply_parsing_dm ? "yes" : "no"}`,
  );
  return ephemeral(lines.join("\n"));
}
