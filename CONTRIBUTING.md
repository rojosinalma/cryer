# Contributing

## Running it locally

```sh
bun install
cp .env.example .env            # DISCORD_*, CRYER_API_TOKEN at minimum (target via /cryer here or DEFAULT_CHANNEL_ID)
bun run dev                     # bun --watch src/index.ts on http://127.0.0.1:7474, bun:sqlite in ./data
```

Or in a container with the checkout bind-mounted:

```sh
docker compose -f compose.dev.yaml run --rm cryer bun install
docker compose -f compose.dev.yaml up
```

Bun loads `./.env` itself. To test against a real Discord server you need the application from the README;
the test suite needs none of it.

## Tests

```sh
bin/verify          # install (frozen), tsc, bun test, boot + /health probe — must pass before a PR
bun test            # unit tests only (test/*.test.ts, in-memory SQLite, fake Discord client)
bun run typecheck   # tsc --noEmit
```

`bin/verify` is what CI runs (`.github/workflows/run-tests.yml`). Tests use neutral fixtures
(`example.internal`, `192.168.1.x`, `node-a`/`node-b`, `alice`); keep new ones in that style. Logic that
touches the store, a transport or a callback gets a test next to the existing ones.

## Code style and layout

TypeScript on Bun, strict `tsconfig`, no build step. Layout:

| Path | Content |
|---|---|
| `src/index.ts`, `src/app.ts` | process entry and HTTP app composition |
| `src/routes/` | Zod-validated handlers → lib → `jsonOk`/`jsonErr`; no business logic |
| `src/lib/` | logic: prompts, settings, store, lease, queue, discord, render, transports, callbacks, ingest |
| `src/db/` | Drizzle schema and plain-SQL migrations (`NNNN_name.sql`, additive only, applied on boot) |
| `src/mcp.ts` | the MCP server |
| `bin/` | `cryer` (CLI), `purge`, `verify` |
| `examples/` | compose files for a replica, an rqlite voter, a dagu purge DAG |

Extension points, one file each, registered in their `index.ts`:

| Directory | Add a … |
|---|---|
| `src/lib/ingest/<source>.ts` | payload adapter (`POST /ingest/<source>`) |
| `src/lib/render/<type>.ts` | embed renderer per notification type |
| `src/lib/callbacks/<kind>.ts` | callback kind (`http`, `opencode-session`) |
| `src/lib/transports/` | answer transport (`interactions`, `gateway`) — all end in `answerPrompt` |

Conventions: every tunable is a setting or an env var (`src/lib/settings.ts`, `src/lib/env.ts`), never a
constant; every in-memory collection has a cap; every background task logs failures with a stack; API
responses are `{ok, message, …}` with `kind: "validation" | "system"` on errors. Comments explain why, not
what. Pin dependency versions in `package.json` and update `bun.lock` with them.

## Commits and PRs

- Plain, descriptive commit messages in the imperative ("Add reply matching for prefixes"), one logical
  change per commit. No attribution trailers.
- Every commit and tag is GPG-signed (`git config commit.gpgsign true`, `git tag -s`); `main` is protected
  and requires the `run-tests` check to pass.
- A PR describes the behaviour change and how it was verified; `bin/verify` must be green.
- A schema change is a new `src/db/migrations/NNNN_*.sql` plus the matching `src/db/schema.ts` edit — never
  an edit to an existing migration.
- User-visible changes get a line under `[Unreleased]` in `CHANGELOG.md`.

## Documentation

The README has a fixed shape — badges, screenshot, description, Requirements, Installation, Usage,
Development, License — and nothing else. Repository-level documents: `CONTRIBUTING.md` (this file),
`SECURITY.md` (how to report a vulnerability), `CODE_OF_CONDUCT.md`, `CHANGELOG.md`. Everything else lives
in `docs/`:

| File | Content |
|---|---|
| `docs/features.md` | what cryer does, one line per feature |
| `docs/configuration.md` | environment variables, runtime settings, routing |
| `docs/api.md` | HTTP routes, answer and callback shapes |
| `docs/mcp.md` | the MCP server and its tools |
| `docs/cli.md` | `bin/cryer` |
| `docs/ingest.md` | apprise and dagu adapters, how to add one |
| `docs/deployment.md` | image, single node, HA with rqlite, reverse proxy, operations, failure modes |
| `docs/SDD.md` | design: architecture, data model, flows, decisions, scope, operations |
| `docs/release-notes-<version>.md` | notes for a release, linked from the GitHub release |

A change in behaviour updates the matching doc in the same PR.

## Releasing

1. Bump `version` in `package.json`, move the `[Unreleased]` entries in `CHANGELOG.md` under the new
   version with the date, write `docs/release-notes-<version>.md`, update the image tag in `compose.yaml`
   and `examples/cryer/compose.yaml`.
2. Commit (signed), then `git tag -s v<version> -m v<version> && git push && git push --tags`.
3. `.github/workflows/release.yml` builds `linux/amd64` and `linux/arm64` and pushes
   `ghcr.io/rojosinalma/cryer:<version>`, `:<major>.<minor>`, `:latest` and `:sha-<short>`.
4. Create the GitHub release from the tag with the release notes (`gh release create v<version>
   --title "cryer <version>" --notes-file docs/release-notes-<version>.md`).

By contributing you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
