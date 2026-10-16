# cryer 0.4.0

Image: `ghcr.io/rojosinalma/cryer:0.4.0` (`linux/amd64`, `linux/arm64`). Licence: MIT.

## Highlights

- Site-neutral defaults: `callback_allowlist` covers the private ranges, `dagu_url` and `OPENCODE_URL` are
  empty until you set them.
- New `OPENCODE_SERVER_USERNAME` (default `opencode`) for the opencode-session callback.
- Multi-arch images with `<version>`, `<major>.<minor>`, `latest` and `sha-<short>` tags; `compose.yaml`
  runs the published image, `compose.dev.yaml` is the bind-mounted development setup.
- Deployment examples under `examples/` (replica, rqlite voter, scheduled purge) and documentation under
  `docs/` — configuration, API, MCP, CLI, ingest adapters, deployment, design.

## Behaviour changes for existing installs

- New setting defaults apply only to fresh databases and unset env vars; existing `settings` rows are untouched.
- `OPENCODE_URL` no longer defaults to a host — set it or the `opencode-session` callback stays disabled.
- `dagu_url` empty → the dagu **Retry run** button is omitted (set it to keep the button).
- A private CA is no longer baked into the image: mount the PEM and set `NODE_EXTRA_CA_CERTS`
  (`compose.override.yaml.example`).
- `bin/cryer` defaults to `http://127.0.0.1:7474`; set `CRYER_URL` (env or `~/.config/cryer/env`).

## Upgrade

1. Check `.env` on every replica: `OPENCODE_URL`, `OPENCODE_SERVER_USERNAME`, and the CA mount if you need one.
2. Set the image tag to `0.4.0`, `docker compose up -d` one replica at a time, `GET /health` on each.
3. Re-check the Interactions Endpoint URL in the Discord portal (a failed PING during the roll disables
   buttons silently).
