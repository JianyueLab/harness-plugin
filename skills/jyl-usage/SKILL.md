---
name: jyl-usage
description: Inspect or drive the JianyueLab usage reporter (status, flush, backfill)
---

Run the reporter's CLI and report what it says. The script is `scripts/run`
in this plugin's root.

**This directory is visible under both hosts this plugin supports** — the
Antigravity CLI (`agy`), which this skill was originally written for, and
Claude Code, which loads a plugin's `skills/` too — so work out which one
asked before running anything:

- **Claude Code**: `${CLAUDE_PLUGIN_ROOT}` is set. Use
  `"${CLAUDE_PLUGIN_ROOT}/scripts/run"`, with **no** `--host` flag (the
  reporter defaults to Claude Code). Prefer `/jyl-usage`
  (`commands/jyl-usage.md`) if it is available; this skill covers the same
  three verbs in case it is not.
- **Antigravity CLI**: `${CLAUDE_PLUGIN_ROOT}` will not be set. Resolve the
  plugin root yourself from this file's own path (it lives at
  `<plugin root>/skills/jyl-usage/SKILL.md`), and add `--host antigravity` to
  **every** invocation below.

| Ask | Command |
|---|---|
| status (default) | `<plugin root>/scripts/run --status` |
| retry queued uploads | `<plugin root>/scripts/run --flush` |
| rescan recent conversations | `<plugin root>/scripts/run --backfill 30` |

Summarise the output in a sentence or two. If it says it is not reporting:

- **no base URL / no API key** — export `JYL_USAGE_BASE_URL` (the portal
  origin, *not* its `/v1` base) and `JYL_API_KEY`, or write
  `~/.config/jyl-usage/config.json` (shared by both hosts):

  ```json
  { "baseUrl": "https://llm.jianyuelab.net", "apiKey": "jyl-…" }
  ```

- **disabled** — `"enabled": false` in that file, or `JYL_USAGE_DISABLED=1`.
- **no sqlite backend** (Antigravity only) — the reporter needs `bun`, a Node
  with `node:sqlite`, or the `sqlite3` binary on `PATH`, to read `agy`'s
  conversation databases.
- **the note about `ANTHROPIC_BASE_URL`** (Claude Code only) — this session
  already talks to the portal, so its `/v1` proxy metered these turns on the
  way past and reporting them again would count the same tokens twice.
  Nothing to fix.

Do not edit the config file unless asked; it holds a secret.
