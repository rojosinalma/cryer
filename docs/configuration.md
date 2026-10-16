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
| `DEFAULT_CHANNEL_ID` | Fallback target (channel id or `dm:<user_id>`) when the settings table is empty or unreachable | — |
| `LOG_LEVEL` | Bootstrap log level; the `log_level` setting overrides it at runtime | `info` |
| `CRYER_NODE` | Replica name, used as the gateway lease holder | hostname |
| `CRYER_VERSION` | Version reported by `/health` | `package.json` version |
| `NODE_EXTRA_CA_CERTS` | Optional PEM of a private CA used by callback/ingest targets (mount it) | unset |

## Settings (database, editable at runtime)

`GET /settings`, `GET /settings/:key`, `PUT /settings/:key {"value": "…"}` or `cryer settings key value`.
Cached for 5 s per replica.

| Key | Meaning | Default |
|---|---|---|
| `default_channel` | Target (channel id or `dm:<user_id>`) when no route matches; `/cryer here` sets it | `""` → `DEFAULT_CHANNEL_ID` |
| `route.<source>.<level>` | Target for one source and level | unset |
| `route.<source>.*` | Target for every level of a source | unset |
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
| `command_users` | Comma-separated user ids allowed to run `/cryer here`; empty = anyone who can invoke it | `""` |
| `commands_register` | Register the slash command set on boot (GET, diff, bulk PUT when it differs) | `true` |

## Targets

Everywhere a channel is named — `default_channel`, `route.*`, `DEFAULT_CHANNEL_ID`, the `channel` field of
`POST /notify`, `POST /prompts`, MCP `notify`/`ask` and the CLI's `-c` — a **target** is one of two forms:

| Form | Meaning |
|---|---|
| `123456789012345678` | A channel id; the bot must be in that server with the permissions from the README |
| `dm:123456789012345678` | The DM with that user; the user must have installed the app (or share a server with the bot) |

For a DM target cryer opens the DM once (`POST /users/@me/channels`) and keeps the channel id in the
`dm_channels` table, so every replica reuses it. When Discord refuses the DM (the user has not installed the
app and shares no server, or has DMs closed) the request fails with a 502 naming that reason. Anything that
is neither a snowflake nor `dm:<snowflake>` is a 422.

The easiest way to set `default_channel` is `/cryer here` in Discord ([features.md](features.md)): in the
bot's DM it writes `dm:<your id>`, in a server channel the channel id.

## Routing

Routing order: explicit `channel` in the request → `route.<source>.<level>` → `route.<source>.*` →
`default_channel` → `DEFAULT_CHANNEL_ID`.

```sh
cryer settings route.backup.failure 123456789012345678   # failures of source "backup" go to one channel
cryer settings route.agent.* dm:345678901234567890       # everything from source "agent" to your DM
```

## Private CA

If callback or ingest targets present a certificate from your own CA, mount the PEM into the container and
set `NODE_EXTRA_CA_CERTS` to its path (`compose.override.yaml.example` shows the two lines). The image
trusts public CAs only.
