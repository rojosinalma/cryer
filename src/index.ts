// Entry point. Bun auto-loads ./.env from the cwd before any import runs.

import { runMigrations } from "./db/migrate.ts";
import { createApp } from "./app.ts";
import { env, storeKind } from "./lib/env.ts";
import { logger, setLevel } from "./lib/log.ts";
import { sweepExpired } from "./lib/prompts.ts";
import { queue } from "./lib/queue.ts";
import { settings, watchLogLevel } from "./lib/settings.ts";
import { getStore } from "./lib/store.ts";
import { startGateway, stopGateway } from "./lib/transports/gateway.ts";
import { version } from "./version.ts";

const log = logger("http");
const SWEEP_MS = 60_000;
const SETTINGS_REFRESH_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

setLevel(env.logLevel);
log.info(`cryer ${version} starting (store=${storeKind()})`);

const store = getStore();
await runMigrations(store);
await settings.seed();
let maxQueue = await settings.getInt("max_queue");
queue.setMax(() => maxQueue);
watchLogLevel();
const refresh = setInterval(async () => (maxQueue = await settings.getInt("max_queue")), SETTINGS_REFRESH_MS);
refresh.unref?.();

let sweeping = false;
const sweeper = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweepExpired();
  } catch (err) {
    log.warn(`expiry sweep failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    sweeping = false;
  }
}, SWEEP_MS);
sweeper.unref?.();

const app = createApp();
const server = Bun.serve({ port: env.port, hostname: "0.0.0.0", fetch: app.fetch, idleTimeout: 255 });
log.info(`listening on http://0.0.0.0:${server.port}`);

// Leader-only websocket for reaction/reply answers; gateway_enabled, lease ttl/renew come from settings.
startGateway();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info(`${sig}: shutting down`);
    clearInterval(sweeper);
    clearInterval(refresh);
    server.stop();
    // Release the gateway lease first so the other replica takes over at its next poll instead of after the ttl.
    const grace = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    grace.unref?.();
    stopGateway()
      .catch((err) => log.warn(`gateway stop failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => {
        store.close();
        process.exit(0);
      });
  });
}
