// Imported FIRST by every test file: sets env before src/lib/env.ts is evaluated, then exposes
// helpers (in-memory store, fake Discord client, Ed25519 signing for /interactions).

// Fixed test-only Ed25519 keypair (never used anywhere real). process.env must be set synchronously,
// before the first `await`, because sibling imports do not wait for this module's top-level await.
const TEST_PRIVATE_JWK = {
  alg: "Ed25519",
  crv: "Ed25519",
  d: "wPemqDf_XQIvtC23pIM0vBPeOkExJAQGEnm3ail6_I4",
  ext: true,
  key_ops: ["sign"],
  kty: "OKP",
  x: "mtdFLULkoVTccn2JAw5YIWHHA9BhR3ZP7lGTzzoRcWk",
};
export const TEST_PUBLIC_KEY = "9ad7452d42e4a154dc727d89030e582161c703d06147764fee5193cf3a117169";
export const TEST_TOKEN = "test-token-123";
export const TEST_CHANNEL = "111111111111111111";

process.env.DISCORD_PUBLIC_KEY = TEST_PUBLIC_KEY;
process.env.DISCORD_TOKEN = "dummy";
process.env.DISCORD_APP_ID = "222222222222222222";
process.env.CRYER_API_TOKEN = TEST_TOKEN;
process.env.DEFAULT_CHANNEL_ID = TEST_CHANNEL;
process.env.OPENCODE_URL = "http://opencode.test:4096";
process.env.OPENCODE_SERVER_PASSWORD = "pw";
process.env.LOG_LEVEL = process.env.CRYER_TEST_LOG || "error";
delete process.env.RQLITE_URLS;

const privateKey = await crypto.subtle.importKey("jwk", TEST_PRIVATE_JWK, "Ed25519", false, ["sign"]);

const { runMigrations } = await import("../src/db/migrate.ts");
const { openSqlite, setStore } = await import("../src/lib/store.ts");
const { settings } = await import("../src/lib/settings.ts");
const { setDiscordClient } = await import("../src/lib/discord.ts");
type DiscordClient = import("../src/lib/discord.ts").DiscordClient;
const { setLevel } = await import("../src/lib/log.ts");
setLevel(process.env.LOG_LEVEL);

export async function freshStore() {
  const store = openSqlite(":memory:");
  await runMigrations(store);
  setStore(store);
  settings.clearCache();
  await settings.seed();
  await settings.set("wait_poll_ms", "10");
  setLevel(process.env.LOG_LEVEL!);
  return store;
}

export interface FakeDiscord extends DiscordClient {
  posts: { channelId: string; payload: unknown }[];
  edits: { channelId: string; messageId: string; payload: unknown }[];
  reactions: { channelId: string; messageId: string; emoji: string }[];
  failPost?: boolean;
}

export function fakeDiscord(): FakeDiscord {
  let n = 0;
  const fake: FakeDiscord = {
    posts: [],
    edits: [],
    reactions: [],
    async postMessage(channelId, payload) {
      if (fake.failPost) throw new Error("discord down");
      fake.posts.push({ channelId, payload });
      return { id: `msg${++n}`, channel_id: channelId } as never;
    },
    async editMessage(channelId, messageId, payload) {
      fake.edits.push({ channelId, messageId, payload });
      return { id: messageId, channel_id: channelId } as never;
    },
    async getChannel(channelId) {
      return { id: channelId, guild_id: "999" } as never;
    },
    async addReaction(channelId, messageId, emoji) {
      fake.reactions.push({ channelId, messageId, emoji });
    },
  };
  setDiscordClient(fake);
  return fake;
}

export async function sign(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const sig = await crypto.subtle.sign("Ed25519", privateKey, Buffer.from(timestamp + body));
  return { signature: Buffer.from(sig).toString("hex"), timestamp };
}

export async function signedRequest(url: string, payload: unknown, tamper?: (h: Record<string, string>) => void) {
  const body = JSON.stringify(payload);
  const { signature, timestamp } = await sign(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestamp,
  };
  tamper?.(headers);
  return new Request(url, { method: "POST", headers, body });
}

export const authed = (url: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}`, ...(init.headers as Record<string, string>) },
  });
