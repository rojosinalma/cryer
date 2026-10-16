# cryer v0.4.2

Smaller MCP footprint. The server instructions every MCP client injects into each conversation are now
three lines (what cryer is, `notify` vs `ask`, and that `mode:"callback"` delivers the answer into the
session later). The option shape, the reaction and reply answer paths and the `via` field moved into the
`ask` tool's description, where the agent reads them when it reaches for the tool. Nothing in the
contract changed; `ghcr.io/rojosinalma/cryer:v0.4.2` is a drop-in replacement for v0.4.1.
