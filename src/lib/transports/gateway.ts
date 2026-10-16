// Gateway transport (v0.3.0): a discord.js websocket client on exactly one replica (the holder of the
// `gateway` lease) adding two answer paths for prompt messages — number reactions and replies. Both
// end in answerPrompt like buttons do; the HTTP interactions transport keeps running on every replica.
// Intents: Guilds, GuildMessages, GuildMessageReactions (+ MessageContent, a privileged toggle in the
// Developer Portal). Without that toggle Discord closes the socket with 4014; the client reconnects
// without it, reactions keep working and replies arrive with empty content (reply parsing off).

import { GatewayCloseCodes } from "discord-api-types/v10";
import { Client, DiscordjsErrorCodes, Events, GatewayIntentBits, Options, Partials } from "discord.js";
import { discord } from "../discord.ts";
import { env } from "../env.ts";
import { GATEWAY_LEASE, LeaseRunner, nodeName, readLease, type LeaseConfig } from "../lease.ts";
import { logger } from "../log.ts";
import { answerPrompt, editAnswered, emojiIndex, optionsOf, promptByMessageId } from "../prompts.ts";
import { settings } from "../settings.ts";
import type { Option } from "../types.ts";

const log = logger("gateway");

export const BASE_INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMessageReactions;
export const CONTENT_INTENT = GatewayIntentBits.MessageContent;

export const REACT_OK = "✅";
export const REACT_LATE = "⏱";

// ---------- client abstraction (tests inject a fake; nothing here opens a socket) ----------

export interface GatewayClient {
  on(event: string, listener: (...args: any[]) => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<unknown>;
  readonly user: { id: string; tag?: string } | null;
}

export type ClientFactory = (intents: number) => GatewayClient;

const MESSAGE_CACHE = 50;
const MEMBER_CACHE = 50;

export const realClientFactory: ClientFactory = (intents) =>
  new Client({
    intents,
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: MESSAGE_CACHE,
      GuildMemberManager: { maxSize: MEMBER_CACHE, keepOverLimit: (m) => m.id === m.client.user?.id },
      PresenceManager: 0,
      ThreadManager: 0,
      GuildScheduledEventManager: 0,
      StageInstanceManager: 0,
      VoiceStateManager: 0,
    }),
    sweepers: { ...Options.DefaultSweeperSettings, messages: { interval: 300, lifetime: 600 } },
  }) as unknown as GatewayClient;

// ---------- plain event shapes (what the handlers need; decoupled from discord.js structures) ----------

export interface ReactionEvent {
  messageId: string;
  channelId: string;
  emoji: string | null;
  user: { id: string; bot: boolean; name: string };
}

export interface ReplyEvent {
  id: string;
  channelId: string;
  content: string;
  /** Message id this one replies to (message.reference), null when not a reply. */
  referenceId: string | null;
  author: { id: string; bot: boolean; name: string };
}

export type Handled =
  | "answered"
  | "answered-free-text"
  | "lost"
  | "not-prompt"
  | "not-pending"
  | "not-reply"
  | "ignored-bot"
  | "ignored-emoji"
  | "ignored-option"
  | "no-content";

/**
 * Reply text → option index: exact id/label (case-insensitive), then a bare number 1–9, then an
 * unambiguous prefix of an id or label. null = free text.
 */
export function matchReply(content: string, options: readonly Option[]): number | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const c = norm(content);
  if (!c) return null;
  const exact = options.findIndex((o) => norm(o.id) === c || norm(o.label) === c);
  if (exact >= 0) return exact;
  if (/^[1-9]$/.test(c) && Number(c) <= options.length) return Number(c) - 1;
  const prefixed = options.map((o, i) => (norm(o.id).startsWith(c) || norm(o.label).startsWith(c) ? i : -1)).filter((i) => i >= 0);
  return prefixed.length === 1 ? prefixed[0]! : null;
}

async function react(channelId: string, messageId: string, emoji: string) {
  try {
    await discord().addReaction(channelId, messageId, emoji);
  } catch (err) {
    log.warn(`could not react ${emoji} on ${messageId}: ${err instanceof Error ? err.message : err}`);
  }
}

/** messageReactionAdd: a number emoji by a human on a pending prompt answers that option. */
export async function handleReaction(ev: ReactionEvent): Promise<Handled> {
  if (ev.user.bot) return "ignored-bot";
  const idx = emojiIndex(ev.emoji);
  if (idx === undefined) return "ignored-emoji";
  const prompt = await promptByMessageId(ev.messageId);
  if (!prompt) return "not-prompt";
  log.debug(`reaction ${ev.emoji} by ${ev.user.name} on prompt ${prompt.id} (${prompt.status})`);
  if (prompt.status !== "pending") return "not-pending";
  const option = optionsOf(prompt)[idx];
  if (!option || option.modal) return "ignored-option";
  const outcome = await answerPrompt(prompt.id, { idx, via: "reaction", userId: ev.user.id, userName: ev.user.name });
  if (!outcome.ok) return "lost"; // the winner's edit already shows the answer; no error for the loser
  await editAnswered(outcome);
  return "answered";
}

let warnedNoContent = false;

/** messageCreate: a human reply to a pending prompt answers an option (matched) or free text (unmatched). */
export async function handleReply(ev: ReplyEvent, contentEnabled: boolean): Promise<Handled> {
  if (ev.author.bot) return "ignored-bot";
  if (!ev.referenceId) return "not-reply";
  const prompt = await promptByMessageId(ev.referenceId);
  if (!prompt) return "not-prompt";
  log.debug(`reply by ${ev.author.name} to prompt ${prompt.id} (${prompt.status})`);
  if (prompt.status !== "pending") {
    await react(ev.channelId, ev.id, REACT_LATE);
    return "not-pending";
  }
  const content = ev.content.trim();
  if (!contentEnabled || !content) {
    if (!warnedNoContent) {
      warnedNoContent = true;
      log.warn(`reply to prompt ${prompt.id} ignored: message content unavailable (Message Content intent not granted?)`);
    }
    return "no-content";
  }
  const idx = matchReply(content, optionsOf(prompt));
  const outcome = await answerPrompt(prompt.id, { idx, text: content, via: "reply", userId: ev.author.id, userName: ev.author.name });
  if (!outcome.ok) {
    await react(ev.channelId, ev.id, REACT_LATE);
    return "lost";
  }
  await react(ev.channelId, ev.id, REACT_OK);
  await editAnswered(outcome);
  return idx === null ? "answered-free-text" : "answered";
}

// ---------- discord.js event → plain event ----------

type DjsUser = { id: string; bot?: boolean | null; globalName?: string | null; username?: string | null } | null | undefined;
const nameOf = (u: DjsUser) => u?.globalName || u?.username || "unknown";

const toReactionEvent = (reaction: any, user: any): ReactionEvent => ({
  messageId: String(reaction.message.id),
  channelId: String(reaction.message.channelId),
  emoji: reaction.emoji?.name ?? null,
  user: { id: String(user.id), bot: Boolean(user.bot), name: nameOf(user) },
});

const toReplyEvent = (message: any): ReplyEvent => ({
  id: String(message.id),
  channelId: String(message.channelId),
  content: String(message.content ?? ""),
  referenceId: message.reference?.messageId ? String(message.reference.messageId) : null,
  author: { id: String(message.author?.id ?? "0"), bot: Boolean(message.author?.bot), name: nameOf(message.author) },
});

// ---------- the transport ----------

export class DisallowedIntentsError extends Error {
  constructor() {
    super("Discord refused the requested intents (4014)");
  }
}

const isDisallowed = (err: unknown) =>
  err instanceof DisallowedIntentsError || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === DiscordjsErrorCodes.DisallowedIntents);

export interface GatewayOptions {
  factory?: ClientFactory;
  token?: string;
  holder?: string;
  config?: () => Promise<LeaseConfig>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const settingsConfig = async (): Promise<LeaseConfig> => ({
  enabled: await settings.getBool("gateway_enabled"),
  ttlS: await settings.getInt("gateway_lease_ttl_s"),
  renewS: await settings.getInt("gateway_lease_renew_s"),
});

export class Gateway {
  readonly runner: LeaseRunner;
  private client: GatewayClient | null = null;
  private connected = false;
  private contentEnabled = false;
  private readonly factory: ClientFactory;
  private readonly token: string;
  private readonly config: () => Promise<LeaseConfig>;

  constructor(opts: GatewayOptions = {}) {
    this.factory = opts.factory ?? realClientFactory;
    this.token = opts.token ?? env.discordToken;
    this.config = opts.config ?? settingsConfig;
    this.runner = new LeaseRunner({
      name: GATEWAY_LEASE,
      holder: opts.holder ?? nodeName(),
      config: this.config,
      onLeader: () => this.connectAsLeader(),
      onFollower: () => this.disconnect(),
      now: opts.now,
      sleep: opts.sleep,
    });
  }

  get isLeader() {
    return this.runner.isLeader;
  }
  get isConnected() {
    return this.connected;
  }
  /** False while running without the MessageContent intent (replies arrive without text). */
  get replyParsing() {
    return this.connected && this.contentEnabled;
  }
  get holder() {
    return this.runner.holder;
  }

  start() {
    if (!this.token) {
      log.warn("DISCORD_TOKEN unset: gateway transport not started");
      return;
    }
    void this.runner.start();
  }

  async stop() {
    await this.runner.stop();
  }

  /** Try with MessageContent first; on 4014 reconnect without it and run with reply parsing off. */
  private async connectAsLeader() {
    const cfg = await this.config();
    const timeoutMs = Math.max(cfg.ttlS, 5) * 1000;
    try {
      await this.connect(true, timeoutMs);
    } catch (err) {
      await this.disconnect();
      if (!isDisallowed(err)) throw err;
      log.warn(
        "Message Content is a privileged intent and is not enabled for this application (Developer Portal → Bot → " +
          "Privileged Gateway Intents); reconnecting without it: reactions work, reply parsing is OFF",
      );
      try {
        await this.connect(false, timeoutMs);
      } catch (err2) {
        await this.disconnect();
        throw err2;
      }
    }
  }

  private connect(withContent: boolean, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const intents = withContent ? BASE_INTENTS | CONTENT_INTENT : BASE_INTENTS;
      const client = this.factory(intents);
      this.client = client;
      this.connected = false;
      this.contentEnabled = withContent;
      warnedNoContent = false;
      let settled = false;
      const timer = setTimeout(() => settle(() => reject(new Error(`no READY from Discord within ${timeoutMs}ms`))), timeoutMs);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      client.on(Events.ClientReady, () => {
        this.connected = true;
        log.info(`connected as ${client.user?.tag ?? client.user?.id ?? "?"} (reply parsing ${withContent ? "on" : "off"})`);
        settle(resolve);
      });
      client.on(Events.ShardDisconnect, (ev: { code?: number }) => {
        if (ev?.code === GatewayCloseCodes.DisallowedIntents) {
          settle(() => reject(new DisallowedIntentsError()));
          return;
        }
        log.warn(`disconnected for good (close code ${ev?.code ?? "?"})`);
        settle(() => reject(new Error(`gateway closed with ${ev?.code}`)));
        void this.runner.abdicate(`gateway closed with ${ev?.code}`);
      });
      client.on(Events.Invalidated, () => {
        log.warn("session invalidated by Discord");
        settle(() => reject(new Error("session invalidated")));
        void this.runner.abdicate("session invalidated");
      });
      client.on(Events.Error, (err: unknown) => log.error("client error", err));
      client.on(Events.ShardError, (err: unknown) => log.warn(`shard error: ${err instanceof Error ? err.message : err}`));
      client.on(Events.Warn, (msg: string) => log.debug(`warn: ${msg}`));
      client.on(Events.MessageReactionAdd, (reaction: unknown, user: unknown) => {
        handleReaction(toReactionEvent(reaction, user))
          .then((r) => log.debug(`messageReactionAdd -> ${r}`))
          .catch((err) => log.error("messageReactionAdd failed", err));
      });
      client.on(Events.MessageCreate, (message: unknown) => {
        handleReply(toReplyEvent(message), this.contentEnabled)
          .then((r) => r !== "not-reply" && r !== "ignored-bot" && log.debug(`messageCreate -> ${r}`))
          .catch((err) => log.error("messageCreate failed", err));
      });

      client.login(this.token).catch((err: unknown) => settle(() => reject(isDisallowed(err) ? new DisallowedIntentsError() : err)));
    });
  }

  private async disconnect() {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (!client) return;
    try {
      await client.destroy();
      log.info("disconnected");
    } catch (err) {
      log.warn(`destroy failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ---------- singleton for index.ts / health ----------

let current: Gateway | null = null;

export function startGateway(opts: GatewayOptions = {}): Gateway {
  current ??= new Gateway(opts);
  current.start();
  return current;
}

export async function stopGateway() {
  await current?.stop();
  current = null;
}

export interface GatewayHealth {
  enabled: boolean;
  leader: boolean;
  holder: string | null;
  connected: boolean;
  reply_parsing: boolean;
}

/** For /health: never throws (the gateway is a capability, not liveness). */
export async function gatewayHealth(): Promise<GatewayHealth> {
  let enabled = false;
  let holder: string | null = null;
  try {
    enabled = await settings.getBool("gateway_enabled");
    const lease = await readLease(GATEWAY_LEASE);
    if (lease && lease.expires_at > new Date().toISOString()) holder = lease.holder;
  } catch (err) {
    log.debug(`health lease read failed: ${err instanceof Error ? err.message : err}`);
  }
  return {
    enabled,
    leader: current?.isLeader ?? false,
    holder,
    connected: current?.isConnected ?? false,
    reply_parsing: current?.replyParsing ?? false,
  };
}
