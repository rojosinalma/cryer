# MCP server

`POST /mcp` (Streamable HTTP, same bearer as the API). Tools: `notify`, `ask`, `wait`, `get`, `cancel`,
`list`.

- `notify` posts a one-way message (`level` `info|success|warning|failure`).
- `ask` takes 1–25 options (`id` + `label`; add `modal` to an option to collect free text). With
  `mode:"wait"` (default) it blocks up to `wait_s` and returns the answer, or `{status:"pending", id}` —
  then call `wait` again. With `mode:"callback"` it returns `{id, url}` at once and the answer is
  delivered into the calling [opencode](https://opencode.ai) session, detected from
  `_meta["ai.opencode/sessionID"]` or passed as `session`.
- A reply in Discord matching an option id/label picks it; any other reply is a free-text answer
  (`choice_id`/`choice_idx` `null`, `text` = the reply; `via` says how it arrived).
- `get`, `list` and `cancel` manage prompts.

opencode config example:

```jsonc
"mcp": { "servers": { "cryer": { "type": "remote", "url": "https://cryer.example.internal/mcp",
  "headers": { "Authorization": "Bearer {env:CRYER_API_TOKEN}" } } } }
```

The server description cryer hands to the client (in `src/mcp.ts`) explains the same contract to the
agent, so no extra prompt text is needed.
