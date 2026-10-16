// Ingest registry: POST /ingest/<source> → adapters[source]. One adapter per file.

import { apprise } from "./apprise.ts";
import { dagu } from "./dagu.ts";
import type { IngestAdapter } from "./types.ts";

export const adapters: Readonly<Record<string, IngestAdapter>> = Object.freeze({
  apprise,
  dagu,
});

export const knownSources = () => Object.keys(adapters);
export const adapterFor = (source: string): IngestAdapter | undefined => adapters[source];

export type { IngestAdapter } from "./types.ts";
