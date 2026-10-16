import { Hono } from "hono";
import { z } from "zod";
import { PROMPT_STATUSES } from "../db/schema.ts";
import { errorResponse, jsonOk } from "../lib/http.ts";
import { cancelPrompt, createPrompt, listPrompts, promptView, requirePrompt, waitForAnswer } from "../lib/prompts.ts";
import { settings } from "../lib/settings.ts";
import { promptSchema } from "../lib/types.ts";

export const prompts = new Hono();

const listQuery = z.object({
  status: z.enum(PROMPT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const waitQuery = z.object({ timeout: z.coerce.number().min(0).optional() });

prompts.post("/prompts", async (c) => {
  try {
    const input = promptSchema.parse(await c.req.json());
    const result = await createPrompt(input);
    return jsonOk(c, "prompt posted", { ...result }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

prompts.get("/prompts", async (c) => {
  try {
    const q = listQuery.parse(c.req.query());
    const items = await listPrompts(q.status, q.limit);
    return jsonOk(c, `${items.length} prompt(s)`, { prompts: items });
  } catch (err) {
    return errorResponse(c, err);
  }
});

prompts.get("/prompts/:id", async (c) => {
  try {
    const view = await promptView(await requirePrompt(c.req.param("id")));
    return jsonOk(c, view.status, { prompt: view });
  } catch (err) {
    return errorResponse(c, err);
  }
});

prompts.get("/prompts/:id/wait", async (c) => {
  try {
    const q = waitQuery.parse(c.req.query());
    const timeout = q.timeout ?? (await settings.getInt("ask_wait_max_s"));
    const result = await waitForAnswer(c.req.param("id"), timeout);
    return jsonOk(c, result.status, { id: c.req.param("id"), status: result.status, answer: result.answer });
  } catch (err) {
    return errorResponse(c, err);
  }
});

prompts.post("/prompts/:id/cancel", async (c) => {
  try {
    const p = await cancelPrompt(c.req.param("id"));
    return jsonOk(c, "prompt cancelled", { id: p.id, status: p.status });
  } catch (err) {
    return errorResponse(c, err);
  }
});
