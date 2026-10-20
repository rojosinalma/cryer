# cryer 0.5.2

Image: `ghcr.io/rojosinalma/cryer:0.5.2` (`linux/amd64`, `linux/arm64`). Licence: AGPL-3.0.

## Highlights

- **A link on apprise-style notifications.** `POST /ingest/apprise` now takes an optional `url`. When it is an
  `http://` or `https://` URL the Discord embed's title links to it and a **Link** field shows it, the same
  way dagu run links already work. Anything that is not an http(s) URL is ignored and the notification posts
  as before, so a bad link never costs you the alert. apprise itself does not send the key; it is for senders
  that post apprise-shaped JSON directly (the deployer does).

## Breaking changes

None.

## Upgrade

1. Set the image tag to `0.5.2` and `docker compose up -d` on each replica. No migration, no new settings.

Full changelog: [CHANGELOG.md](https://github.com/rojosinalma/cryer/blob/main/CHANGELOG.md#052---2026-10-20).
