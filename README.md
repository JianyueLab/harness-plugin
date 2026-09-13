# jyl-usage & jyl-wakatime

Two independent tools live in this repository, sharing only the spool / file
lock / log plumbing in `src/core/store.mjs` — nothing else:

- **[`jyl-usage`](#jyl-usage)** reports **token usage** to the JianyueLab LLM
  portal, for Claude Code and the Antigravity CLI (`agy`).
- **[`jyl-wakatime`](#jyl-wakatime)** reports **harness's coding activity** —
  which files an agent run touched, and how many tokens it spent — to
  WakaTime.

They are separate tools on purpose, not two modes of one tool. `jyl-usage`'s
promise to the people who install it is that only counts leave the machine;
WakaTime's required `entity` field *is* a file path. Folding the second into
the first would mean anyone who already trusted `jyl-usage` starts shipping
file paths after an update they never read the notes for — that is a
different consent story, not a config flag on the old one.

## jyl-usage

One reporter, two hosts. jyl-usage reports **token usage** to the JianyueLab
LLM portal ([`llm-web`](https://github.com/JianyueLab/llm-web)) for both
Claude Code and the Antigravity CLI (`agy`) — install it into either, or
both; each host reports its own usage independently, through the same core
code.

The portal meters everything that goes through its `/v1` proxy. Neither host
usually does: Claude Code talks to Anthropic directly and bills an Anthropic
subscription, `agy` talks to Google's own Code Assist protocol and bills a
Gemini subscription, so from the portal's side that spend is invisible either
way. jyl-usage closes that gap — after every turn it reads whatever local
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

### Install (Claude Code)

```sh
/plugin marketplace add JianyueLab/claude-plugin
/plugin install jyl-usage@jianyuelab-claude
```

Requires `bun` or `node` on `PATH` (set `JYL_USAGE_RUNTIME` to an absolute path
if neither resolves inside Claude Code's environment). There is nothing to
build: the plugin is the source.

### Install (Antigravity CLI)

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

$ agy plugin install "$PWD"
  [ok]    jyl-usage
          ✔ skills      : 1 processed
          - agents      : skipped (not found)
          ✔ commands    : 1 processed (converted to skills)
          - mcpServers  : skipped (not found)
          ✔ hooks       : 1 processed
```

A bare absolute path is the route that works — `agy plugin --help` lists
`install <target>`, and no `agy plugin import from claude` and no
marketplace-file dance was needed.

**The install copies a full local snapshot of the checkout, `.git` included —
it does not link to it and does not fetch from `origin`.** `agy plugin list`
shows the installed copy by name; it lands wherever `agy`'s own customization
root keeps plugins (`~/.gemini/config/plugins/<name>` at the time this was
verified). Because it is a snapshot, a later local change — including a
commit — is invisible to `agy` until `agy plugin install "$PWD"` is run again;
re-running it in place is safe and just refreshes the copy.

Requires `bun` or `node` on `PATH` for the launcher itself (as above), plus —
specifically for reading `agy`'s conversation databases — one of `bun`'s
built-in SQLite, Node's `node:sqlite` (22.5+), or the `sqlite3` binary.
`./scripts/run --host antigravity --status` says which one it found.

### Configure

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

### Use

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

### How it works

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

### How it works (agy)

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

### State

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

#### Things worth knowing

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

### Portal side

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

## jyl-wakatime

jyl-wakatime turns harness's `RunEnd` hook payload — one line of JSON, fired
once per finished agent run — into WakaTime heartbeats: a `file` heartbeat
for every tool call that named a path, plus one `app` heartbeat per run that
carries the run's token counts.

```
harness RunEnd hook (stdin, one JSON line per finished run)
  └─ scripts/wakatime --detach     forks the real work, returns in ms
        └─ src/wakatime/main.mjs
              resolve api key / api url (below)
              map payload -> heartbeats, throttle repeats
              POST <api_url>/users/current/heartbeats.bulk, 25 at a time
```

**What it sends off this machine — stated here, not in a footnote below the
install instructions:** absolute file paths, each touched file's timestamp
and whether the tool call that touched it was a write or a read
(`is_write`), the git project name and branch, a best-effort
programming-language guess from the file extension, input and output token
counts, the prompt length in characters, and the session id — **not
one this tool invents per run**, but the id harness generates once for its
own process and stamps into every run's payload, so it is a single value
shared by everything that process reports, not a fresh one per run. The
request itself also carries a User-Agent identifying this tool, harness, and
the machine, e.g.
`wakatime/1.0.0 (darwin-27.0.0-arm64) harness/27.0.17 harness-wakatime/0.1.0`
— OS, kernel release, CPU architecture, harness's version and this tool's
own. **It never sends** prompts, completions, file contents, tool arguments,
command lines, or tool results — harness's `RunEnd` payload does not carry
any of those to begin with, so this is enforced upstream, not by this tool's
restraint.

One caveat about those token counts: when a run's `outcome` is `"cancelled"`
or `"error"` instead of `"ok"`, harness may not have finished accumulating
that run's *last* turn of usage before it returned — the failing path exits
before that turn's tokens are added in. This is a deliberate choice on
harness's side (`outcome` is exactly how a consumer is meant to recognise an
incomplete run), not a bug here — but jyl-wakatime does not forward `outcome`
to WakaTime at all, so nothing on the heartbeat itself distinguishes a
complete run's counts from a possibly-short one. Treat `ai_input_tokens` /
`ai_output_tokens` as a lower bound, not a guaranteed-exact count, on any run
that did not end `"ok"`.

### Install: wire it into harness

**Step 0, before the hook config: get a checkout and a key.** Unlike
`jyl-usage`'s Claude Code route above, there is no marketplace install here —
harness's `command` needs a real absolute path, so clone or copy this repo
somewhere that will not move (`git submodule update` detaching HEAD, or the
directory getting renamed, both break the path silently). The launcher also
needs `bun` or `node` on `PATH` at the moment harness execs it — set
`JYL_WAKATIME_RUNTIME` to an absolute interpreter path if neither resolves in
harness's environment (harness inherits its own full environment into the
hook, so this is usually the same `PATH` your shell has). If no runtime is
found, `scripts/wakatime` writes a line to stderr *and*, since harness
discards a hook's stderr and never runs `--status` for you, to
`~/.config/jyl-wakatime/log` — the one thing that keeps this specific failure
from being completely invisible (see "Is it working?" below). And the API
key itself comes from WakaTime, not this repo: your account's [API key
settings page](https://wakatime.com/settings/account#apikey), or the
equivalent settings page on your self-hosted wakapi/hakatime instance.

Then add a hook in harness's `config.toml`:

```toml
[[hooks]]
event   = "RunEnd"
command = "/absolute/path/to/harness-plugin/scripts/wakatime"
args    = ["--detach"]
```

`--detach` is not optional decoration. `scripts/wakatime` reads the payload
itself, forks the actual read-and-send work into a background process that
is not a child of harness at all, and returns within milliseconds. Without
it, the network round trip to WakaTime runs as harness's own direct child,
inside harness's hook timeout (10 seconds by default) — a slow send can be
killed mid-flight, and because the only copy of that run's heartbeats ever
existed on stdin, that batch is simply gone (see "There is no `--backfill`"
below).

### Configure

Two values, resolved in this order — first match wins:

```text
api key:  WAKATIME_API_KEY
       -> ~/.wakatime.cfg  [settings] api_key
       -> ~/.wakatime.cfg  [settings] api_key_vault_cmd  (output of the command)
       -> ~/.config/jyl-wakatime/config.json  { "apiKey": … }

api url:  WAKATIME_API_URL
       -> ~/.wakatime.cfg  [settings] api_url
       -> ~/.config/jyl-wakatime/config.json  { "apiUrl": … }
       -> https://api.wakatime.com/api/v1
```

**`~/.config/jyl-wakatime` always means `$HOME/.config/jyl-wakatime`, literally.**
This tool does not honour `$XDG_CONFIG_HOME` — that is the existing
convention in this repo (`jyl-usage`'s own state directories are the same
kind of hardcoded path), not something decided fresh here. If that ever
changes, it has to change in exactly one place
(`STATE_DIR`/`JSON_CONFIG_FILE` in `src/wakatime/cfg.mjs`) and the
`scripts/wakatime` fallback that mirrors it for when no runtime is on `PATH`
(see "Is it working?" below) has to move with it — the two are not allowed
to drift, since nothing else would notice if they did.

**`~/.wakatime.cfg` is checked before this tool's own config, deliberately:**
anyone who has ever installed a WakaTime editor plugin already has a key
there, and asking for a second copy of the same secret would be asking for
it to drift. Only `[settings]`'s `api_key`, `api_key_vault_cmd`, `api_url` and
`hide_file_names` are read from that file; everything else in it (`exclude`,
`include`, `proxy`, …) is `wakatime-cli`'s business, and unrecognised lines
are ignored rather than rejected — a future WakaTime release adding a line
this tool has never heard of will not break it.

**`api_key_vault_cmd` is for a key kept in a password manager instead of in
plaintext** — the same option `wakatime-cli` itself supports, so an existing
editor plugin's config Just Works here too. Its value is a command; **this
tool runs it and treats whatever it prints on stdout, trimmed, as the key.**
It is split into a command and arguments the way a shell would (quotes and
backslash escapes are understood), but it is never handed to an actual
shell — no pipes, no `$VAR` expansion, no `; second-command`. If both
`api_key` and `api_key_vault_cmd` are present, `api_key` wins and the command
never runs.

The command gets 5 seconds. If it is missing, exits non-zero, times out, or
prints nothing at all, **that is indistinguishable from having no key
configured** — same silent no-op, same one-line log, same `--status` output
as an empty config. Nothing about *why* the command failed is logged,
including its stderr: a vault command's failure output is exactly the kind
of place a key, a passphrase prompt, or other secret-shaped text could leak,
so it is discarded unread rather than risk that. When it does succeed,
`--status` attributes the key to `api_key_vault_cmd`, not to
`~/.wakatime.cfg`'s path, so a key resolved this way is visibly different
from one written in plaintext (see below).

Self-hosted **wakapi** or **hakatime**: point `api_url` at it, in either file
above. A trailing slash is trimmed.

`[settings] hide_file_names = true` (or `"hideFileNames": true` in the JSON
config) is honoured: file entities are replaced with an obfuscated
placeholder that keeps only the extension (`agent.go` becomes `HIDDEN.go`; an
extension-less file becomes `HIDDEN`), while the project name and branch are
still reported. That trade-off is WakaTime's own, not one invented here.

**No API key anywhere means this tool quietly does nothing.** Not a crash,
not a log line on every single run — one line logged the first time, then
silence until the config is fixed. (`JYL_WAKATIME_DISABLED=1`, or
`"enabled": false` in the JSON config, turns it off the same way, on
purpose.) An install with no key configured is inert, exactly like
`jyl-usage`.

### Is it working? (`--status`)

**jyl-wakatime never exits non-zero and never throws, on any path** — a bad
config, a network failure, an unwritable state directory, none of it may
turn a harness run red. That agrees with harness's own side: a hook failure
there is a notice, never an error that fails the run. The cost is silence —
a broken reporter fails exactly as quietly as a working one, on every
surface except this one:

```sh
$ ./scripts/wakatime --status
jyl-wakatime 0.1.0
  api url     https://api.wakatime.com/api/v1
  api key     (unset)   (from nowhere)
  spool       0 heartbeat(s)
  last send   never
  auth fails  0
  PROBLEM     no API key configured
```

(that is real output, from a freshly configured `$HOME` with nothing set up
yet.) Once a key resolves, the `PROBLEM` line disappears and `last send`
reports what the most recent attempt actually did — for example:

```text
  api key     waka…cdef   (from /Users/you/.wakatime.cfg)
  last send   2026-09-12T06:14:02.483Z  accepted 12, failed 0
```

| Line | What it means |
|---|---|
| `PROBLEM` | present at all → nothing is being sent right now; its text says why |
| `spool` | heartbeats that failed on their most recent send attempt — a network error, a 429, a 5xx, or a 401/403 all land here — waiting for the next retry, either the next hook run or `--flush` (below). Should trend toward 0 across runs, not up. Capped at 5000 — past that, the oldest are dropped, logged as `spool overflow: dropped N oldest events` |
| `last send` | `accepted N, failed M` from the most recent attempt; `failed` staying above 0 across several runs means something is wrong, not a fluke |
| `auth fails` | counts *consecutive runs that had something to send* and got a 401/403 back; a run that sends successfully, or fails for a different reason, resets it to 0 — but a run with nothing queued at all does neither, so a stale nonzero value can persist through a quiet gap. Nonzero means the key WakaTime saw the last time this tool actually tried to send was wrong or revoked |
| `accepted 0` with an **empty spool and no `PROBLEM` line** | the dangerous healthy-looking reading. WakaTime rejected every heartbeat outright with a non-retryable 4xx (anything but 401/403/429) — `send.mjs` drops that batch for good, so it never reaches the spool and nothing here flags it. This is not hypothetical: a mistyped path on a self-hosted wakapi/hakatime `api_url` produces exactly this. Every field above reads as a healthy, idle tool while every heartbeat from that run went in the bin; the only trace is the log, a line like `wakatime rejected 3 heartbeat(s), dropping: 400 bad request` |

The full log behind that summary is `~/.config/jyl-wakatime/log`, capped at
256 KB — the same rotation `jyl-usage` uses, from the `src/core/store.mjs`
the two tools share. `./scripts/wakatime --flush` retries whatever is
currently spooled right away, reading no stdin — worth running immediately
after fixing a bad key or a wakapi outage rather than waiting for harness's
next run to pick the spool back up (which happens automatically too, on
every hook invocation).

### There is no `--backfill`

`jyl-usage` can rescan transcripts because a transcript is a file that keeps
existing after the fact. jyl-wakatime has nothing like it: its only input is
one JSON line on stdin, read once, by a process that then exits. A heartbeat
that failed to send is retried from the spool; a heartbeat that was never
produced at all — because the hook never fired, or the process reading stdin
was killed first — is simply gone. There is no flag for this because there
is nothing a flag could do about it.

### The payload is a cross-repo contract

harness and jyl-wakatime live in separate repositories and agree on one JSON
shape with no build step checking that agreement. `tests/fixtures/runend.json`
in this repo and `hook/testdata/runend.json` in `JianyueLab/harness` must
stay byte-for-byte identical:

```sh
diff tests/fixtures/runend.json ../harness/hook/testdata/runend.json
```

No output means the two still agree. Changing the payload — a renamed field,
a new property on a tool call — means changing both repositories in the same
change; neither side's test suite will notice that the other one drifted.
