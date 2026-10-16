# cryer 0.5.0

Image: `ghcr.io/rojosinalma/cryer:0.5.0` (`linux/amd64`, `linux/arm64`). Licence: AGPL-3.0.

## Highlights

- **Install cryer to your account, not only to a server.** Enable *User Install* in the Developer Portal's
  Installation page, click **Add to my apps**, and notifications and prompts arrive in your DM with the bot —
  buttons, reactions and replies included. Replies in DMs need no privileged Message Content intent.
- **`dm:<user_id>` targets.** Everywhere a channel id was accepted (`default_channel`, `route.*`,
  `DEFAULT_CHANNEL_ID`, `channel` on the API, MCP and CLI) a DM target works too. The DM channel is opened
  once and cached in the new `dm_channels` table, shared by every replica.
- **`/cryer here`.** One slash command sets `default_channel` to the place you run it in: the bot's DM or a
  server channel. `command_users` restricts who may run it; `commands_register` turns boot registration off.
- `/health.gateway.reply_parsing_dm` reports reply matching for DMs.

## Breaking changes

None. Existing channel-id targets, routes and `DEFAULT_CHANNEL_ID` values behave as before. The slash
command is registered globally on the first boot of a 0.5.0 replica (set `commands_register=false` before
upgrading if another tool owns the application's commands).

## Upgrade

1. In the Developer Portal → **Installation**, tick *User Install* (scope `applications.commands`) and
   *Guild Install* (`applications.commands` + `bot` with the usual permissions), then save.
2. Set the image tag to `0.5.0` and `docker compose up -d` on each replica. Migration `0003_dm.sql` adds the
   `dm_channels` table on boot; the command set is registered automatically (global commands take up to an
   hour to show in Discord clients).
3. Type `/cryer here` in the bot's DM or in the channel you want — or leave `default_channel` as it is.

Full changelog: [CHANGELOG.md](https://github.com/rojosinalma/cryer/blob/main/CHANGELOG.md#050---2026-10-16).
