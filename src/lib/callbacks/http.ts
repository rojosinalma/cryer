// http callback: POST/PUT the answer JSON to an allowlisted URL, 10 s timeout, 3 tries.

import { ValidationError } from "../errors.ts";
import { logger } from "../log.ts";
import { settings } from "../settings.ts";
import type { httpCallbackSchema } from "../types.ts";
import type { z } from "zod";
import { parseAllowlist, urlAllowed } from "./allowlist.ts";
import type { CallbackHandler } from "./types.ts";

const log = logger("callback");

type HttpSpec = z.infer<typeof httpCallbackSchema>;

export const HTTP_TIMEOUT_MS = 10_000;
export const HTTP_ATTEMPTS = 3;
const backoffMs = (attempt: number) => 500 * 2 ** attempt;

export const http: CallbackHandler<HttpSpec> = {
  async validate(spec) {
    const allow = parseAllowlist(await settings.get("callback_allowlist"));
    if (!urlAllowed(spec.url, allow)) {
      throw new ValidationError(`callback url host is not in callback_allowlist (${allow.join(", ")})`, 422);
    }
  },

  async deliver(spec, ctx) {
    const payload = {
      ...(spec.body ?? {}),
      prompt_id: ctx.promptId,
      title: ctx.title,
      ...ctx.answer,
    };
    const path = new URL(spec.url).pathname;
    let lastErr: unknown;
    for (let attempt = 0; attempt < HTTP_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(spec.url, {
          method: spec.method,
          headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        log.info(`${spec.method} ${path} -> ${res.status} (prompt ${ctx.promptId})`);
        if (res.ok) return;
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500) break;
      } catch (err) {
        lastErr = err;
        log.warn(`${spec.method} ${path} attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : err}`);
      }
      if (attempt < HTTP_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
    throw new Error(`http callback to ${path} failed: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  },
};
