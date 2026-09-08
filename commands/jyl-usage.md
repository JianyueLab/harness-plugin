---
description: Inspect or drive the JianyueLab usage reporter (status, flush, backfill)
argument-hint: "[status | flush | backfill [days]]"
---

Run the JianyueLab usage reporter's CLI and report what it says.

The subcommand the user asked for is `$ARGUMENTS` (empty means `status`). The
script is `scripts/run` in this plugin's root. When `${CLAUDE_PLUGIN_ROOT}` is
set, use it. **It will not be set if you are reading this as an Antigravity
skill** — Antigravity converts this file into one, but sets no such variable —
so in that case resolve the plugin root yourself from this file's own path
(it lives at `<plugin root>/commands/jyl-usage.md`) and use
`<plugin root>/scripts/run` instead. Under Antigravity, also append
`--host antigravity` to every invocation below — the reporter defaults to
Claude Code.

Map the subcommand to exactly one `Bash` call:

| Argument            | Command                                              | What it does |
|---------------------|------------------------------------------------------|--------------|
| _(empty)_ / `status`| `"<plugin root>/scripts/run" --status`        | Where it reports to, whether it is configured, how many events are waiting to retry, recent log lines. Reads only. |
| `flush`             | `"<plugin root>/scripts/run" --flush`         | Retry events queued by earlier failed uploads. |
| `backfill [days]`   | `"<plugin root>/scripts/run" --backfill [days]` | Scan **every** transcript touched in the last N days (default 30) and report anything not sent yet. Safe to repeat: the portal deduplicates on request id. |

Then summarise the output in a sentence or two. If the status says it is not
reporting, say why and point at the fix:

- **no base URL / no API key** — the reporter needs both. Either export
  `JYL_USAGE_BASE_URL` (the portal origin, *not* its `/v1` base) and `JYL_API_KEY`
  in the shell, or write `~/.claude/jyl-usage/config.json`:

  ```json
  { "baseUrl": "https://llm.jianyuelab.net", "apiKey": "jyl-…" }
  ```

  Portal keys come from the portal's **API keys** page.

- **disabled** — `"enabled": false` in that config file, or `JYL_USAGE_DISABLED=1`
  in the environment.

- **the note about `ANTHROPIC_BASE_URL`** — this session already talks to the
  portal, so its `/v1` proxy metered these turns on the way past and reporting
  them again would count the same tokens twice. Nothing to fix.

Do not edit the config file unless the user asks you to; it holds a secret.
