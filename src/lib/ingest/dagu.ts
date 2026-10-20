// dagu notification webhook → notification with source "dagu" (+ a Retry button on failed/aborted runs).
//
// Preferred payload — set as the dagu channel `bodyTemplate` (see docs/ingest.md). dagu renders
// `{{token}}` from internal/service/notification/service.go notificationTemplateValues() and
// JSON-escapes every value, one request per event:
//
//   {"source":"dagu","dag":"{{dag.name}}","status":"{{run.status}}","error":"{{run.error}}",
//    "run_id":"{{run.id}}","link":"{{run.url}}","event":"{{event.type}}",
//    "failed_steps":"{{run.failed_steps}}","started_at":"{{run.startedAt}}","finished_at":"{{run.finishedAt}}",
//    "message":"{{message}}"}
//
// run.status values (internal/ir/status.go): not_started running failed aborted succeeded queued
// partially_succeeded waiting rejected. run.url is empty unless dagu's server.publicURL is set.
//
// Retry: when status is failed|aborted and both dag and run_id are present, the embed carries a "Retry run"
// button whose http callback hits dagu's `POST /api/v1/dag-runs/{name}/{dagRunId}/retry` with
// {dagRunId} (api/v1/api.yaml → operationId retryDAGRun). The dagu base URL is the `dagu_url` setting;
// while it is empty (the default) the notification posts without the button.
//
// Fallback (live behaviour before v0.2.0): any other JSON object — title from name|dag_name|dagName|dag,
// level from status, the remaining scalar keys become fields.

import { z } from "zod";
import { logger } from "../log.ts";
import { settings } from "../settings.ts";
import { notifySchema, type Field, type Level, type NotifyInput, type Option } from "../types.ts";
import { isHttpUrl, type IngestAdapter } from "./types.ts";

const log = logger("ingest:dagu");

const TITLE_KEYS = ["name", "dag_name", "dagName", "dag"] as const;
const FAILURE = new Set(["failed", "error", "aborted", "rejected", "cancelled", "canceled"]);
const SUCCESS = new Set(["success", "succeeded", "finished", "completed", "partially_succeeded"]);
const RETRYABLE = new Set(["failed", "aborted"]);

export const RETRY_ACTION_ID = "retry";
export const RETRY_ACTION_LABEL = "Retry run";

export function levelFromStatus(status: unknown): Level {
  const s = String(status ?? "").toLowerCase();
  if (FAILURE.has(s)) return "failure";
  if (SUCCESS.has(s)) return "success";
  return "warning";
}

/** The v2 shape: `dag` and `status` identify it; everything else optional. Empty strings = absent. */
const blank = z.string().trim().optional().transform((v) => (v ? v : undefined));
export const daguV2Schema = z.object({
  source: z.literal("dagu").optional(),
  dag: z.string().trim().min(1),
  status: z.string().trim().min(1),
  error: blank,
  run_id: blank,
  link: blank,
  event: blank,
  failed_steps: blank,
  started_at: blank,
  finished_at: blank,
  message: blank,
});
export type DaguV2 = z.infer<typeof daguV2Schema>;

const objectSchema = z.record(z.string(), z.unknown());

/** dagu's retry endpoint for a run: POST /api/v1/dag-runs/{name}/{dagRunId}/retry {dagRunId}. */
export const retryUrl = (base: string, dag: string, runId: string) =>
  `${base.replace(/\/+$/, "")}/api/v1/dag-runs/${encodeURIComponent(dag)}/${encodeURIComponent(runId)}/retry`;

export function retryAction(base: string, dag: string, runId: string): Option {
  return {
    id: RETRY_ACTION_ID,
    label: RETRY_ACTION_LABEL,
    style: "danger",
    callback: { kind: "http", url: retryUrl(base, dag, runId), method: "POST", body: { dagRunId: runId } },
  };
}

function fromV2(p: DaguV2, daguUrl: string): NotifyInput {
  const status = p.status.toLowerCase();
  const level = levelFromStatus(status);
  const fields: Field[] = [];
  if (p.failed_steps) fields.push({ name: "Failed steps", value: p.failed_steps.slice(0, 1024) });
  if (p.run_id) fields.push({ name: "Run", value: p.run_id.slice(0, 1024), inline: true });
  if (p.finished_at) fields.push({ name: "Finished", value: p.finished_at, inline: true });
  if (p.link && isHttpUrl(p.link)) fields.push({ name: "Link", value: p.link.slice(0, 1024) });
  const body = p.error ?? (p.message && p.message !== p.error ? p.message : undefined);
  const retry = daguUrl && RETRYABLE.has(status) && p.run_id ? [retryAction(daguUrl, p.dag, p.run_id)] : undefined;
  return notifySchema.parse({
    source: "dagu",
    type: "generic",
    level,
    title: `${p.dag}: ${status}`.slice(0, 256),
    body: body?.slice(0, 4000),
    fields: fields.length ? fields : undefined,
    url: isHttpUrl(p.link) ? p.link : undefined,
    actions: retry,
  });
}

function fromLenient(p: Record<string, unknown>): NotifyInput {
  const titleKey = TITLE_KEYS.find((k) => typeof p[k] === "string" && (p[k] as string).trim());
  const name = titleKey ? String(p[titleKey]) : "dagu";
  const status = p.status === undefined ? "" : String(p.status);
  const level = levelFromStatus(status);
  const fields = Object.entries(p)
    .filter(([k, v]) => k !== titleKey && k !== "message" && ["string", "number", "boolean"].includes(typeof v) && String(v) !== "")
    .slice(0, 25)
    .map(([k, v]) => ({ name: k, value: String(v).slice(0, 1024), inline: true }));
  return notifySchema.parse({
    source: "dagu",
    type: "generic",
    level,
    title: status ? `${name}: ${status}` : name,
    body: typeof p.message === "string" && p.message ? p.message : undefined,
    fields: fields.length ? fields : undefined,
  });
}

export const dagu: IngestAdapter = {
  async parse(body): Promise<NotifyInput> {
    log.debug("raw payload", body);
    const p = objectSchema.parse(body);
    const v2 = daguV2Schema.safeParse(p);
    if (!v2.success) return fromLenient(p);
    return fromV2(v2.data, await settings.get("dagu_url"));
  },
};
