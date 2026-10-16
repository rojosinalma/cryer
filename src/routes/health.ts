import { Hono } from "hono";
import { env, storeKind } from "../lib/env.ts";
import { getStore } from "../lib/store.ts";
import { gatewayHealth } from "../lib/transports/gateway.ts";
import { version } from "../version.ts";

export const health = new Hono();

health.get("/health", async (c) => {
  try {
    const ok = await getStore().ping();
    if (!ok) throw new Error("store ping returned no row");
    // The gateway block is informational: a replica without the lease (or without the websocket) is still healthy.
    return c.json({ ok: true, store: storeKind(), app_id: env.discordAppId, version, gateway: await gatewayHealth() });
  } catch (err) {
    return c.json({ ok: false, message: `store unavailable: ${err instanceof Error ? err.message : err}` }, 503);
  }
});
