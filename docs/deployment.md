# Deployment

## Image

`ghcr.io/rojosinalma/cryer:<tag>` for `linux/amd64` and `linux/arm64`, built by
`.github/workflows/release.yml` on every `v*` tag. Tags: `0.4.0`, `0.4`, `latest`, `sha-<short>`. The image
runs as the unprivileged `bun` user, reads `/app/.env` and keeps a SQLite file in `/app/data` unless
`RQLITE_URLS` is set. `docker build -t cryer .` builds it locally.

## Single node

The repo's `compose.yaml` is the single-node install: a `.env` bind-mounted read-only, the database in a
named volume, the port published on loopback only. Put a reverse proxy in front for TLS and for the public
`/interactions` path. `examples/cryer/compose.yaml` is the same thing laid out for a node directory such as
`/opt/cryer`.

```sh
mkdir -p /opt/cryer && cd /opt/cryer
curl -fsSLO https://raw.githubusercontent.com/rojosinalma/cryer/main/examples/cryer/compose.yaml
curl -fsSL  https://raw.githubusercontent.com/rojosinalma/cryer/main/examples/cryer/.env.example -o .env
chmod 600 .env && $EDITOR .env
docker compose up -d && curl -s localhost:7474/health
```

## Several replicas (HA)

cryer replicas are stateless; state lives in the store. For more than one replica:

1. **Store** — an [rqlite](https://rqlite.io) cluster of three voters (`examples/rqlite/`): copy the
   directory to each node, write `.env` (`RQLITE_NODE_ID`, `RQLITE_ADV_IP` differ per node; `RQLITE_JOIN`
   lists every voter's Raft address, the same on all), `mkdir data && chown 1000 data`, `docker compose
   up -d` on all three. `curl -s http://<node>:4001/nodes?ver=2` must show three voters and a leader.
2. **Replicas** — the single-node install on each app node with `RQLITE_URLS=http://node-a:4001,http://node-b:4001,http://node-c:4001`
   in `.env` (client-side failover) and a distinct `CRYER_NODE` (or distinct hostnames). Every replica
   runs the same compose file.
3. **Load balancer** — the replicas behind a reverse proxy with an active health check on `GET /health`
   (10 s is fine). Every replica serves every route; `/interactions` is stateless, so Discord may hit any of
   them.
4. **Gateway lease** — exactly one replica runs the Discord websocket (reaction and reply answers). The
   holder of the `gateway` row in `leases` renews it every `gateway_lease_renew_s`; the others poll at the
   same rate and take over when it is released (clean stop) or expires (`gateway_lease_ttl_s`). Nothing to
   configure; `GET /health` → `gateway.holder` shows who has it.

A two-replica deployment behind a reverse proxy looks like this:

```
 Discord ──HTTPS──► cryer.example.com  (/interactions only; everything else 404)
 agents / apprise / dagu / bin/cryer ──HTTPS──► cryer.example.internal (full API + MCP, bearer)
                                       │
                                       ▼
                        reverse proxy, active GET /health every 10 s
                        upstreams http://192.168.1.11:7474, http://192.168.1.12:7474
                               │                               │
                               ▼                               ▼
                     node-a  /opt/cryer :7474         node-b  /opt/cryer :7474
                     ghcr.io/rojosinalma/cryer:0.4.0  ghcr.io/rojosinalma/cryer:0.4.0
                               │      RQLITE_URLS (client-side failover)      │
                               ▼                                              ▼
            node-a /opt/rqlite :4001/:4002 ◄──raft──► node-b /opt/rqlite ◄──raft──► node-c /opt/rqlite
                                       rqlite 10.5, 3 voters, host network
```

### Rolling upgrade

Per node, in order: change the image tag in `compose.yaml`, `docker compose up -d` (pulls, recreates),
wait for `GET /health` → 200 on that node, then the next one. Migrations are additive and applied on boot;
a replica on the old version keeps working next to one on the new version. Rollback is the same procedure
with the previous tag; every released tag stays on ghcr.io.

## Reverse proxy

- **Public hostname**: forward `/interactions` only; answer 404 for every other path. The route is
  Ed25519-verified against `DISCORD_PUBLIC_KEY` and needs no other gate — Discord cannot pass an SSO or
  access layer in front of it.
- **Private hostname**: the full API, MCP, settings and ingest routes, protected by the bearer. Keep it on
  your private network or behind an authenticating proxy.
- Private CA on callback or ingest targets: mount the PEM and set `NODE_EXTRA_CA_CERTS`
  (`compose.override.yaml.example`).

Check: `curl -s -o /dev/null -w '%{http_code}' https://cryer.example.com/` → 404, `…/interactions` → 401
(unsigned request).

## Scheduled purge

`POST /purge` deletes messages, prompts and answers older than `purge_days`. Run it once a day from any
scheduler — a cron line with `bin/purge`, or the dagu DAG in `examples/dagu/cryer-purge.yaml`.

## Operations

| What | How |
|---|---|
| Health | `GET /health` — `ok`, `store`, `version`, `gateway:{enabled, leader, holder, connected, reply_parsing}`; 503 when the store does not answer |
| Logs | `docker logs -f cryer`; subsystems are prefixed (`[http]`, `[gateway]`, `[lease]`, `[store]`, `[queue]`, `[ingest:dagu]`…); `log_level` is a runtime setting |
| Which replica holds the gateway | `curl -s https://cryer.example.internal/health \| jq .gateway` (`holder` is the lease holder; `leader` is true only when the answering replica is it) |
| Turn reaction/reply answers off | `cryer settings gateway_enabled false` — the leader steps down within `gateway_lease_renew_s`; buttons are unaffected |
| Store health (rqlite) | `curl -s http://<node>:4001/status`, `curl -s 'http://<node>:4001/nodes?ver=2'` |
| rqlite shell | `docker run --rm -it rqlite/rqlite:10.5.3 rqlite -H <node>` |

## Failure modes

- **One rqlite voter down** — quorum is 2 of 3, the cluster keeps serving reads and writes. Bring the node
  back; it rejoins as itself (same node id, same Raft address) and catches up. A gracefully stopped node
  keeps its seat (`-raft-cluster-remove-shutdown` is deliberately off).
- **Two voters down** — quorum lost: no writes, no strong reads. cryer keeps posting notifications (routing
  falls back to `DEFAULT_CHANNEL_ID`), refuses new prompts with a reason, answers clicks with "store
  unavailable, retry". Data is not lost as long as one voter's data directory survives. Replacing a dead
  node for good: start the new one with the same node id and address, or remove the old one
  (`curl -XDELETE http://<leader>:4001/remove -d '{"id":"node-c"}'`) and join a fresh one — see rqlite's
  "Dealing with failure".
- **A cryer replica down** — the load balancer's health check drops it; the other replica serves both
  hostnames. If it held the gateway lease, another replica takes it at its next poll: at once after a clean
  stop (SIGTERM releases the lease), otherwise once the lease expires — worst case
  `gateway_lease_ttl_s + gateway_lease_renew_s` ≈ 40 s, during which reactions and replies are not seen
  (buttons still are).
- **Store unreachable from the lease holder** — it keeps the websocket until its last acknowledged lease
  expiry, then steps down; it retries acquisition with backoff (renew interval doubling, capped at the TTL).
- **Discord rejects the interactions URL** — the public path returns something other than `{type:1}` to the
  PING: check `DISCORD_PUBLIC_KEY`, and that `/interactions` reaches a replica (`curl -s
  https://cryer.example.com/interactions` → 401, not 404/502).
- **Message Content intent off** — Discord closes the gateway with code 4014; cryer reconnects without the
  intent and reports `gateway.reply_parsing: false` in `/health`. Reactions and buttons keep working.
