# Ingest adapters

`POST /ingest/:source` turns a third-party payload into a notification. Adapters live in
`src/lib/ingest/<source>.ts` and are registered in `src/lib/ingest/index.ts`. Because many webhook senders
cannot set headers, `/ingest/*` (and only `/ingest/*`) also accepts `?token=<CRYER_API_TOKEN>` in the query
string — constant-time compare, redacted from every log line.

## apprise

Use the `json://` notifier with the bearer header, e.g.
`json://cryer.example.internal/ingest/apprise?+Authorization=Bearer%20<token>` (`jsons://` for TLS).
apprise's `type` (`info|success|warning|failure`) becomes the level, `title`/`message` the embed.

The body may also carry an optional `url` (not an apprise key; any sender posting apprise-style JSON — the
author's deployer does — can set it). When it is an `http://` or `https://` URL the embed title links to it
and a **Link** field shows it; anything else (another scheme, a relative path, an unparseable string) is
ignored silently and the notification is posted as if `url` were absent. Existing payloads are unaffected.

```json
{"version": "1.0", "title": "Deploy finished", "message": "cryer 0.5.2 on turing-2", "type": "success",
 "url": "https://deployer.example.internal/requests/7"}
```

## dagu

[dagu](https://github.com/dagu-org/dagu) posts run events straight to `POST /ingest/dagu` through a
**webhook notification channel**; a failed or aborted run shows up as a red embed with a **Retry run**
button that calls dagu's retry API.

### Auth

dagu's webhook target accepts `headers` via its API (`NotificationWebhookTargetInput.headers`), but the UI
does not expose them; the `?token=` query parameter is the header-free alternative. Either works:

- query: `"url": "https://cryer.example.internal/ingest/dagu?token=<CRYER_API_TOKEN>"`
- header: `"url": "https://cryer.example.internal/ingest/dagu"`, `"headers": {"Authorization": "Bearer <CRYER_API_TOKEN>"}`

### Channel JSON

Create a webhook channel, or replace an existing one in place so the routes that reference it keep working
(`GET https://dagu.example.internal/api/v1/notification-channels` gives its `id`):

```
PUT https://dagu.example.internal/api/v1/notification-channels/<channelId>
Content-Type: application/json
```

```json
{
  "name": "cryer",
  "type": "webhook",
  "enabled": true,
  "webhook": {
    "url": "https://cryer.example.internal/ingest/dagu?token=<CRYER_API_TOKEN>",
    "allowInsecureHttp": false,
    "allowPrivateNetwork": true,
    "messageTemplate": "**{{dag.name}}** — {{run.status}}\n{{run.error}}\n{{run.link}}",
    "bodyTemplate": "{\"source\":\"dagu\",\"dag\":\"{{dag.name}}\",\"status\":\"{{run.status}}\",\"error\":\"{{run.error}}\",\"run_id\":\"{{run.id}}\",\"link\":\"{{run.url}}\",\"event\":\"{{event.type}}\",\"failed_steps\":\"{{run.failed_steps}}\",\"started_at\":\"{{run.startedAt}}\",\"finished_at\":\"{{run.finishedAt}}\",\"message\":\"{{message}}\"}"
  }
}
```

- `allowInsecureHttp: false` — the URL is https (dagu must trust the CA that signed cryer's certificate).
- `allowPrivateNetwork: true` — needed when the cryer hostname resolves to a private address.
- `bodyTemplate` replaces dagu's default payload; one request per event, every `{{token}}` is JSON-escaped
  (`internal/service/notification/service.go` → `renderWebhookBodyTemplate`), so the body is always valid JSON.
- Secrets in `url`/`headers` are encrypted at rest and never echoed back (the GET shows `urlPreview` only).

The preferred payload, as cryer parses it (`daguV2Schema` in `src/lib/ingest/dagu.ts`):

```json
{"source":"dagu","dag":"{{dag.name}}","status":"{{run.status}}","error":"{{run.error}}",
 "run_id":"{{run.id}}","link":"{{run.url}}","event":"{{event.type}}","failed_steps":"{{run.failed_steps}}",
 "started_at":"{{run.startedAt}}","finished_at":"{{run.finishedAt}}","message":"{{message}}"}
```

Level: `failed|error|aborted|rejected|cancelled` → failure, `succeeded|success|finished|partially_succeeded`
→ success, else warning. Title `<dag>: <status>`, `error` as body, `link` as the embed URL. Payloads of
another shape fall back to lenient handling (title from `name|dag_name|dagName|dag`, scalars become fields).

### Template tokens (dagu 2.17, `internal/service/notification/service.go` → `notificationTemplateValues`)

| token | meaning |
|---|---|
| `{{dag.name}}` / `{{dagName}}` | DAG name (= the path param `name` of the retry endpoint) |
| `{{run.id}}` / `{{dagRunId}}` | DAG-run id |
| `{{run.status}}` / `{{status}}` | `not_started` `running` `failed` `aborted` `succeeded` `queued` `partially_succeeded` `waiting` `rejected` |
| `{{run.error}}` / `{{error}}` | run error text |
| `{{run.failed_steps}}` `{{run.aborted_steps}}` `{{run.succeeded_steps}}` `{{run.partially_succeeded_steps}}` | comma-joined step names |
| `{{run.startedAt}}` `{{run.finishedAt}}` | RFC3339 |
| `{{run.attemptId}}` / `{{attemptId}}`, `{{worker.id}}`, `{{workspace}}` | — |
| `{{run.path}}` / `{{runPath}}` | `/dag-runs/<name>/<id>` |
| `{{run.url}}` / `{{runUrl}}` | `<server.publicURL>` + run.path — **empty unless dagu's `server.publicURL` (`DAGU_PUBLIC_URL`) is set** |
| `{{run.link}}` / `{{runLink}}` | `Run: <run.url>` or empty |
| `{{event.type}}` / `{{eventType}}` | `dag.run.failed` `dag.run.aborted` `dag.run.rejected` `dag.run.succeeded` `dag.run.partially_succeeded` `dag.run.queued` `dag.run.running` `dag.run.waiting` `dag.run.updated` |
| `{{event.observedAt}}` | RFC3339 |
| `{{message}}` | the rendered `messageTemplate` (bodyTemplate only) |

Which events fire is decided by dagu's notification settings / routes (`PUT /api/v1/notification-routes/...`),
not by the channel.

### The Retry button

cryer attaches `retry` ("Retry run", red) when `status` is `failed` or `aborted` and both `dag` and `run_id`
are present. The click runs an `http` callback:

```
POST <dagu_url>/api/v1/dag-runs/<dag>/<run_id>/retry
{"dagRunId": "<run_id>", "prompt_id": "…", "title": "…", "choice_id": "retry", "user_name": "…", …}
```

(`api/v1/api.yaml` → `/dag-runs/{name}/{dagRunId}/retry`, operationId `retryDAGRun`: reuses the run id,
resets the failed steps; extra body keys are ignored.) `dagu_url` is a cryer setting
(`PUT /settings/dagu_url`, e.g. `https://dagu.example.internal`); empty (the default) means no button. The host
must match cryer's `callback_allowlist`. A dagu that runs without auth needs no header; if auth is enabled
there, add `"headers": {"Authorization": "Bearer …"}` to the action in `src/lib/ingest/dagu.ts`. The
outcome lands in the embed footer: `⚙ Retry run: ✓ ok` or `⚙ Retry run: ✗ HTTP 404`.

### Verify

```sh
curl -sS -X POST "https://cryer.example.internal/ingest/dagu?token=$CRYER_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"source":"dagu","dag":"nightly-backup","status":"failed","error":"test","run_id":"test-run","link":""}'
```

→ `201 {"ok":true,…,"prompt_id":"…"}` and a red embed with a **Retry run** button in Discord. Clicking it
POSTs to dagu, which answers 404 for the fake run id — the footer should show `✗ HTTP 404`.

## Adding an adapter

One file `src/lib/ingest/<source>.ts` exporting an `IngestAdapter` (`src/lib/ingest/types.ts`): parse the
payload into a `NotifyInput` (source, level, title, body, fields, url, optional actions), register it in
`src/lib/ingest/index.ts`, add a test under `test/ingest.test.ts`.
