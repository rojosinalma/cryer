import type { NotifyInput } from "../types.ts";

export interface IngestAdapter {
  /** Turn a raw JSON body into a notify input; throw ValidationError on a bad payload. */
  parse(body: unknown): NotifyInput | Promise<NotifyInput>;
}

/** True for a parseable `http://` or `https://` URL; adapters ignore anything else silently. */
export const isHttpUrl = (v: string | undefined): v is string =>
  Boolean(v && /^https?:\/\//i.test(v) && URL.canParse(v));
