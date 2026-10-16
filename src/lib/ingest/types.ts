import type { NotifyInput } from "../types.ts";

export interface IngestAdapter {
  /** Turn a raw JSON body into a notify input; throw ValidationError on a bad payload. */
  parse(body: unknown): NotifyInput | Promise<NotifyInput>;
}
