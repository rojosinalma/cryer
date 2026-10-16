// Boot registration: compare our definitions with the application's live global commands and bulk
// overwrite (PUT) only when they differ. Idempotent, so both replicas can run it; a failure never
// blocks boot (the caller logs and moves on).

import { Routes, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord-api-types/v10";
import { call, getRest } from "../discord.ts";
import { env } from "../env.ts";
import { logger } from "../log.ts";
import { settings } from "../settings.ts";
import { commandDefinitions } from "./index.ts";

const log = logger("command");

type Wanted = RESTPostAPIChatInputApplicationCommandsJSONBody;
/** The managed fields, loosely typed: live payloads carry extra fields and `null`s we ignore. */
export interface CommandShape {
  name?: string;
  description?: string;
  options?: readonly { type: number; name: string; description: string; required?: boolean; options?: readonly unknown[] }[];
  integration_types?: readonly number[] | null;
  contexts?: readonly number[] | null;
  default_member_permissions?: string | null;
}

/** Project a command (live or wanted) onto the fields we manage, in a canonical shape. */
export function canonical(c: CommandShape): string {
  const options = (c.options ?? []).map((o) => ({
    type: o.type,
    name: o.name,
    description: o.description,
    required: o.required ? true : undefined,
    options: o.options?.length ? o.options : undefined,
  }));
  return JSON.stringify({
    name: c.name,
    description: c.description,
    options,
    integration_types: [...(c.integration_types ?? [])].sort(),
    contexts: c.contexts ? [...c.contexts].sort() : null,
    default_member_permissions: c.default_member_permissions ?? null,
  });
}

/** True when the live set and the wanted set differ in any managed field (or in membership). Pure. */
export function commandsDiffer(live: readonly CommandShape[], wanted: readonly Wanted[]): boolean {
  if (live.length !== wanted.length) return true;
  const a = live.map(canonical).sort();
  const b = (wanted as readonly CommandShape[]).map(canonical).sort();
  return a.some((x, idx) => x !== b[idx]);
}

export interface CommandsRest {
  get(path: `/${string}`): Promise<unknown>;
  put(path: `/${string}`, body: unknown): Promise<unknown>;
}

const defaultRest = (): CommandsRest => ({
  get: (path) => call("GET", path, () => getRest().get(path)),
  put: (path, body) => call("PUT", path, () => getRest().put(path, { body })),
});

/** Register `commandDefinitions` on the application when the live set differs. Returns what happened. */
export async function registerCommands(rest: CommandsRest = defaultRest()): Promise<"skipped" | "up-to-date" | "registered"> {
  if (!(await settings.getBool("commands_register"))) {
    log.info("commands_register is off, skipping command registration");
    return "skipped";
  }
  if (!env.discordToken || !env.discordAppId) {
    log.warn("DISCORD_TOKEN or DISCORD_APP_ID empty, skipping command registration");
    return "skipped";
  }
  const path = Routes.applicationCommands(env.discordAppId);
  const live = (await rest.get(path)) as CommandShape[];
  if (!commandsDiffer(live, commandDefinitions)) {
    log.info("commands up to date");
    return "up-to-date";
  }
  await rest.put(path, commandDefinitions);
  log.info(`registered ${commandDefinitions.length} commands`);
  return "registered";
}
