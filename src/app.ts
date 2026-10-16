import { Hono } from "hono";
import { requestLogger, requireBearer, requireBearerOrQueryToken } from "./lib/http.ts";
import { mountMcp } from "./mcp.ts";
import { health } from "./routes/health.ts";
import { ingest } from "./routes/ingest.ts";
import { interactions } from "./routes/interactions.ts";
import { notify } from "./routes/notify.ts";
import { prompts } from "./routes/prompts.ts";
import { purge } from "./routes/purge.ts";
import { settingsRoutes } from "./routes/settings.ts";

export function createApp(opts: { apiToken?: string } = {}) {
  const app = new Hono();
  app.use(requestLogger);

  // Unauthenticated: health probe and Discord's signed endpoint.
  app.route("/", health);
  app.route("/", interactions);

  // Ingest: bearer header OR ?token= (webhook senders that cannot set headers). Only here.
  const ingestApi = new Hono();
  ingestApi.use("/ingest/*", requireBearerOrQueryToken(opts.apiToken));
  ingestApi.route("/", ingest);
  app.route("/", ingestApi);

  // Everything else: bearer, fail closed.
  const api = new Hono();
  api.use(requireBearer(opts.apiToken));
  api.route("/", notify);
  api.route("/", prompts);
  api.route("/", settingsRoutes);
  api.route("/", purge);
  mountMcp(api);
  app.route("/", api);

  app.notFound((c) => c.json({ ok: false, message: `no route ${c.req.method} ${c.req.path}`, kind: "validation" }, 404));
  return app;
}
