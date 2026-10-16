import { Hono } from "hono";
import { errorResponse, jsonOk } from "../lib/http.ts";
import { purge as runPurge } from "../lib/prompts.ts";
import { settings } from "../lib/settings.ts";

export const purge = new Hono();

purge.post("/purge", async (c) => {
  try {
    const days = await settings.getInt("purge_days");
    const counts = await runPurge(days);
    return jsonOk(c, `purged records older than ${days} days`, { days, ...counts });
  } catch (err) {
    return errorResponse(c, err);
  }
});
