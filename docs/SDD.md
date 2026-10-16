# cryer — software design document

## Purpose

cryer is the bridge between automated things (agents, scheduled jobs, services) and the humans who watch
them in Discord. It posts notifications as embeds, asks questions as prompts with buttons, number reactions
and reply matching, records exactly one answer per prompt and hands that answer back to the asker — through
a long-poll, an `http` callback or an [opencode](https://opencode.ai) session. Everything that varies by
site (channels, callback hosts, TTLs, URLs) is a runtime setting or an environment variable.

## Architecture

One Bun process per replica (`src/index.ts`), an HTTP app built with Hono (`src/app.ts`), a store behind
Drizzle (`src/lib/store.ts`), and two answer transports.

```
 HTTP clients ─► /notify /prompts /settings /purge /mcp     (bearer)         src/routes/*, src/mcp.ts
 webhooks     ─► /ingest/:source                            (bearer|?token)  src/routes/ingest.ts → src/lib/ingest/*
 Discord      ─► /interactions                              (Ed25519)        src/routes/interactions.ts → src/lib/transports/interactions.ts
 Discord ws   ◄─► gateway client (lease holder only)                         src/lib/transports/gateway.ts
                        │ answerPrompt
                        ▼
              src/lib/prompts.ts  ──► store (bun:sqlite | rqlite)            src/lib/store.ts, src/db/*
                        │ enqueueCallbacks
                        ▼
              src/lib/queue.ts ──► src/lib/callbacks/{http,opencode-session}.ts
              src/lib/discord.ts (REST: post/edit messages, add reactions)
```

| Component | File(s) | Role |
|---|---|---|
| Entry point | `src/index.ts` | loads `.env` (Bun), runs migrations, seeds settings, starts the server, the expiry sweeper (60 s), the gateway, handles SIGTERM (release lease → stop → exit) |
| HTTP app | `src/app.ts`, `src/lib/http.ts` | route composition, request logging, bearer / `?token=` / signature guards, `jsonOk`/`jsonErr` shape |
| Routes | `src/routes/*.ts` | Zod-validated handlers; orchestrate lib calls, never hold logic |
| Prompt/notification logic | `src/lib/prompts.ts` | `notify`, `createPrompt`, `answerPrompt` (first writer wins), `waitForAnswer`, `cancelPrompt`, `sweepExpired`, `purge`, message edits |
| Rendering | `src/lib/render/*` | embed per notification type (`generic` is the fallback), button rows, `custom_id` scheme `p:<prompt_id>:<idx>` |
| Transports | `src/lib/transports/interactions.ts`, `gateway.ts` | buttons/modals (HTTP) and reactions/replies (websocket); both end in `answerPrompt` |
| Lease | `src/lib/lease.ts` | conditional-upsert leader election on the `leases` table; `LeaseRunner` renews/polls |
| Callbacks | `src/lib/callbacks/*` | `http` (allowlisted, 3 attempts, 10 s) and `opencode-session`; registered in `index.ts` |
| Queue | `src/lib/queue.ts` | bounded in-process queue (concurrency 4, cap = `max_queue`) for callback delivery |
| Ingest | `src/lib/ingest/*` | `apprise`, `dagu` payload → `NotifyInput` |
| Settings | `src/lib/settings.ts` | typed defaults, 5 s cache capped at 500 keys, `resolveChannel` routing, log-level watcher |
| Discord REST | `src/lib/discord.ts` | `@discordjs/rest` wrapper, swappable for tests |
| MCP | `src/mcp.ts` | `@modelcontextprotocol/sdk` server over `@hono/mcp`, tools `notify ask wait get cancel list` |
| Store | `src/lib/store.ts`, `src/db/*` | one Drizzle `Db` type over `bun:sqlite` or rqlite's HTTP API; `execBatch` for transactions; `weak()` for relaxed reads |

## Data model / storage

Schema in `src/db/schema.ts`, migrations as plain SQL in `src/db/migrations/NNNN_*.sql`, applied in order by
`src/db/migrate.ts` on every boot (idempotent `CREATE … IF NOT EXISTS`; `ALTER TABLE ADD COLUMN` races
between replicas are tolerated). I keep the schema additive — no drops, no renames.

| Table | Content |
|---|---|
| `settings` | `key`, `value`, `updated_at` — runtime configuration |
| `messages` | every notification: `source`, `type`, `level`, `channel_id`, Discord `message_id`, `title`, `body_json` |
| `prompts` | `message_id` (FK), `channel_id`, `discord_message_id`, `title`, `body`, `options_json`, `modal_json`, `ttl_s`, `status` (`pending|answered|expired|failed`), `callback_json`, `session_json`, `expires_at`, `answered_at` |
| `answers` | `prompt_id` (FK), `choice_idx`, `choice_id`, `text`, `user_id`, `user_name`, `via` (`button|modal|reaction|reply`) |
| `leases` | `name` (PK), `holder`, `expires_at` — leader election |

Two drivers behind one interface: `bun:sqlite` (WAL, `DATA_DIR/cryer.db`) for a single replica,
[rqlite](https://rqlite.io) over HTTP (`RQLITE_URLS`, client-side failover across the listed nodes) when
replicas share state. Reads run at rqlite level `strong` unless wrapped in `weak()` (routing lookups,
settings), writes are always strong. `db.transaction()` is never used because the two drivers differ there;
`Store.execBatch` runs a statement list as one transaction on either. Retention: `POST /purge` deletes rows
older than `purge_days`.

## Key flows

**Notification.** `POST /notify` → validate → `resolveChannel(source, level, explicit channel)` →
`rendererFor(type)` builds the embed → Discord REST `POST /channels/:id/messages` → `messages` row → `{id,
channel_id, message_id, url}`. With `actions` the same request also creates a prompt.

**Prompt.** `POST /prompts` (or MCP `ask`) → validate options (≤ 25, callbacks against
`callback_allowlist`) → post the embed with button rows → `prompts` row (`pending`, `expires_at`) → add
1️⃣…9️⃣ reactions for the first nine non-modal options unless `reactions: false`.

**Answer, any transport.** Buttons and modals arrive at `POST /interactions` on whichever replica the load
balancer picks; the Ed25519 signature is the only gate and fails closed. Reactions and replies arrive on the
websocket of the lease holder; a reply is matched to option ids/labels (exact, bare `1`–`9`, unambiguous
prefix) else it is a free-text answer. All paths call `answerPrompt`, which does `UPDATE prompts SET
status='answered' … WHERE id=? AND status='pending'`; only the writer whose update changed a row inserts the
`answers` row, edits the message (buttons disabled, "✅ label — user via … at time" appended), acknowledges
(✅ / ⏱ on replies) and enqueues callbacks. Late or duplicate answers get a polite "already answered".

**Callback delivery.** `enqueueCallbacks` pushes one task per callback (prompt-level and option-level) on the
bounded queue. `http` POSTs/PUTs the answer payload merged with the spec's `body`, 10 s timeout, 3 attempts;
`opencode-session` either starts a turn (`POST /api/session/:id/prompt`) or writes an instruction entry,
per `session_callback_mode`. The outcome is appended to the embed footer (`⚙ label: ✓ ok` / `✗ reason`).

**Waiting.** `GET /prompts/:id/wait?timeout=` and MCP `ask mode:"wait"` poll the store every `wait_poll_ms`
up to `ask_wait_max_s`; the answer is read with strong consistency so a replica that did not see the click
still returns it.

**Expiry.** Every 60 s each replica sweeps prompts past `expires_at`, marks them `expired` and closes the
message (buttons removed, "⏱ expired"). `POST /prompts/:id/cancel` does the same on demand.

**Gateway lease.** On boot every replica tries `acquireLease("gateway", CRYER_NODE, ttl)` — a single
`INSERT … ON CONFLICT DO UPDATE … WHERE expired OR own RETURNING`, so the store serialises contenders and one
wins. The winner opens the discord.js client and renews every `gateway_lease_renew_s`; the others poll at
the same rate and take over when the row expires or is released (SIGTERM releases it). Without the Message
Content intent Discord closes the socket with 4014; the client reconnects without it and `/health` reports
`reply_parsing: false`.

## Configuration surface

Environment variables for boot-time values (secrets, store, port, node name, opencode server) and the
`settings` table for runtime values (routing, TTLs, allowlist, queue cap, lease timing, `dagu_url`,
`log_level`). Every key, default and meaning is in [configuration.md](configuration.md). Settings are read
through a 5 s per-replica cache, so a `PUT /settings/:key` is live everywhere within seconds and nothing
needs a restart.

## Decisions and rationale

- **Discord interactions over HTTP, websocket only where unavoidable.** Buttons and modals work through
  the signed `/interactions` endpoint on every replica, which is stateless and load-balancer friendly.
  Reactions and replies exist only on the gateway, so exactly one replica runs a websocket, chosen by a
  store lease instead of an external coordinator.
- **First-writer-wins in the store, not in memory.** A conditional `UPDATE` on `status='pending'` decides the
  answer; no replica needs to know about the others.
- **rqlite as the shared store.** SQLite semantics (one Drizzle schema, one set of migrations for both
  drivers) with Raft replication, small enough to run next to each replica. `bun:sqlite` stays the
  zero-dependency default for one replica.
- **Settings in the database.** Routing tables and timeouts change often and must be identical on every
  replica; a short cache keeps the store out of the hot path.
- **Bounded everything.** The callback queue, the settings cache and the wait timeout have caps
  (`max_queue`, 500 keys, `ask_wait_max_s`); long-lived connections (`/wait`, MCP) are bounded by the same
  timeout.
- **Allowlisted `http` callbacks.** A prompt may carry an arbitrary URL, so the target host must match
  `callback_allowlist` (private ranges by default) — the service never becomes an open relay to the internet.
- **Secrets only in `.env`.** The image carries no credentials and no CA; the file is bind-mounted and read
  by Bun's dotenv, so nothing shows in `docker inspect`.
- **Additive migrations applied on boot.** A rolling upgrade never needs a maintenance window; the old
  and the new version read the same tables.
- **Extension points are one file each**: `src/lib/ingest/<source>.ts`, `src/lib/render/<type>.ts`,
  `src/lib/callbacks/<kind>.ts`, `src/lib/transports/<name>.ts`, registered in their `index.ts`.

## Current scope and non-goals

Today cryer targets one Discord application and its server(s); channels are addressed by id. Answers are
single-choice (one option, optionally with modal text); prompts live until answered, cancelled or expired.
There is no user directory of its own — Discord identities (`user_id`, `user_name`) are recorded as seen.
Ingest adapters exist for apprise and dagu; others are a file away. Authentication is one bearer token for
the API/MCP/ingest surface and Ed25519 for Discord; finer-grained tokens or per-source scopes are not part
of the current scope.

## Operations

- **Health**: `GET /health` → `{ok, store, app_id, version, gateway}`; 503 when the store does not answer.
  Use it as the load balancer's active check.
- **Logs**: stdout, levels `debug|info|warn|error`, prefixed by subsystem (`[http]`, `[gateway]`, `[lease]`,
  `[store]`, `[queue]`, `[callback]`, `[ingest:dagu]`…). Every external call (Discord REST, callbacks,
  rqlite) logs method, path and outcome; background failures log with their stack. `log_level` is a setting.
- **Upgrade**: change the image tag, `docker compose up -d`, wait for `/health`, next replica
  ([deployment.md](deployment.md) → Rolling upgrade). Migrations run on boot.
- **Retention**: `POST /purge` daily ([deployment.md](deployment.md) → Scheduled purge).
- **Verification**: `bin/verify` = frozen install, `tsc`, `bun test`, boot on SQLite and probe `/health`;
  the same script runs in CI (`.github/workflows/run-tests.yml`).
