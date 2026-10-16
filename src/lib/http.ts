import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { SystemError, ValidationError } from "./errors.ts";
import { env } from "./env.ts";
import { logger } from "./log.ts";

const log = logger("http");

export const jsonOk = (c: Context, message: string, data: Record<string, unknown> = {}, status = 200) =>
  c.json({ ok: true, message, ...data }, status as 200);

export const jsonErr = (
  c: Context,
  message: string,
  kind: "validation" | "system",
  status: number,
  data: Record<string, unknown> = {},
) => c.json({ ok: false, message, kind, ...data }, status as 400);

/** Turns a thrown error into the standard {ok:false} shape; unknown errors are system errors. */
export function errorResponse(c: Context, err: unknown) {
  if (err instanceof ValidationError) return jsonErr(c, err.message, "validation", err.status, err.data);
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    return jsonErr(c, `invalid request: ${issues.join("; ")}`, "validation", 400, { issues });
  }
  if (err instanceof SystemError) {
    log.warn(`${c.req.method} ${c.req.path} -> ${err.status} ${err.message}`);
    return jsonErr(c, err.message, "system", err.status, err.data);
  }
  log.error(`${c.req.method} ${c.req.path} unhandled`, err);
  const message = err instanceof Error ? err.message : String(err);
  return jsonErr(c, message, "system", 500);
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep timing flat, then fail
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export const bearerToken = (header: string | undefined) =>
  header?.startsWith("Bearer ") ? header.slice(7).trim() : null;

export const isAuthorized = (header: string | undefined, token = env.apiToken) => {
  const got = bearerToken(header);
  return Boolean(token) && got !== null && safeEqual(got, token);
};

/** Fail-closed bearer middleware for API, MCP and ingest. */
export const requireBearer = (token = env.apiToken): MiddlewareHandler =>
  async (c, next) => {
    if (!isAuthorized(c.req.header("authorization"), token)) {
      return jsonErr(c, "unauthorized: missing or invalid bearer token", "validation", 401);
    }
    await next();
  };

/** Name of the query parameter that may carry the API token on /ingest/* (webhook senders without header support). */
export const TOKEN_QUERY_PARAM = "token";

export const isQueryTokenAuthorized = (queryToken: string | undefined, token = env.apiToken) =>
  Boolean(token) && typeof queryToken === "string" && queryToken !== "" && safeEqual(queryToken, token);

/**
 * Ingest-only auth: bearer header OR `?token=` — for senders like dagu's webhook channel that cannot
 * set headers. Never mounted outside /ingest/*; the token never reaches a log (see redactQuery).
 */
export const requireBearerOrQueryToken = (token = env.apiToken): MiddlewareHandler =>
  async (c, next) => {
    if (!isAuthorized(c.req.header("authorization"), token) && !isQueryTokenAuthorized(c.req.query(TOKEN_QUERY_PARAM), token)) {
      return jsonErr(c, "unauthorized: missing or invalid bearer token (header or ?token=)", "validation", 401);
    }
    await next();
  };

/** Query string with the token value masked, for logs. Empty string when there is no query. */
export function redactQuery(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return "";
  const params = new URLSearchParams(url.slice(q + 1));
  if (!params.has(TOKEN_QUERY_PARAM)) return url.slice(q);
  params.set(TOKEN_QUERY_PARAM, "***");
  return "?" + params.toString();
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  const ms = (performance.now() - start).toFixed(1);
  log.debug(`${c.req.method} ${c.req.path}${redactQuery(c.req.url)} -> ${c.res.status} ${ms}ms`);
};
