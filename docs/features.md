# Features

1. **Notifications** as embeds, routed by `source` and `level` (`info|success|warning|failure`) to a
   **target**: a server channel (`<channel_id>`) or a user's DM (`dm:<user_id>`) —
   [configuration.md](configuration.md) → Targets.
2. **User-installable**: add cryer to your Discord account instead of a server and it delivers to your
   DM; the DM channel is opened once and cached in the store. Reply answers in DMs work without the
   privileged Message Content intent.
3. **`/cryer here`**: one slash command, run in the bot's DM or in a server channel, sets `default_channel`
   to that place (`dm:<your id>` or the channel id). Restricted with the `command_users` setting;
   registration on boot is idempotent and can be turned off with `commands_register`.
4. **Prompts**: up to 25 options as buttons; an option may open a **modal** for free text.
5. **Reactions and replies** as answers (1️⃣…9️⃣, or a reply matched to an option — unmatched text is a
   free-text answer).
6. **First-writer-wins** answers across replicas; the message is edited to show who chose what, and how.
7. **Callbacks**: `http` (POST/PUT to an allowlisted host) or `opencode-session` (hand the answer to an
   [opencode](https://opencode.ai) agent session).
8. **MCP server** (`/mcp`, Streamable HTTP) with `notify`, `ask`, `wait`, `get`, `cancel`, `list` — [mcp.md](mcp.md).
9. **Ingest adapters** for apprise (`json://`) and dagu (webhook channel, with a **Retry run** button) — [ingest.md](ingest.md).
10. **CLI** `bin/cryer` — a curl wrapper for notify/ask/wait/list/settings — [cli.md](cli.md).
11. **HA-ready**: stateless replicas over [rqlite](https://rqlite.io), a store lease picks the one gateway
    listener — [deployment.md](deployment.md).
12. **Runtime settings** in the database, editable through the API — no restarts for routing or TTLs —
    [configuration.md](configuration.md).

How answers flow end to end is described in [SDD.md](SDD.md) → Key flows.
