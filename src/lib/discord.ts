// Discord REST wrapper: every call logged method/path/outcome.

import { REST, DiscordAPIError, HTTPError } from "@discordjs/rest";
import {
  Routes,
  type APIChannel,
  type APIMessage,
  type RESTPatchAPIChannelMessageJSONBody,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import { env } from "./env.ts";
import { SystemError } from "./errors.ts";
import { logger } from "./log.ts";

const log = logger("discord");

export type MessagePayload = RESTPostAPIChannelMessageJSONBody;
export type EditPayload = RESTPatchAPIChannelMessageJSONBody;

export interface DiscordClient {
  postMessage(channelId: string, payload: MessagePayload): Promise<APIMessage>;
  editMessage(channelId: string, messageId: string, payload: EditPayload): Promise<APIMessage>;
  getChannel(channelId: string): Promise<APIChannel>;
  /** React as the bot; `emoji` is the unicode emoji (or `name:id` for a custom one). */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Open (or fetch) the bot's DM channel with a user; Discord returns the same channel on every call. */
  createDm(userId: string): Promise<APIChannel>;
}

/** Discord error codes that mean "this user cannot be DMed" (app not installed / no mutual server / DMs closed). */
export const DM_REFUSED_CODES: Readonly<Record<number, string>> = Object.freeze({
  50007: "the user has DMs from this app closed or shares no server with it",
  50278: "the user has not installed the app and shares no server with it",
});

const dmRefusal = (err: DiscordAPIError, userId: string | undefined) => {
  const why = userId !== undefined && typeof err.code === "number" ? DM_REFUSED_CODES[err.code] : undefined;
  return why ? `discord refuses DMs to user ${userId} (code ${err.code}): ${why}` : undefined;
};

let rest: REST | null = null;
/** Shared authenticated REST instance (other modules add their own endpoints on top of it via `call`). */
export const getRest = () => (rest ??= new REST({ version: "10", timeout: 10_000 }).setToken(env.discordToken));

/** Run one REST call with the standard `[discord] METHOD path -> outcome` log line; errors become SystemError 502. */
export async function call<T>(
  method: string,
  path: string,
  fn: () => Promise<unknown>,
  opts: { dmUserId?: string } = {},
): Promise<T> {
  try {
    const result = (await fn()) as T;
    log.info(`${method} ${path} -> ok`);
    return result;
  } catch (err) {
    if (err instanceof DiscordAPIError) {
      log.warn(`${method} ${path} -> ${err.status} ${err.code} ${err.message}`);
      const refused = dmRefusal(err, opts.dmUserId);
      if (refused) throw new SystemError(refused, 502, { code: err.code, user_id: opts.dmUserId });
      throw new SystemError(`discord ${method} ${path}: ${err.status} ${err.message}`, 502);
    }
    if (err instanceof HTTPError) {
      log.warn(`${method} ${path} -> ${err.status} ${err.message}`);
      throw new SystemError(`discord ${method} ${path}: ${err.status} ${err.message}`, 502);
    }
    log.warn(`${method} ${path} -> failed`, err);
    throw new SystemError(`discord ${method} ${path}: ${err instanceof Error ? err.message : err}`, 502);
  }
}

export const restClient: DiscordClient = {
  postMessage: (channelId, body) =>
    call("POST", Routes.channelMessages(channelId), () => getRest().post(Routes.channelMessages(channelId), { body })),
  editMessage: (channelId, messageId, body) =>
    call("PATCH", Routes.channelMessage(channelId, messageId), () =>
      getRest().patch(Routes.channelMessage(channelId, messageId), { body }),
    ),
  getChannel: (channelId) => call("GET", Routes.channel(channelId), () => getRest().get(Routes.channel(channelId))),
  addReaction: (channelId, messageId, emoji) => {
    const path = Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji));
    return call("PUT", path, () => getRest().put(path));
  },
  createDm: (userId) =>
    call("POST", Routes.userChannels(), () => getRest().post(Routes.userChannels(), { body: { recipient_id: userId } }), {
      dmUserId: userId,
    }),
};

let client: DiscordClient = restClient;
export const discord = (): DiscordClient => client;
/** Tests swap in a fake. */
export const setDiscordClient = (c: DiscordClient | null) => (client = c ?? restClient);

const GUILD_CACHE_MAX = 200;
const guildByChannel = new Map<string, string>();

/** Guild id of a channel (needed for message links); cached, bounded, "@me" when unknown. */
export async function guildOf(channelId: string): Promise<string> {
  const hit = guildByChannel.get(channelId);
  if (hit) return hit;
  try {
    const ch = await client.getChannel(channelId);
    const guildId = ("guild_id" in ch && ch.guild_id) || "@me";
    if (guildByChannel.size >= GUILD_CACHE_MAX) guildByChannel.delete(guildByChannel.keys().next().value!);
    guildByChannel.set(channelId, guildId);
    return guildId;
  } catch {
    return "@me";
  }
}

export const messageUrl = (guildId: string, channelId: string, messageId: string) =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
