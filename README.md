# cryer

[![run-tests](https://github.com/rojosinalma/cryer/actions/workflows/run-tests.yml/badge.svg)](https://github.com/rojosinalma/cryer/actions/workflows/run-tests.yml)
[![release](https://github.com/rojosinalma/cryer/actions/workflows/release.yml/badge.svg)](https://github.com/rojosinalma/cryer/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/rojosinalma/cryer)](https://github.com/rojosinalma/cryer/releases)
[![License](https://img.shields.io/github/license/rojosinalma/cryer)](LICENSE)

![A dagu failure notification and an agent prompt with buttons in Discord](docs/screenshot.png)

Discord notifications and decisions for your services: agents, cron jobs and services post embeds and
ask a human with buttons, reactions or replies — over HTTP, MCP or a CLI.

Notifications are routed to channels by source and level. A prompt carries up to 25 options as buttons
(an option may open a modal for free text), plus number reactions and reply matching; the first answer wins
across replicas and is handed back through a long-poll, an `http` callback or an
[opencode](https://opencode.ai) session. Ingest adapters accept [apprise](https://github.com/caronc/apprise)
and [dagu](https://github.com/dagu-org/dagu) webhooks, an MCP server exposes the same tools to agents,
and runtime settings live in the database. Several replicas share an [rqlite](https://rqlite.io) store.
Features, configuration, API and operations are documented in [`docs/`](docs/).

## Requirements

- Docker 24+ with Compose v2 (runs the published image), **or** [Bun](https://bun.sh) 1.4+ to run from source.
- A Discord application with a bot token, either added to your server (*Send Messages*, *Embed Links*,
  *Add Reactions*, *Read Message History*) or installed to your account — then cryer talks to you in a DM
  (`dm:<user_id>` target) and needs no server at all.
- Optional: the **Message Content** privileged intent for reply answers in server channels (reactions and
  buttons work without it; replies in DMs always work).
- Optional: an [rqlite](https://rqlite.io) 8+ cluster to run more than one replica.
- Optional: a public HTTPS hostname that forwards `/interactions` to cryer, for buttons and modals.

## Installation

1. Create the Discord application in the [Developer Portal](https://discord.com/developers/applications):
   New Application → **Bot** → Reset Token (→ `DISCORD_TOKEN`). General Information gives the
   **Application ID** and **Public Key**. Under **Installation** tick both installation contexts (**User
   Install** with scope `applications.commands`; **Guild Install** with `applications.commands` + `bot` and
   the permissions above), save, and open the install link it shows: **Add to my apps** for DMs, **Add to
   server** for a channel. For reply answers in server channels turn on Bot → Privileged Gateway Intents →
   **Message Content** (DMs need no intent).
2. Run it:

   ```sh
   git clone https://github.com/rojosinalma/cryer && cd cryer
   cp .env.example .env            # DISCORD_*, CRYER_API_TOKEN at minimum
   docker compose up -d            # ghcr.io/rojosinalma/cryer, 127.0.0.1:7474, data in a volume
   curl -s localhost:7474/health
   ```

   Then type `/cryer here` in the bot's DM or in the server channel notifications should land in; it sets
   `default_channel` for you (`dm:<your id>` or the channel id). `DEFAULT_CHANNEL_ID` in `.env` remains
   the hand-picked fallback — it accepts the same two forms. `/cryer status` shows the current target, the
   `route.*` overrides and the gateway state; `/cryer forget` resets the target to that fallback.

3. For buttons, modals and `/cryer here`, once cryer is reachable from the internet: General Information →
   **Interactions Endpoint URL** = `https://<public-host>/interactions`. Discord sends a signed PING on
   save; cryer answers `{type:1}`. Buttons and slash commands share that one path. Expose **only**
   `/interactions` publicly — it is Ed25519-verified and
   needs no other gate. Keep the API, MCP, settings and ingest routes on your private network or behind an
   authenticating proxy.

More than one replica, reverse proxies and operations: [`docs/deployment.md`](docs/deployment.md).

## Usage

```sh
export CRYER_API_TOKEN=…        # or put CRYER_URL/CRYER_API_TOKEN in ~/.config/cryer/env
bin/cryer notify -l success -s hello "cryer is up" "first message"
bin/cryer ask "Deploy v1.2?" -o yes=Deploy -o no=Skip --wait 120
```

The same over HTTP (`POST /notify`, `POST /prompts`, [`docs/api.md`](docs/api.md)), from an agent through
the MCP server at `/mcp` ([`docs/mcp.md`](docs/mcp.md)), or from apprise and dagu webhooks on
`/ingest/<source>` ([`docs/ingest.md`](docs/ingest.md)). Routing, settings and env vars:
[`docs/configuration.md`](docs/configuration.md); the CLI: [`docs/cli.md`](docs/cli.md).

## Development

```sh
bun install
cp .env.example .env
bun run dev                     # bun --watch on http://127.0.0.1:7474, bun:sqlite in ./data
bin/verify                      # frozen install, tsc, bun test, boot + /health probe
```

Layout, conventions, tests and the release procedure: [CONTRIBUTING.md](CONTRIBUTING.md). Design:
[`docs/SDD.md`](docs/SDD.md).

## License

[AGPL-3.0](LICENSE). Copyright (C) 2026 rojosinalma.
