# Features

1. **Notifications** as embeds, routed to channels by `source` and `level` (`info|success|warning|failure`).
2. **Prompts**: up to 25 options as buttons; an option may open a **modal** for free text.
3. **Reactions and replies** as answers (1️⃣…9️⃣, or a reply matched to an option — unmatched text is a
   free-text answer).
4. **First-writer-wins** answers across replicas; the message is edited to show who chose what, and how.
5. **Callbacks**: `http` (POST/PUT to an allowlisted host) or `opencode-session` (hand the answer to an
   [opencode](https://opencode.ai) agent session).
6. **MCP server** (`/mcp`, Streamable HTTP) with `notify`, `ask`, `wait`, `get`, `cancel`, `list` — [mcp.md](mcp.md).
7. **Ingest adapters** for apprise (`json://`) and dagu (webhook channel, with a **Retry run** button) — [ingest.md](ingest.md).
8. **CLI** `bin/cryer` — a curl wrapper for notify/ask/wait/list/settings — [cli.md](cli.md).
9. **HA-ready**: stateless replicas over [rqlite](https://rqlite.io), a store lease picks the one gateway
   listener — [deployment.md](deployment.md).
10. **Runtime settings** in the database, editable through the API — no restarts for routing or TTLs —
    [configuration.md](configuration.md).

How answers flow end to end is described in [SDD.md](SDD.md) → Key flows.
