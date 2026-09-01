# jyl-usage

A Claude Code plugin that reports **token usage** to the JianyueLab LLM portal
([`llm-web`](https://github.com/JianyueLab/llm-web)).

The portal meters everything that goes through its `/v1` proxy. Claude Code
usually does not: it talks to Anthropic directly and bills an Anthropic
subscription, so from the portal's side that spend is invisible. This plugin
closes that gap — after every turn it reads the session transcript Claude Code
already writes, extracts the token counts, and POSTs them to
`/v1/usage/ingest`. The portal stores them beside gateway traffic with
`source = 'claude-code'`.

**Only counts leave the machine.** Model id, timestamp, request id and token
totals. Never prompts, completions, file contents, file paths or project names.

**Imported usage never eats your gateway allowance.** Those tokens were billed
on the Anthropic subscription; counting them against the portal's monthly limit
would charge them twice. They show up in every report and in the leaderboard,
and the limit stays gateway-only.

## Install

```sh
/plugin marketplace add JianyueLab/claude-plugin
/plugin install jyl-usage@jianyuelab-claude
```

Requires `bun` or `node` on `PATH` (set `JYL_USAGE_RUNTIME` to an absolute path
if neither resolves inside Claude Code's environment). There is nothing to
build: the plugin is the source.

## Configure

Two values: the portal **origin** and a portal API key (`jyl-…`, from the
portal's *API keys* page). Either export them —

```sh
export JYL_USAGE_BASE_URL="https://llm.jianyuelab.net"
export JYL_API_KEY="jyl-…"
```

— or write `~/.claude/jyl-usage/config.json`:

```json
{
  "baseUrl": "https://llm.jianyuelab.net",
  "apiKey": "jyl-…"
}
```

The environment wins, so a shell that already exports `JYL_API_KEY` for Claude
Code's `apiKeyHelper` needs no second copy of the secret on disk.

> `baseUrl` is the **origin**, not the `…/v1` base every SDK wants — this posts
> to `<origin>/v1/usage/ingest`. A trailing `/v1` is stripped rather than
> silently 404ing.

Optional keys in the config file:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the plugin off without uninstalling it (`JYL_USAGE_DISABLED=1` does the same). |
| `reportGatewayTraffic` | `false` | Report even when this session already talks to the portal — see below. |

**Until it is configured the plugin does nothing at all**, silently. An install
without a key is inert, not noisy.

## Use

Run `/jyl-usage` inside Claude Code:

| | |
|---|---|
| `/jyl-usage` | Where it reports, whether it is configured, how many events are waiting to retry, recent log lines. |
| `/jyl-usage flush` | Retry events queued by earlier failed uploads. |
| `/jyl-usage backfill [days]` | Scan **every** transcript touched in the last N days (default 30) and report anything not sent yet. Safe to repeat. |

Or call the script directly: `"$CLAUDE_PLUGIN_ROOT/scripts/run" --status`.

Day to day there is nothing to run — the hooks do the work.

## How it works

```
Claude Code turn ends
  └─ Stop hook (async)  →  scripts/run  →  src/reporter.mjs
        reads $transcript_path from the last recorded byte offset
        sweeps every other tracked transcript that has grown since
        keeps assistant entries that carry message.usage
        POST <portal>/v1/usage/ingest   { source: "claude-code", events: [...] }
```

Hooks: `SessionStart`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd` — all
declared `async`, so nothing ever waits on an upload. Any of them also drains
the spool and runs the catch-up sweep, so usage from a session that ended while
the portal was down — or that ended without a last hook at all — is sent by
whichever session next fires one.

State lives in `~/.claude/jyl-usage/`:

| File | Holds |
|---|---|
| `state.json` | Per-transcript byte offset, so each line is read exactly once. Rewritten only when an offset actually moves. |
| `seen` | The dedup window — the last few thousand request ids sent, newest last. Its own file because `state.json` is touched every turn and this is the part that grows. |
| `spool.jsonl` | Events read but not yet accepted. Retried on every later run. |
| `log` | What happened, capped at 256 KB. |
| `lock` | Serialises concurrent sessions; stale after 60 s. |

### Things worth knowing

**Nothing waits for someone to notice it.** Reading only the transcript named
in the hook payload left usage stranded whenever a run had no chance to finish
the file: a hook that lost the lock to a concurrent session, or a session killed
before its last turn was read. Those bytes were not late, they were lost —
`backfill` could recover them, but only for people who knew to run it. Every run
now also sweeps the transcripts it already tracks for bytes nothing came back
for, newest first, capped per run so no single hook does an unbounded amount of
work.

**Duplicates are impossible, by design at both ends.** Claude Code writes one
transcript entry per content block, so a single API request that produced text
*and* a tool call appears twice with the same `requestId` and the same `usage`.
Resuming a session goes further and copies its whole history into a new
transcript file. The plugin filters both against one global dedup window — per
transcript would not have recognised the fork — and the portal deduplicates on
request id under a unique index regardless, which is what makes retrying safe
and `backfill` safe to run as often as you like.

**A failed upload never loses usage.** Events go to the spool and the byte
offset still advances, so the same lines are not read forever. Both writes
happen after the upload, in the order spool-then-offset, so every crash window
re-reads lines rather than dropping them — and a re-read line is free, because
the portal stores it once.

**A wrong key is retried; a bad payload is not.** `401`/`403`/`429`/`5xx` spool
for later, because someone will fix the key. Anything else is logged and
dropped, because retrying it forever would only grow the spool.

**Sessions already pointed at the portal are skipped.** If `ANTHROPIC_BASE_URL`
names the same host as `baseUrl`, the portal's `/v1` proxy metered those turns
on the way past, and reporting them again would count the same tokens under two
sources. Set `"reportGatewayTraffic": true` to override.

**Locally fabricated messages are ignored.** Claude Code writes
`model: "<synthetic>"` entries for API errors and interrupts; no request was
made, so there is nothing to report.

**Cache tokens are split by TTL**, because the vendor prices them differently
(5-minute writes at 1.25× input, 1-hour writes at 2×, reads at 0.1×). The portal
applies those multipliers against the model's input rate; older transcripts that
carry only a cache-creation total are attributed to the cheaper 5-minute bucket.

## Portal side

`POST /v1/usage/ingest`, authenticated with a portal key as
`Authorization: Bearer` or `x-api-key`, like every other `/v1` route.

```jsonc
{
  "source": "claude-code",
  "client": "claude-code-usage-reporter/0.1.0",
  "events": [
    {
      "requestId": "req_011Ce…",      // dedup key; falls back to messageId
      "messageId": "msg_011Ce…",
      "ts": "2026-08-20T07:07:50.232Z",
      "model": "claude-opus-5",
      "inputTokens": 2,               // uncached input
      "outputTokens": 389,
      "cacheWrite5mTokens": 0,
      "cacheWrite1hTokens": 18259,
      "cacheReadTokens": 22141
    }
  ]
}
```

Response — per-event, so one malformed entry never blocks its neighbours:

```json
{ "received": 5, "accepted": 2, "duplicates": 1, "rejected": [{ "index": 3, "reason": "too_old" }] }
```

Max 500 events per request (a larger batch is rejected, not truncated). The
route is deliberately ungated: it spends nothing, so refusing a report because
the reporter is over its allowance would only throw away the evidence that they
are.
