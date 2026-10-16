import { Hono } from "hono";
import { errorResponse, jsonOk } from "../lib/http.ts";
import { notify as sendNotify } from "../lib/prompts.ts";
import { notifySchema } from "../lib/types.ts";

export const notify = new Hono();

notify.post("/notify", async (c) => {
  try {
    const input = notifySchema.parse(await c.req.json());
    const result = await sendNotify(input);
    return jsonOk(c, "posted", { ...result }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});
