# Configuration

Two layers: environment variables for what the process needs to boot (secrets, store, port), and a
`settings` table in the database for everything that may change at runtime.

## Environment (`.env`)

Bun loads `./.env` from the working directory itself (`/app/.env` in the image, bind-mounted read-only);
nothing passes secrets through compose. `.env.example` lists every key.

| Key | Meaning | Default |
|---|---|---|
| `PORT` | Listen port (0.0.0.0) | `7474` |
| `DATA_DIR` | Directory for `cryer.db` when using SQLite | `./data` (`/app/data` in the image) |
| `RQLITE_URLS` | Comma-separated rqlite HTTP endpoints; set → rqlite, unset → `bun:sqlite` | unset |
| `DISCORD_TOKEN` | Bot token (REST on every replica; the gateway websocket on the lease holder) | — |
| `DISCORD_APP_ID` | Application id | — |
| `DISCORD_PUBLIC_KEY` | Application public key (hex), verifies `/interactions` | — |
| `CRYER_API_TOKEN` | Bearer token for API, MCP and ingest | — |
| `OPENCODE_URL` | opencode server for `opencode-session` callbacks; unset disables them | unset |
| `OPENCODE_SERVER_USERNAME` | Basic-auth username for that server | `opencode` |
| `OPENCODE_SERVER_PASSWORD` | Basic-auth password for that server | — |
| `DEFAULT_CHANNEL_ID` | Fallback channel when the settings table is empty or unreachable | — |
| `LOG_LEVEL` | Bootstrap log level; the `log_level` setting overrides it at runtime | `info` |
| `CRYER_NODE` | Replica name, used as the gateway lease holder | hostname |
| `CRYER_VERSION` | Version reported by `/health` | `package.json` version |
| `NODE_EXTRA_CA_CERTS` | Optional PEM of a private CA used by callback/ingest targets (mount it) | unset |

## Settings (database, editable at runtime)

`GET /settings`, `GET /settings/:key`, `PUT /settings/:key {"value": "…"}` or `cryer settings key value`.
Cached for 5 s per replica.

| Key | Meaning | Default |
|---|---|---|
| `default_channel` | Channel id when no route matches | `""` → `DEFAULT_CHANNEL_ID` |
| `route.<source>.<level>` | Channel id for one source and level | unset |
| `route.<source>.*` | Channel id for every level of a source | unset |
| `prompt_ttl_s` | Default prompt lifetime | `3600` |
| `purge_days` | Retention for messages, prompts and answers | `30` |
| `log_level` | `debug\|info\|warn\|error` | `info` |
| `callback_allowlist` | Hosts an `http` callback may target: CIDRs, exact hosts, `*.glob` | `127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` |
| `max_queue` | Cap of the in-process callback queue | `200` |
| `ask_wait_max_s` | Upper bound for any wait/long-poll | `300` |
| `wait_poll_ms` | Store polling interval while waiting | `1000` |
| `session_callback_mode` | `prompt` (start a turn) or `instruction` (instruction entry) | `prompt` |
| `dagu_url` | Base of dagu's API for the **Retry run** button; empty → no button | `""` |
| `gateway_enabled` | Run the gateway listener (reaction + reply answers) on the lease holder | `true` |
| `gateway_lease_ttl_s` | How long the `gateway` lease is valid without a renew | `30` |
| `gateway_lease_renew_s` | Leader renew interval; followers poll at the same rate | `10` |

## Routing

Routing order: explicit `channel` in the request → `route.<source>.<level>` → `route.<source>.*` →
`default_channel` → `DEFAULT_CHANNEL_ID`.

```sh
cryer settings route.backup.failure 123456789012345678   # failures of source "backup" go to one channel
cryer settings route.agent.* 234567890123456789          # everything from source "agent" to another
```

## Private CA

If callback or ingest targets present a certificate from your own CA, mount the PEM into the container and
set `NODE_EXTRA_CA_CERTS` to its path (`compose.override.yaml.example` shows the two lines). The image
trusts public CAs only.
