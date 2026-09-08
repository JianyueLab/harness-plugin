# jyl-usage

One repository, one reporter, two hosts. This plugin reports **token usage**
to the JianyueLab LLM portal ([`llm-web`](https://github.com/JianyueLab/llm-web))
for both Claude Code and the Antigravity CLI (`agy`) — install it into
either, or both; each host reports its own usage independently, through the
same core code.

The portal meters everything that goes through its `/v1` proxy. Neither host
usually does: Claude Code talks to Anthropic directly and bills an Anthropic
subscription, `agy` talks to Google's own Code Assist protocol and bills a
Gemini subscription, so from the portal's side that spend is invisible either
way. This plugin closes that gap — after every turn it reads whatever local
record that host already keeps (Claude Code's session transcript, `agy`'s
per-conversation SQLite database), extracts the token counts, and POSTs them
to `/v1/usage/ingest`. The portal stores them beside gateway traffic, tagged
`source = 'claude-code'` or `source = 'antigravity'`.

**Only counts leave the machine.** Model id, timestamp, request id and token
totals. Never prompts, completions, file contents, file paths or project names.

**Imported usage never eats your gateway allowance.** Those tokens were billed
outside the gateway — an Anthropic subscription for Claude Code, a Gemini
subscription for `agy` — and counting them against the portal's monthly limit
would charge them twice. They show up in every report and in the leaderboard,
and the limit stays gateway-only.

## Install (Claude Code)

```sh
/plugin marketplace add JianyueLab/claude-plugin
/plugin install jyl-usage@jianyuelab-claude
```

Requires `bun` or `node` on `PATH` (set `JYL_USAGE_RUNTIME` to an absolute path
if neither resolves inside Claude Code's environment). There is nothing to
build: the plugin is the source.

## Install (Antigravity CLI)

Same repository, no separate checkout: the two manifests sit side by side at
the root (`.claude-plugin/plugin.json` for Claude Code, `plugin.json` for
`agy`), so installing either host copies the whole thing and the manifests do
not interfere with each other.

What is actually verified, from a checkout of this repo:

```sh
$ agy plugin validate .
  [ok]    .
          ✔ skills      : 1 processed
          - agents      : skipped (not found)
          ✔ commands    : 1 processed (converted to skills)
          - mcpServers  : skipped (not found)
          ✔ hooks       : 1 processed
```

What is **not** verified: `agy plugin install <path-to-this-checkout>` is the
documented, expected route to actually install it — `agy plugin --help` lists
`install <target>` — but nobody has run it against this plugin. It was
deliberately withheld, both while building this and while writing this
README: it writes into your own `agy` customization root and its own
`config.json`, which is not something to run on a reader's behalf sight
unseen, and this plugin's own reports would currently just queue anyway (see
*Things worth knowing* below). Run `agy plugin install` yourself; if what it
does differs from what is written here, this section needs correcting.

Requires `bun` or `node` on `PATH` for the launcher itself (as above), plus —
specifically for reading `agy`'s conversation databases — one of `bun`'s
built-in SQLite, Node's `node:sqlite` (22.5+), or the `sqlite3` binary.
`./scripts/run --host antigravity --status` says which one it found.

## Configure

Two values: the portal **origin** and a portal API key (`jyl-…`, from the
portal's *API keys* page). Either export them —

```sh
export JYL_USAGE_BASE_URL="https://llm.jianyuelab.net"
export JYL_API_KEY="jyl-…"
```

— or write a config file. One file can serve both hosts:

```json
{
  "baseUrl": "https://llm.jianyuelab.net",
  "apiKey": "jyl-…"
}
```

Checked in this order, first match wins: the **environment**, then
`~/.config/jyl-usage/config.json` (shared — write here once and both hosts
read it), then the host's own file — `~/.claude/jyl-usage/config.json` for
Claude Code, `~/.gemini/jyl-usage/config.json` for the Antigravity CLI. The
environment always wins, so a shell that already exports `JYL_API_KEY` for
Claude Code's `apiKeyHelper` needs no second copy of the secret on disk; an
existing `~/.claude/jyl-usage/config.json` keeps working exactly as before —
the shared file is optional, and only worth adding once you also want the
Antigravity CLI reporting without a second copy of the key on disk.

> `baseUrl` is the **origin**, not the `…/v1` base every SDK wants — this posts
> to `<origin>/v1/usage/ingest`. A trailing `/v1` is stripped rather than
> silently 404ing.

Optional keys in the config file:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the plugin off without uninstalling it (`JYL_USAGE_DISABLED=1` does the same). |
| `reportGatewayTraffic` | `false` | Claude Code only — report even when this session already talks to the portal directly; see below. `agy` cannot talk to the portal in the first place, so this key does nothing there. |

**Until it is configured the plugin does nothing at all**, silently. An install
without a key is inert, not noisy.

## Use

Day to day there is nothing to run on either host — the hooks do the work.
When you do want to check in:

**Claude Code** — run `/jyl-usage`:

| | |
|---|---|
| `/jyl-usage` | Where it reports, whether it is configured, how many events are waiting to retry, recent log lines. |
| `/jyl-usage flush` | Retry events queued by earlier failed uploads. |
| `/jyl-usage backfill [days]` | Scan **every** transcript touched in the last N days (default 30) and report anything not sent yet. Safe to repeat. |

Or call the script directly: `"$CLAUDE_PLUGIN_ROOT/scripts/run" --status`.

**Antigravity CLI** — ask the `jyl-usage` skill the same three things, or call
the script directly with `--host antigravity`, which every invocation needs
on this host (the reporter defaults to Claude Code):

```sh
./scripts/run --host antigravity --status
./scripts/run --host antigravity --flush
./scripts/run --host antigravity --backfill [days]
```

Two instruction files carry these same three verbs, and that split is
deliberate, not duplication: `commands/jyl-usage.md` is Claude Code's slash
command, `skills/jyl-usage/SKILL.md` is `agy`'s skill — each host reads its
own directory for this. `agy` additionally converts *any* `commands/*.md` it
finds into a skill of its own (`agy plugin validate .` reports it: "commands
: 1 processed (converted to skills)"), so `commands/jyl-usage.md` is written
to stay correct if Antigravity surfaces that converted copy too — it resolves
the script's path itself when `${CLAUDE_PLUGIN_ROOT}` is unset (which it will
be there) and says to add `--host antigravity`.

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

## How it works (agy)

```
agy turn ends
  └─ Stop hook (blocking!) → scripts/run --detach → prints {} and forks
        reads conversations/<id>.db rows after the recorded idx
        walks each generation blob for model, request id and counts
        POST <portal>/v1/usage/ingest  { source: "antigravity", events: [...] }
```

Only one hook, `Stop` — `agy` has no `PreCompact`/`SessionEnd` equivalent, and
`PreInvocation` fires before every model call, which would multiply the work
for nothing. Unlike Claude Code's hooks, `agy`'s are not `async`: a handler
runs synchronously and blocks the next turn until it returns. `--detach` is
how `scripts/run` copes — it reads the hook's stdin itself (the forked child
cannot, since the parent already owns it), forks the real read-and-report
work into the background with its stdout and stderr redirected away from the
hook's own, and replies `{}` in milliseconds so the agent loop never waits on
a slow read, a held lock, or a slow portal. The catch-up sweep covers what a
missed `Stop` would otherwise strand, same as on Claude Code.

## State

State lives per host — `~/.claude/jyl-usage/` for Claude Code,
`~/.gemini/jyl-usage/` for the Antigravity CLI — each holding the same five
files below and tracking only that host's own units (transcripts, or
conversation databases). Nothing is shared between the two: not the lock, not
the dedup window, not the spool.

| File | Holds |
|---|---|
| `state.json` | Per-unit cursor — a byte offset for Claude Code, a `gen_metadata` row index for Antigravity — so each line or row is read exactly once. Rewritten only when a cursor actually moves. |
| `seen` | The dedup window — the last few thousand request ids sent, newest last. Its own file because `state.json` is touched every turn and this is the part that grows. |
| `spool.jsonl` | Events read but not yet accepted. Retried on every later run. |
| `log` | What happened, capped at 256 KB. |
| `lock` | Serialises concurrent sessions; stale after 60 s. |

### Things worth knowing

**Reporting Antigravity usage needs a portal change that has not shipped
yet.** The portal's ingest route only accepts a fixed list of `source`
values, and `antigravity` is not on it until `llm-web` deploys that addition
— a separate repo, a separate PR. Until then, every upload this host makes
gets a 400 back. Nothing is lost: the reporter recognises that specific
rejection and spools it for retry rather than dropping it, the same as a
revoked API key, so those events are sent — once, deduplicated, in full — the
first time a hook or `flush` runs after the portal catches up. But installing
today gets you a growing queue, not a report: `--status --host antigravity`
will show events awaiting retry that stay queued for a while, not a source
freshly visible in the portal's reports.

**`agy`'s hooks block, so the work is detached.** Unlike Claude Code's hooks,
`agy` has no `async` flag — a `Stop` handler runs synchronously and holds up
the next turn until it returns. `scripts/run --detach` forks the actual
read-and-report work into the background and replies to the hook immediately,
so a slow read, a held lock, or a slow portal never becomes a pause the user
feels. See *How it works (agy)* above.

**The field mapping is inferred, not documented, so drift under-reports
rather than misreports.** `agy` ships no schema for its
`conversations/<id>.db` protobuf blobs; the token fields were found by
inspecting real ones. Every row is checked against two invariants before it
is trusted — the output total must equal thinking-plus-text, and every field
number present in the counts message must be one this plugin has actually
seen — and a row that fails either is skipped and logged, never guessed at.
If a future `agy` renumbers these fields, `--status` and the log show *fewer*
events reported, not wrong numbers reported as if they were right.

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

**A failed upload never loses usage.** Events go to the spool and the cursor
still advances, so the same lines or rows are not read forever. Both writes
happen after the upload, in the order spool-then-cursor, so every crash window
re-reads rather than dropping — and a re-read is free, because the portal
stores it once.

**A wrong key is retried; a bad payload is not.** `401`/`403`/`429`/`5xx` spool
for later, because someone will fix the key — an unrecognised `source` (above)
gets the same treatment. Anything else is logged and dropped, because retrying
it forever would only grow the spool.

**Sessions already pointed at the portal are skipped — on Claude Code only.**
If `ANTHROPIC_BASE_URL` names the same host as `baseUrl`, the portal's `/v1`
proxy metered those turns on the way past, and reporting them again would
count the same tokens under two sources. Set `"reportGatewayTraffic": true` to
override. `agy` speaks Google's Code Assist protocol, which `/v1` does not
serve, so there is no way for it to already be metered and nothing to skip.

**Locally fabricated messages are ignored.** Claude Code writes
`model: "<synthetic>"` entries for API errors and interrupts; no request was
made, so there is nothing to report.

**Cache tokens are split by TTL**, because the vendor prices them differently
(5-minute writes at 1.25× input, 1-hour writes at 2×, reads at 0.1×). The portal
applies those multipliers against the model's input rate; older transcripts that
carry only a cache-creation total are attributed to the cheaper 5-minute bucket.
This is Claude-specific pricing; Gemini's implicit caching has no separately
priced write, so Antigravity events always carry `0` in both write buckets.

## Portal side

`POST /v1/usage/ingest`, authenticated with a portal key as
`Authorization: Bearer` or `x-api-key`, like every other `/v1` route. Same
route, same event shape, for both hosts — only `source` and `client` differ:

```jsonc
{
  "source": "claude-code",                        // or "antigravity"
  "client": "claude-code-usage-reporter/0.3.0",    // or "antigravity-usage-reporter/0.3.0"
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

Max 500 events per request (a larger batch is rejected, not truncated).
`source` is a whitelist on the portal's side — as of this writing it accepts
`"claude-code"` but not yet `"antigravity"` (see *Things worth knowing*
above) — and an unrecognised value there gets a 400 that this plugin treats
as a transient failure and spools, not a dropped payload. The route is
otherwise deliberately ungated: it spends nothing, so refusing a report
because the reporter is over its allowance would only throw away the evidence
that they are.
