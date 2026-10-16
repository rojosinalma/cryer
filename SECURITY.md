# Security policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/rojosinalma/cryer/security/advisories/new)
(the **Security** tab → *Report a vulnerability*). Do not open a public issue. You will get an
acknowledgement within a week and a fix or a statement before any public disclosure.

## Supported versions

Only the latest release receives fixes. Upgrade `ghcr.io/rojosinalma/cryer` to the newest tag
before reporting.

## What the service holds

cryer runs with a Discord bot token (`DISCORD_TOKEN`), the application's public key and an API
token (`CRYER_API_TOKEN`) that every caller of the HTTP API, the MCP server and the ingest routes
must present. Keep in mind:

1. Secrets are read from `.env` only; they are never written to the database, the logs or an API
   response. The ingest `?token=` query form is redacted from logs.
2. `POST /interactions` is the only route meant to be public: it is Ed25519-verified against the
   Discord public key and needs no other gate. Keep `/notify`, `/prompts`, `/mcp`, `/settings` and
   `/ingest/*` on a private network or behind an authenticating proxy.
3. `http` callbacks only reach hosts matching the `callback_allowlist` setting; widen it deliberately.
4. The container runs as a non-root user and needs no capabilities, no host network and no Docker
   socket. Mount only `.env` (read-only) and the data volume.
