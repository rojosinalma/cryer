# cryer 0.5.1

Image: `ghcr.io/rojosinalma/cryer:0.5.1` (`linux/amd64`, `linux/arm64`). Licence: AGPL-3.0.

## Highlights

- **`/cryer status`.** One ephemeral reply with the cryer version, where notifications land right now (your
  DM, a channel mention or *unset*), every `route.*` override and the gateway state of the replica that
  answered (leader or follower with the lease holder, connected, reply parsing, reply parsing in DMs).
- **`/cryer forget`.** Undoes `/cryer here`: `default_channel` goes back to the `DEFAULT_CHANNEL_ID` fallback
  (or becomes unset when that is empty). `route.*` settings stay as they are.
- Both commands honour `command_users` like `/cryer here` and are registered on the next boot by the existing
  diff-and-PUT registration (`commands_register`).
- `bin/deploy` waits up to `DEPLOY_START_TIMEOUT_S` (180 s) for the deployer's synchronous image pull instead
  of giving up after the generic 20 s HTTP timeout.

## Breaking changes

None.

## Upgrade

1. Set the image tag to `0.5.1` and `docker compose up -d` on each replica. No migration; the extended command
   set is registered automatically on the first boot (global commands take up to an hour to show in Discord
   clients).
2. Type `/cryer status` in the bot's DM or a server channel to check where cryer posts.

Full changelog: [CHANGELOG.md](https://github.com/rojosinalma/cryer/blob/main/CHANGELOG.md#051---2026-10-16).
