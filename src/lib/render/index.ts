// Renderer registry: one file per notification type; unknown types fall back to generic.

import { generic } from "./generic.ts";
import type { Renderer } from "./types.ts";

export const renderers: Readonly<Record<string, Renderer>> = Object.freeze({
  generic,
});

export const rendererFor = (type: string): Renderer => renderers[type] ?? generic;

export * from "./types.ts";
export * from "./buttons.ts";
