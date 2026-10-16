# CLI

`bin/cryer` is a curl wrapper. It reads `CRYER_URL` (default `http://127.0.0.1:7474`) and
`CRYER_API_TOKEN` from the environment or `~/.config/cryer/env` (`KEY=VALUE` lines). It needs `curl` and
`jq`.

```sh
cryer notify -l warning -s backup "Disk 95% full" "nas root"
cryer ask "Deploy v1.2?" -o yes=Deploy -o no=Skip --ttl 600 --wait 300
cryer notify -c dm:345678901234567890 "Just for you"      # -c/--channel: a channel id or dm:<user_id>
cryer wait <id> [timeout]
cryer get <id> | cryer list [status] [limit] | cryer cancel <id>
cryer settings [key [value]]
cryer purge                    # also bin/purge, for a daily scheduled job
```

`cryer -h` prints every flag. Copy or symlink `bin/cryer` onto your `PATH` to use it from anywhere.
