import { Hono } from "hono";
import { z } from "zod";
import { errorResponse, jsonOk } from "../lib/http.ts";
import { settings as store } from "../lib/settings.ts";

export const settingsRoutes = new Hono();

const keySchema = z.string().regex(/^[a-z0-9_.*-]{1,128}$/i, "key may contain letters, digits, . _ - *");
const putSchema = z.object({ value: z.string().max(4096) });

settingsRoutes.get("/settings", async (c) => {
  try {
    return jsonOk(c, "settings", { settings: await store.all() });
  } catch (err) {
    return errorResponse(c, err);
  }
});

settingsRoutes.get("/settings/:key", async (c) => {
  try {
    const key = keySchema.parse(c.req.param("key"));
    const value = await store.getOrThrow(key);
    return jsonOk(c, value === null ? "unset" : "set", { key, value });
  } catch (err) {
    return errorResponse(c, err);
  }
});

settingsRoutes.put("/settings/:key", async (c) => {
  try {
    const key = keySchema.parse(c.req.param("key"));
    const { value } = putSchema.parse(await c.req.json());
    await store.set(key, value);
    return jsonOk(c, "saved", { key, value });
  } catch (err) {
    return errorResponse(c, err);
  }
});
