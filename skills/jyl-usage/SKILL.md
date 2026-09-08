---
name: jyl-usage
description: Inspect or drive the JianyueLab usage reporter for the Antigravity CLI (status, flush, backfill)
---

Run the reporter's CLI and report what it says. The script is `./scripts/run`
inside this plugin's directory; every invocation needs `--host antigravity`.

| Ask | Command |
|---|---|
| status (default) | `./scripts/run --host antigravity --status` |
| retry queued uploads | `./scripts/run --host antigravity --flush` |
| rescan recent conversations | `./scripts/run --host antigravity --backfill 30` |

Summarise the output in a sentence or two. If it says it is not reporting:

- **no base URL / no API key** — export `JYL_USAGE_BASE_URL` (the portal
  origin, *not* its `/v1` base) and `JYL_API_KEY`, or write
  `~/.config/jyl-usage/config.json`:

  ```json
  { "baseUrl": "https://llm.jianyuelab.net", "apiKey": "jyl-…" }
  ```

- **disabled** — `"enabled": false` in that file, or `JYL_USAGE_DISABLED=1`.
- **no sqlite backend** — the reporter needs `bun`, a Node with `node:sqlite`,
  or the `sqlite3` binary on `PATH`.

Do not edit the config file unless asked; it holds a secret.
