// Environment: read once, defaults applied. Bun loads ./.env automatically before this runs.

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : def;
};

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const env = {
  port: num(process.env.PORT, 7474),
  dataDir: process.env.DATA_DIR || "./data",
  rqliteUrls: list(process.env.RQLITE_URLS).map((u) => u.replace(/\/+$/, "")),
  discordToken: process.env.DISCORD_TOKEN ?? "",
  discordAppId: process.env.DISCORD_APP_ID ?? "",
  discordPublicKey: process.env.DISCORD_PUBLIC_KEY ?? "",
  apiToken: process.env.CRYER_API_TOKEN ?? "",
  opencodeUrl: (process.env.OPENCODE_URL || "").replace(/\/+$/, ""),
  opencodeUsername: process.env.OPENCODE_SERVER_USERNAME || "opencode",
  opencodePassword: process.env.OPENCODE_SERVER_PASSWORD ?? "",
  defaultChannelId: process.env.DEFAULT_CHANNEL_ID ?? "",
  logLevel: process.env.LOG_LEVEL || "info",
} as const;

export const storeKind = (): "rqlite" | "sqlite" => (env.rqliteUrls.length ? "rqlite" : "sqlite");
