# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Image tags on
`ghcr.io/rojosinalma/cryer` match the git tags.

## [Unreleased]

## [0.5.2] - 2026-10-20

### Added

- `POST /ingest/apprise` accepts an optional `url` next to apprise's own keys. An `http://`/`https://` value
  becomes the embed's clickable title and a **Link** field (same as the dagu adapter's `link`); any other
  value is ignored silently and the notification posts as before. Existing payloads are unchanged.

### Changed

- `isHttpUrl` moved from the dagu adapter to `src/lib/ingest/types.ts` and now also requires the value to
  parse as a URL, so a malformed link can never fail an ingest.

## [0.5.1] - 2026-10-16

### Added

- `/cryer status`: ephemeral summary of the cryer version, the current `default_channel` (your DM, a channel
  mention or unset), every `route.*` setting (capped at 10 lines) and the gateway state (leader/holder,
  connected, reply parsing, reply parsing in DMs) of the replica that answered. Same `command_users` gate as
  `/cryer here`.
- `/cryer forget`: resets `default_channel` to the `DEFAULT_CHANNEL_ID` fallback (`""` when unset), undoing
  `/cryer here`; `route.*` settings are untouched. Both commands are registered on the next boot by the
  existing diff-and-PUT registration.

### Fixed

- `bin/deploy`: the deployer start call now waits up to `DEPLOY_START_TIMEOUT_S` (180 s) for the synchronous
  image pull instead of the generic 20 s HTTP timeout.

## [0.5.0] - 2026-10-16

### Added

- User-installable app: a target is now a channel id **or `dm:<user_id>`** — in `default_channel`,
  `route.<source>.<level>`, `route.<source>.*`, `DEFAULT_CHANNEL_ID`, the `channel` field of `POST /notify`,
  `POST /prompts`, MCP `notify`/`ask` and the CLI's `-c`. cryer opens the DM once (`POST /users/@me/channels`)
  and caches it in the new `dm_channels` table (migration `0003_dm.sql`). A DM Discord refuses (codes
  50007/50278: app not installed and no mutual server, or DMs closed) is a 502 naming that reason.
- Slash command `/cryer here`: in the bot's DM it sets `default_channel = dm:<your id>`, in a server channel
  where cryer is installed to the server it sets that channel id, in a server where only the user installed
  it it refuses with a hint. New settings `command_users` (comma-separated user ids allowed to run it, empty =
  anyone who can invoke it) and `commands_register` (default `true`: boot compares the application's global
  commands with cryer's set and bulk-overwrites only on a difference). Command interactions arrive on the
  existing `/interactions` endpoint.
- `/health.gateway.reply_parsing_dm`: reply matching in DMs, true whenever the websocket is up.

### Changed

- Gateway intents also include `DirectMessages` and `DirectMessageReactions`; reply answers in DMs work
  without the privileged Message Content intent (it gates guild messages only).
- Installation: the Developer Portal's **Installation** page (User Install + Guild Install contexts, default
  scopes) replaces the OAuth2 URL generator in the README; `/cryer here` replaces hand-picking
  `DEFAULT_CHANNEL_ID`, which stays as the fallback.
- Non-goal narrowed from "no slash commands" to "one configuration command, no general-bot features".
- MCP server instructions trimmed to three lines (what cryer is, `notify` vs `ask`, `mode:"callback"`); the
  option shape, reaction/reply answers and the `via` field moved into the `ask` tool description. Clients
  inject the instructions into every conversation, so this cuts their per-turn cost by about two thirds.

## [0.4.1] - 2026-10-16

### Changed

- Licence: cryer is now released under the AGPL-3.0 (was MIT). `LICENSE`, `package.json` and the image's
  `org.opencontainers.image.licenses` label say `AGPL-3.0-only`.
- README restructured (requirements with minimum versions, installation, usage, development); `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue and pull request templates, Dependabot for Bun dependencies, GitHub Actions
  and the base image.
- The `run-tests` workflow runs on pull requests and pushes to `main` only; both workflows carry run names.

## [0.4.0] - 2026-10-16

### Changed

- Generic defaults for a fresh install: `callback_allowlist` is now the private ranges
  (`127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`), `dagu_url` is empty (the dagu **Retry
  run** button is omitted until it is set), `OPENCODE_URL` is empty (the `opencode-session` callback is
  disabled until it is set). Existing settings rows are untouched.
- New env var `OPENCODE_SERVER_USERNAME` (default `opencode`) for the opencode server's Basic auth.
- A private CA is no longer baked into the image. Mount the PEM and point `NODE_EXTRA_CA_CERTS` at it
  (`compose.override.yaml.example`, `examples/cryer/compose.yaml`).
- Images are published for `linux/amd64` and `linux/arm64`, tagged `<version>`, `<major>.<minor>`, `latest`
  and `sha-<short>`; `compose.yaml` runs the published image, `compose.dev.yaml` is the bind-mounted dev setup.
- Deployment examples under `examples/` (a replica, an rqlite voter, a dagu purge DAG); documentation under
  `docs/` (configuration, API, MCP, CLI, ingest, deployment, SDD) and `CONTRIBUTING.md`.
- CLI default `CRYER_URL` is `http://127.0.0.1:7474`.
- README, CHANGELOG, LICENSE; released under the MIT licence.

## [0.3.0] - 2026-10-11

### Added

- Gateway listener: a leader-only discord.js client on the replica holding the `gateway` row in `leases`
  (conditional-upsert lease, renew/TTL settings `gateway_lease_renew_s`/`gateway_lease_ttl_s`,
  `gateway_enabled` to turn it off at runtime).
- Reaction answers: prompts get 1️⃣…9️⃣ for the first nine non-modal options (`reactions: false` opts out);
  a number reaction by a human answers that option.
- Reply answers: a reply is matched to option ids/labels (exact, bare number, unambiguous prefix); an
  unmatched reply is a free-text answer with `choice_id`/`choice_idx` `null`. ✅/⏱ acknowledgements.
- `answers.via` (`button|modal|reaction|reply`) in every answer view, embed and callback payload.
- `/health.gateway {enabled, leader, holder, connected, reply_parsing}`; graceful fallback without the
  Message Content intent (reactions work, replies ignored).
- Migration `0002_gateway.sql`; the migrate runner tolerates `duplicate column` races between replicas.

## [0.2.0] - 2026-10-11

### Added

- `POST /ingest/:source?token=<CRYER_API_TOKEN>` as an alternative to the bearer header, on `/ingest/*`
  only (constant-time compare, token redacted from logs).
- dagu adapter v2: structured webhook payload (`dag`, `status`, `error`, `run_id`, `link`, `event`,
  `failed_steps`, timestamps) and a **Retry run** button calling `<dagu_url>/api/v1/dag-runs/<dag>/<run_id>/retry`;
  new setting `dagu_url`. The lenient v0.1 parsing remains the fallback.
- Callback outcome edits: the embed footer gets `⚙ <label>: ✓ ok` / `⚙ <label>: ✗ <reason>` per callback.
- A private CA baked into the image via `NODE_EXTRA_CA_CERTS` (reverted in 0.4.0 in favour of a mount).

## [0.1.0] - 2026-10-11

### Added

- `POST /notify` and the prompts API (`POST /prompts`, `GET /prompts[/:id[/wait]]`, `POST /prompts/:id/cancel`)
  with `http` and `opencode-session` callbacks, routing by `route.<source>.<level>` settings.
- `POST /interactions`: Ed25519-verified Discord endpoint for buttons and modals (custom_id `p:<prompt_id>:<idx>`),
  first-writer-wins answers across replicas.
- MCP server at `/mcp` (`notify`, `ask`, `wait`, `get`, `cancel`, `list`).
- Ingest adapters for apprise and dagu.
- Store: Drizzle over rqlite (`RQLITE_URLS`, client-side failover) or `bun:sqlite`; runtime `settings`
  table; `POST /purge` with `purge_days` retention.
- `bin/cryer` CLI, `bin/verify`; Dockerfile and GitHub Actions (tests on every push, image releases to
  `ghcr.io/rojosinalma/cryer` on tags).

[Unreleased]: https://github.com/rojosinalma/cryer/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/rojosinalma/cryer/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/rojosinalma/cryer/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/rojosinalma/cryer/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/rojosinalma/cryer/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/rojosinalma/cryer/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rojosinalma/cryer/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rojosinalma/cryer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rojosinalma/cryer/releases/tag/v0.1.0
