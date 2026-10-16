# cryer — software design document

## Purpose

cryer is the bridge between automated things (agents, scheduled jobs, services) and the humans who watch
them in Discord. It posts notifications as embeds — into a server channel or a user's DM — asks questions as
prompts with buttons, number reactions and reply matching, records exactly one answer per prompt and hands
that answer back to the asker — through a long-poll, an `http` callback or an
[opencode](https://opencode.ai) session. Everything that varies by site (targets, callback hosts, TTLs,
URLs) is a runtime setting or an environment variable.

## Architecture

One Bun process per replica (`src/index.ts`), an HTTP app built with Hono (`src/app.ts`), a store behind
Drizzle (`src/lib/store.ts`), and two answer transports.

```
 HTTP clients ─► /notify /prompts /settings /purge /mcp     (bearer)         src/routes/*, src/mcp.ts
 webhooks     ─► /ingest/:source                            (bearer|?token)  src/routes/ingest.ts → src/lib/ingest/*
 Discord      ─► /interactions                              (Ed25519)        src/routes/interactions.ts → src/lib/transports/interactions.ts
                   buttons/modals → answerPrompt; slash commands → src/lib/commands/*
 Discord ws   ◄─► gateway client (lease holder only)                         src/lib/transports/gateway.ts
                        │ answerPrompt
                        ▼
              src/lib/prompts.ts  ──► store (bun:sqlite | rqlite)            src/lib/store.ts, src/db/*
                        │ enqueueCallbacks
                        ▼
              src/lib/queue.ts ──► src/lib/callbacks/{http,opencode-session}.ts
              src/lib/discord.ts (REST: post/edit messages, add reactions, open DMs, register commands)
```

| Component | File(s) | Role |
|---|---|---|
| Entry point | `src/index.ts` | loads `.env` (Bun), runs migrations, seeds settings, starts the server, the expiry sweeper (60 s), the gateway, handles SIGTERM (release lease → stop → exit) |
| HTTP app | `src/app.ts`, `src/lib/http.ts` | route composition, request logging, bearer / `?token=` / signature guards, `jsonOk`/`jsonErr` shape |
| Routes | `src/routes/*.ts` | Zod-validated handlers; orchestrate lib calls, never hold logic |
| Prompt/notification logic | `src/lib/prompts.ts` | `notify`, `createPrompt`, `answerPrompt` (first writer wins), `waitForAnswer`, `cancelPrompt`, `sweepExpired`, `purge`, message edits |
| Rendering | `src/lib/render/*` | embed per notification type (`generic` is the fallback), button rows, `custom_id` scheme `p:<prompt_id>:<idx>` |
| Transports | `src/lib/transports/interactions.ts`, `gateway.ts` | buttons/modals (HTTP) and reactions/replies (websocket, guild + DM intents); both end in `answerPrompt`; `interactions.ts` also dispatches `APPLICATION_COMMAND` to the commands registry |
| Commands | `src/lib/commands/*` | slash commands that configure cryer itself: `index.ts` definitions + dispatcher (`<command> <subcommand>` → handler), `here.ts` (`/cryer here`), `status.ts` (`/cryer status`: version, default target, `route.*` keys, gateway health; read-only), `forget.ts` (`/cryer forget`: `default_channel` back to the env fallback), `register.ts` (boot: GET live set, diff, bulk PUT only when it differs) |
| Lease | `src/lib/lease.ts` | conditional-upsert leader election on the `leases` table; `LeaseRunner` renews/polls |
| Callbacks | `src/lib/callbacks/*` | `http` (allowlisted, 3 attempts, 10 s) and `opencode-session`; registered in `index.ts` |
| Queue | `src/lib/queue.ts` | bounded in-process queue (concurrency 4, cap = `max_queue`) for callback delivery |
| Ingest | `src/lib/ingest/*` | `apprise`, `dagu` payload → `NotifyInput` |
| Settings | `src/lib/settings.ts` | typed defaults, 5 s cache capped at 500 keys, `resolveChannel` routing, targets (`parseTarget`, `targetToChannel`, `dmChannelFor`), log-level watcher |
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
| `dm_channels` | `user_id` (PK), `channel_id`, `created_at` — the DM channel Discord opened for a user, shared by every replica (`0003_dm.sql`) |

Two drivers behind one interface: `bun:sqlite` (WAL, `DATA_DIR/cryer.db`) for a single replica,
[rqlite](https://rqlite.io) over HTTP (`RQLITE_URLS`, client-side failover across the listed nodes) when
replicas share state. Reads run at rqlite level `strong` unless wrapped in `weak()` (routing lookups,
settings), writes are always strong. `db.transaction()` is never used because the two drivers differ there;
`Store.execBatch` runs a statement list as one transaction on either. Retention: `POST /purge` deletes rows
older than `purge_days`.

## Key flows

**Notification.** `POST /notify` → validate → `resolveChannel(source, level, explicit channel)` yields a
*target* → `targetToChannel` → `rendererFor(type)` builds the embed → Discord REST `POST
/channels/:id/messages` → `messages` row → `{id, channel_id, message_id, url}`. With `actions` the same
request also creates a prompt.

**Target resolution.** A target is a channel id or `dm:<user_id>` (`TARGET_RE`, validated at the API edge
and in `parseTarget`). A channel id is used as is. For a DM target `dmChannelFor` looks in a small in-process
map (200 entries), then the `dm_channels` table, then calls `POST /users/@me/channels` and stores the row —
Discord hands out the same DM channel for a user forever, so the mapping never expires. Discord codes 50007
and 50278 (DMs closed, app not installed and no mutual server) surface as a 502 with that reason instead of
a generic Discord error.

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

**`/cryer here`.** Discord posts the command interaction to `/interactions` like a button click. The
dispatcher checks `command_users` (empty = anyone who may invoke it; in a server the command's
`default_member_permissions` is *Manage Server*), then decides the target purely from the interaction:
context `BOT_DM` → `dm:<invoker id>`; context `GUILD` with the app installed to the server
(`authorizing_integration_owners` has key `0`) → the channel id; a server where only the user installed the
app → an ephemeral refusal (the bot could not post there). The result is `settings.set("default_channel",
target)` and an ephemeral confirmation — the setting stays the contract, the command is sugar over it.
`/cryer status` (same `command_users` gate) answers ephemerally with the version, `default_channel` rendered
for the invoker (`your DM`, `channel <#id>` or `unset`), the `route.*` rows (capped at 10 lines) and
`gatewayHealth()` of the replica that received the interaction — two settings reads and a local lease read,
far inside Discord's 3 s deadline. `/cryer forget` writes `env.defaultChannelId` (`DEFAULT_CHANNEL_ID`, `""`
when unset) back into `default_channel`; `route.*` rows are untouched.
Registration happens on boot: `registerCommands` reads the application's global commands, compares the
managed fields (name, description, options, `integration_types`, `contexts`,
`default_member_permissions`) and bulk-`PUT`s only on a difference; `commands_register=false` skips it.

**Gateway lease.** On boot every replica tries `acquireLease("gateway", CRYER_NODE, ttl)` — a single
`INSERT … ON CONFLICT DO UPDATE … WHERE expired OR own RETURNING`, so the store serialises contenders and one
wins. The winner opens the discord.js client and renews every `gateway_lease_renew_s`; the others poll at
the same rate and take over when the row expires or is released (SIGTERM releases it). Intents are the
guild and DM message/reaction sets plus Message Content. Without the Message Content intent Discord closes
the socket with 4014; the client reconnects without it and `/health` reports `reply_parsing: false` — guild
replies then arrive empty and are ignored, while DM replies still parse (`reply_parsing_dm: true`), because
Discord delivers DM content regardless of the privileged intent.

## Configuration surface

Environment variables for boot-time values (secrets, store, port, node name, opencode server) and the
`settings` table for runtime values (routing targets, TTLs, allowlist, queue cap, lease timing, `dagu_url`,
`log_level`, `command_users`, `commands_register`). Every key, default and meaning is in [configuration.md](configuration.md). Settings are read
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
- **Targets instead of channels.** One string (`<channel_id>` or `dm:<user_id>`) everywhere a destination
  is named, so routing, the API, MCP and the CLI did not grow a second field; the DM channel lookup is the
  only place that knows the difference. The cache table lives in the store so replicas never open a DM twice.
- **A user-installable app.** Someone without a server of their own installs cryer to their account and
  gets everything in a DM; the single slash command exists so they never have to look up an id. Commands
  are registered by the app itself, idempotently, because an operator should not need a second tool.
- **Extension points are one file each**: `src/lib/ingest/<source>.ts`, `src/lib/render/<type>.ts`,
  `src/lib/callbacks/<kind>.ts`, `src/lib/transports/<name>.ts`, `src/lib/commands/<command>.ts`,
  registered in their `index.ts`.

## Current scope and non-goals

Today cryer targets one Discord application, installed to servers and/or to user accounts; destinations are
channel ids or `dm:<user_id>`. Answers are single-choice (one option, optionally with modal text); prompts
live until answered, cancelled or expired. There is no user directory of its own — Discord identities
(`user_id`, `user_name`) are recorded as seen. Slash commands are limited to configuring cryer (`/cryer
here`); chat, moderation or any other general-bot feature is out of scope. Ingest adapters exist for
apprise and dagu; others are a file away. Authentication is one bearer token for
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
