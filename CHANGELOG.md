# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Image tags on
`ghcr.io/rojosinalma/cryer` match the git tags.

## [Unreleased]

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

[Unreleased]: https://github.com/rojosinalma/cryer/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/rojosinalma/cryer/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rojosinalma/cryer/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rojosinalma/cryer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rojosinalma/cryer/releases/tag/v0.1.0
