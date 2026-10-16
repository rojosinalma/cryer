# HTTP API

All routes except `/health` and `/interactions` need `Authorization: Bearer $CRYER_API_TOKEN`
(`POST /ingest/:source` alone also accepts `?token=$CRYER_API_TOKEN`, redacted from logs).
Responses are `{ok:true, message, …}` or `{ok:false, message, kind:"validation"|"system"}`.

| Route | Purpose |
|---|---|
| `GET /health` | `{ok, store, app_id, version, gateway:{enabled, leader, holder, connected, reply_parsing, reply_parsing_dm}}`; 503 when the store does not answer (the gateway block never fails it). `reply_parsing` is reply matching in server channels (needs the Message Content intent), `reply_parsing_dm` the same for DMs (true whenever the websocket is up) |
| `POST /notify` | `{source, type?, level, title, body?, fields?, channel?, url?, actions?, callback?, session?, reactions?}` → `{id, channel_id, message_id, prompt_id?, url}`. `actions` turns it into a prompt too |
| `POST /prompts` | `{title, body?, source?, options:[{id,label,style?,modal?,callback?}], ttl_s?, channel?, callback?, session?, reactions?}` → `{id, url}` (max 25 options) |
| `GET /prompts?status=&limit=` | List, newest first |
| `GET /prompts/:id` | Prompt with its answer |
| `GET /prompts/:id/wait?timeout=` | Long-poll until answered/expired or timeout (≤ `ask_wait_max_s`) → `{status, answer?}` |
| `POST /prompts/:id/cancel` | Mark expired and disable the buttons |
| `POST /ingest/:source[?token=]` | `apprise` or `dagu` payload ([ingest.md](ingest.md)) |
| `GET/PUT /settings[/:key]` | Runtime settings ([configuration.md](configuration.md)) |
| `POST /purge` | Delete rows older than `purge_days`; returns counts |
| `POST /interactions` | Discord's endpoint (Ed25519-signed): buttons, modals and the `/cryer here` command |
| `POST /mcp` | MCP server, Streamable HTTP ([mcp.md](mcp.md)) |

## Targets

`channel` on `POST /notify` and `POST /prompts` is a **target**: a channel id, or `dm:<user_id>` for a
user's DM (the user must have installed the app or share a server with the bot). It overrides the
`route.*`/`default_channel` settings, which take the same two forms. A malformed target is a 422; a DM
Discord refuses (app not installed, DMs closed) is a 502 with that reason. `channel_id` in the response is
always the real channel the message was posted to (for a DM, the DM channel).

## Answers

An answer is `{choice_id, choice_idx, text, user_id, user_name, at, via}`. `via` is
`button|modal|reaction|reply`; `choice_id`/`choice_idx` are `null` for a free-text reply, `text` carries
the modal input or the reply.

## Callbacks

On `POST /prompts`, `POST /notify` with actions, or per option:

- `{kind:"http", url, method?:"POST"|"PUT", headers?, body?}` — posts
  `{prompt_id, title, choice_id, choice_idx, text, user_id, user_name, at, via, …body}` to a host matching
  `callback_allowlist`; 10 s timeout, 3 attempts.
- `{kind:"opencode-session", session_id, directory?, mode?}` — delivers the answer into an
  [opencode](https://opencode.ai) session (needs `OPENCODE_URL`); `session:{id, directory?, mode?}` is the
  shorthand. `mode` defaults to the `session_callback_mode` setting.

When a callback finishes, the embed footer gets `⚙ <label>: ✓ ok` or `⚙ <label>: ✗ <reason>` per callback.

## Examples

```sh
curl -s -X POST localhost:7474/notify -H "Authorization: Bearer $CRYER_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"source":"backup","level":"warning","title":"Disk 95% full","body":"nas root"}'

curl -s -X POST localhost:7474/notify -H "Authorization: Bearer $CRYER_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"source":"backup","level":"info","title":"Backup done","channel":"dm:345678901234567890"}'

curl -s -X POST localhost:7474/prompts -H "Authorization: Bearer $CRYER_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Deploy v1.2?","options":[{"id":"yes","label":"Deploy"},{"id":"no","label":"Skip"}],
       "callback":{"kind":"http","url":"http://192.168.1.10:8080/hook"}}'
```
