// Discord's endpoint. Signature over the RAW body is the only gate; 401 with an empty body on failure.

import { Hono } from "hono";
import type { APIInteraction } from "discord-api-types/v10";
import { logger } from "../lib/log.ts";
import { handleInteraction, verifySignature } from "../lib/transports/interactions.ts";

const log = logger("discord");

export const interactions = new Hono();

interactions.post("/interactions", async (c) => {
  const raw = await c.req.text();
  const ok = await verifySignature(raw, c.req.header("x-signature-ed25519"), c.req.header("x-signature-timestamp"));
  if (!ok) {
    log.warn("interaction with bad signature rejected");
    return c.body(null, 401);
  }
  let body: APIInteraction;
  try {
    body = JSON.parse(raw) as APIInteraction;
  } catch {
    return c.body(null, 400);
  }
  const response = await handleInteraction(body);
  log.debug(`interaction type=${body.type} -> response type=${response.type}`);
  return c.json(response);
});
