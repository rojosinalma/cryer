import { Hono } from "hono";
import { ValidationError } from "../lib/errors.ts";
import { errorResponse, jsonOk } from "../lib/http.ts";
import { adapterFor, knownSources } from "../lib/ingest/index.ts";
import { logger } from "../lib/log.ts";
import { notify } from "../lib/prompts.ts";

export const ingest = new Hono();

ingest.post("/ingest/:source", async (c) => {
  const source = c.req.param("source");
  try {
    const adapter = adapterFor(source);
    if (!adapter) throw new ValidationError(`unknown ingest source "${source}" (known: ${knownSources().join(", ")})`, 404);
    const body = await c.req.json().catch(() => {
      throw new ValidationError("body must be JSON");
    });
    const input = await adapter.parse(body);
    const result = await notify(input);
    logger(`ingest:${source}`).info(`posted ${result.id} level=${input.level}`);
    return jsonOk(c, "posted", { ...result }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});
