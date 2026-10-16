// Callback registry: one kind per file. Adding a kind = one file + one line here (+ the Zod union).

import type { CallbackSpec } from "../types.ts";
import { http } from "./http.ts";
import { opencodeSession } from "./opencode-session.ts";
import type { CallbackContext, CallbackHandler } from "./types.ts";

export const callbacks: Readonly<Record<CallbackSpec["kind"], CallbackHandler>> = Object.freeze({
  http: http as CallbackHandler,
  "opencode-session": opencodeSession as CallbackHandler,
});

export const callbackFor = (kind: CallbackSpec["kind"]): CallbackHandler => callbacks[kind];

export const validateCallback = (spec: CallbackSpec) => callbackFor(spec.kind).validate(spec);
export const deliverCallback = (spec: CallbackSpec, ctx: CallbackContext) => callbackFor(spec.kind).deliver(spec, ctx);

export type { CallbackContext, CallbackHandler } from "./types.ts";
