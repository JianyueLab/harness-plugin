# Reporting harness activity to WakaTime

**Status:** implemented, documented and verified against the real WakaTime
service (Tasks 1–8). See "Verified against the real service" at the end for what
was observed, what is still unverified (a real agent run; the rendered
dashboard), and four findings recorded but deliberately not implemented.
**Date:** 2026-09-12
**Repos touched:** `JianyueLab/claude-plugin` (this one), `JianyueLab/harness`
**Depends on:** harness's `RunEnd` hook —
`harness/docs/superpowers/specs/2026-09-12-harness-hook-system-design.md`.
That spec owns the payload contract; this one consumes it.

## Why

`harness` is where a growing share of the work happens, and none of it shows up
in WakaTime. Every editor plugin WakaTime ships reports the file you are typing
in; nobody reports the files an agent edits on your behalf. The hours are real
and they are invisible.

WakaTime has since grown a set of fields for exactly this — `ai_session`,
`ai_input_tokens`, `ai_output_tokens`, `ai_prompt_length`, `ai_line_changes`,
`human_line_changes`, and an `"ai coding"` category. harness knows all of them
first-hand: the provider layer already carries `Usage`, and the tool loop knows
which file each `edit_file` touched.

## Scope

**In:** a second, independent tool in this repo — `jyl-wakatime` — that reads
harness's `RunEnd` payload from stdin and turns it into WakaTime heartbeats.

**Out:**

- Claude Code and `agy`. They have their own WakaTime story (`wakatime-cli`'s
  `--sync-ai-activity` parses Claude and Codex transcript logs already) and
  nothing here is verified against them.
- Anything to do with `llm-web`. harness defaults to the `jyl` gateway, so its
  tokens are metered by the `/v1` proxy already; there is no usage gap to close
  and this tool does not post to the portal at all.
- `wakatime-cli`. See "Why not the CLI" below.

## This is a separate tool, not a second sink in `jyl-usage`

`jyl-usage`'s headline promise, three paragraphs into the README, is:

> **Only counts leave the machine.** Model id, timestamp, request id and token
> totals. Never prompts, completions, file contents, file paths or project names.

**WakaTime's required `entity` field is a file path, and `project` is a project
name.** Bolting a WakaTime sink onto `jyl-usage` would mean anyone who already
installed it starts shipping paths after an upgrade they did not read the notes
for. That is not a promise to soften with a config flag; it is a different
product with a different consent story.

So: same repo, two tools, side by side.

| | `jyl-usage` | `jyl-wakatime` |
|---|---|---|
| Reports | token counts | file activity + AI token counts |
| To | `llm-web` `/v1/usage/ingest` | WakaTime (or a self-hosted wakapi) |
| Hosts | Claude Code, `agy` | harness |
| Installed as | plugin manifests (`.claude-plugin/plugin.json`, `plugin.json`) | a path in harness's `config.toml` |
| Leaves the machine | counts only | **paths and project names** |
| Entry point | `scripts/run` | `scripts/wakatime` |
| Version | 0.3.0 | 0.1.0 |

**A separate launcher, not `scripts/run --host harness`.** An earlier draft
routed it through the existing entry point. Two tools with two different
privacy postures sharing one launcher is exactly the kind of thing that later
grows a shared config path and an accidental cross-import; a second twelve-line
`sh` script costs nothing and keeps the boundary where the README says it is.

`src/core/` is still shared — see Architecture.

## Why not `wakatime-cli`

WakaTime's own plugin guide says to shell out to `wakatime-cli` rather than
call the API, and for an editor plugin that is right: it brings offline
queueing, git project detection, language detection, `--hide-file-names`, and a
User-Agent the dashboard already recognises.

Two things decided against it here.

**The fields that make this interesting are not on the CLI.** Its flag set
(verified against `cmd/root.go` on `develop`) has `--ai-line-changes` and
`--human-line-changes`, but **no** `--ai-session`, `--ai-input-tokens`,
`--ai-output-tokens`, `--ai-prompt-length` or `--ai-subscription-plan`. Those
are API-only, and they are precisely what harness can supply and a text editor
cannot.

**Half of what the CLI would save us already exists in this repo.** The hard
part of talking to a metering API from a hook is the offline queue, and
`src/core/store.mjs` has one — spool, file lock, atomic writes, log rotation —
shipped and tested.

The cost is real and goes in the ledger: project detection, language detection,
throttling and User-Agent assembly all become ours to write, and ours to get
wrong.

**The escape hatch:** WakaTime is actively building in this direction —
`--sync-ai-activity` ("Parse AI transcript logs for Claude, Codex, Cursor, etc.
and send any resulting AI heartbeats") already exists. If the CLI grows the
token fields, or if our detection proves too coarse, the sender is one module
(`send.mjs`) behind one function. Swapping it for a CLI invocation should not
touch the mapping.

## What harness gives us

One line of JSON on stdin per run (one `Agent.Run`, which may span many model turns). The contract is specified in harness's spec
§5; the shape, abbreviated:

```json
{
  "event": "RunEnd",
  "harness_version": "27.0.17",
  "session_id": "3f9a1c7e2b4d5068",
  "workspace_root": "/Users/jhl/Documents/Dev/JianyueLab/harness",
  "provider": "jyl",
  "model": "claude-opus-5",
  "outcome": "ok",
  "started_at": 1757650000.123,
  "ended_at": 1757650042.456,
  "prompt_chars": 214,
  "usage": { "input_tokens": 12043, "output_tokens": 887,
             "cache_creation_input_tokens": 0, "cache_read_input_tokens": 11800 },
  "tools": [
    { "name": "read_file", "path": "/abs/agent/agent.go", "at": 1757650003.2, "elapsed_ms": 8,    "is_error": false },
    { "name": "edit_file", "path": "/abs/agent/agent.go", "at": 1757650031.7, "elapsed_ms": 12,   "is_error": false },
    { "name": "bash",                                     "at": 1757650038.0, "elapsed_ms": 2400, "is_error": false }
  ]
}
```

Three properties worth restating because the mapping depends on them:

- `path` is **absolute** and **absent entirely** when the tool does not touch
  one file. Do not treat a missing `path` as `""`.
- Times are **float epoch seconds**, the same unit WakaTime's `time` takes. No
  conversion.
- `usage` may be partial when `outcome` is `"cancelled"` or `"error"`. The work
  still happened; the counts may undercount.

`tests/fixtures/runend.json` holds a full example and must stay **byte-for-byte
identical** to `harness/hook/testdata/runend.json`. Neither side's tests catch
a drift in the other — changing the contract means changing both repos in one
go.

## Architecture

```text
scripts/wakatime            launcher: find bun/node, --detach, never exit non-zero
src/wakatime/main.mjs       entry: parse args, read stdin, dispatch
src/wakatime/cfg.mjs        api key / api url / hide_file_names resolution
src/wakatime/heartbeats.mjs RunEnd payload -> heartbeat[], plus throttling
src/wakatime/project.mjs    git project + branch detection, cached
src/wakatime/language.mjs   extension -> language name
src/wakatime/send.mjs       POST heartbeats.bulk, 25 at a time
```

**Reused from `src/core/`, unchanged:** `store.mjs` in full — `withLock`,
`loadState` / `saveState`, `readSpool` / `writeSpool`, `log`. A separate
`stateDir` (`~/.config/jyl-wakatime/`) means the two tools never touch each
other's files.

**Not reused: `upload.mjs`.** It is written for llm-web's ingest route and
bound to it — `BATCH_SIZE = 500`, the `invalid_source` error code, the
`accepted` / `duplicates` / `rejected` response body. `send.mjs` is new, but
**copies its shape**, which is the part worth keeping: classify every failure
by whether *the same bytes* could ever succeed, return `{tally, failed}`, and
let the caller own the spool. Writing the spool inside the sender would mean
two functions deciding what is still owed.

`config.mjs` is **not** reused. Its resolution order is built around
`JYL_API_KEY` and the portal's base URL; WakaTime's is a different chain
entirely (below), and sharing the loader would tempt a future edit to make one
key serve both services — which is the opposite of what the separation is for.

## Configuration

```text
api key:  WAKATIME_API_KEY
       -> ~/.wakatime.cfg  [settings] api_key
       -> ~/.wakatime.cfg  [settings] api_key_vault_cmd  (output of the command, trimmed)
       -> ~/.config/jyl-wakatime/config.json  { "apiKey": … }

api url:  WAKATIME_API_URL
       -> ~/.wakatime.cfg  [settings] api_url
       -> ~/.config/jyl-wakatime/config.json  { "apiUrl": … }
       -> https://api.wakatime.com/api/v1

off:      JYL_WAKATIME_DISABLED=1, or { "enabled": false }
```

**Reading `~/.wakatime.cfg` is the point, not a convenience.** Anyone who has
ever installed a WakaTime editor plugin already has a key there; requiring a
second copy would be asking for a secret to be duplicated for no reason.

`api_url` matters as much as the key: self-hosted **wakapi** and **hakatime**
are common, and hardcoding `wakatime.com` locks those users out. A value ending
in `/` is trimmed; the tool posts to `<api_url>/users/current/heartbeats.bulk`.

`[settings] hide_file_names` is honoured — see Privacy.

`[settings] api_key_vault_cmd` is `wakatime-cli`'s own escape hatch for a key
kept in a password manager: run the named command, treat its trimmed stdout
as the key. Split into argv the way `wakatime-cli` itself splits this value
(quotes, backslash escapes), but never handed to an actual shell — no
pipes, no `$VAR` expansion, no `;` chaining. `api_key` wins if both are
present; the command never runs in that case.

**A leading `~/` or bare `~` is expanded to `$HOME` — this tool's own
addition, not part of `wakatime-cli`'s own splitting.** Not shell-faithful:
quoting or escaping a `~` (`"~"`, `'~'`, `\~`) does not suppress the
expansion the way it would in a real shell, because quote information is
discarded during tokenising, before this step runs — so there is no way to
write a literal `~` into an argument. Deliberate: matching shell-accurate
quoting for one character while the rest of this value is already knowingly
not shell wasn't worth it for a case nothing has needed.

A failing command (not found, non-zero exit, timed out, output past
`execFileSync`'s `maxBuffer`, empty output) never yields a key and never
throws, but is diagnosed distinctly from "no key configured at all" — see
the failure table below — without ever logging the command or its output.
The 5s timeout on the command is sized against harness's own 10s hook
timeout (`DefaultHookTimeoutSeconds`), not picked independently: it has to
fire, log, and return well before harness would kill an undetached hook
process out from under it. The command is killed with `SIGKILL`, not asked
via `SIGTERM`, so a child that traps signals still can't outlast the
timeout — but this only reaches the command's own process, not anything it
may have forked off before exiting, the same limitation harness's own hook
runner accepts for the same reason (`hook/runner.go`: killing a whole
process group would risk taking a legitimately-detached worker down with a
hung one).

The cfg file is INI. Parse only `[settings]`, only the four keys named just
above — `api_key`, `api_key_vault_cmd`, `api_url`, `hide_file_names` — and
never fail on anything else in it: `exclude` / `include` / `proxy` and the rest
are the CLI's business, and a parser that throws on an unfamiliar line would
break on WakaTime's next release.

**Auth:** `Authorization: Basic <base64(api_key)>`. Not the `?api_key=` query
form — a key in a URL lands in proxy logs.

## Heartbeat mapping

One `RunEnd` produces two kinds of heartbeat.

### File heartbeats — one per tool call that has a `path`

| Field | Value |
|---|---|
| `entity` | the absolute `path` |
| `type` | `"file"` |
| `time` | the call's `at` |
| `is_write` | `true` for `edit_file` and `write_file`, `false` for `read_file` |
| `category` | `"ai coding"` |
| `project` | detected from `workspace_root` |
| `branch` | detected from `workspace_root` |
| `language` | from the extension, omitted when unknown |

Tool calls without a `path` — `bash`, `glob`, `grep`, every MCP tool — produce
no file heartbeat. There is no entity to name and inventing one would be a lie.

### One run heartbeat per payload

| Field | Value |
|---|---|
| `entity` | `"harness"` |
| `type` | `"app"` |
| `time` | `ended_at` |
| `category` | `"ai coding"` |
| `project` | detected from `workspace_root` |
| `ai_session` | `session_id` |
| `ai_input_tokens` | `usage.input_tokens` + `cache_creation_input_tokens` |
| `ai_cached_input_tokens` | `usage.cache_read_input_tokens` |
| `ai_output_tokens` | `usage.output_tokens` |
| `ai_prompt_length` | `prompt_chars` |

**Token fields ride only on this heartbeat, never on the file ones.** A run
that edits five files would otherwise report its tokens five times.

This heartbeat also covers the run where the agent ran nothing but `bash`:
work happened, and the time should not be zero because no file was named.

**The model does not appear in this table because the heartbeat has no field
for it — it rides in the User-Agent instead**, as a single bare token whose
whole string becomes the `ai_model` bucket name. See Privacy and §1/§3/§7/§8 of
"Verified against the real service".

**Cache reads go in their own field; cache creation does not.** An earlier
draft folded all three input counters into `ai_input_tokens`, on the reasoning
that "splitting them out would need a field WakaTime does not have". **That
reasoning was checked against the live API and is false** —
`ai_cached_input_tokens` exists and is writable (§3 of the verification
section). Folding them made a run's fresh input read larger than it was, for
nothing.

Only the *read* counter moves. `cache_creation_input_tokens` stays with
`input_tokens` because those tokens really were processed this turn — they went
up in full and were written into the cache on the way through, which is why
providers bill them above the cache-hit rate. `cache_read_input_tokens` is the
only counter that names tokens served *from* cache instead of processed. The two
fields still total exactly what the single folded field used to report, so
nothing is lost or double-counted; the split only stops overstating fresh input.

**Not sent:** `ai_line_changes` / `human_line_changes` (harness's payload has no
line counts — adding them would mean diffing inside `edit_file`, which is a
harness-side change with its own cost), `lines`, `lineno`, `cursorpos`
(meaningless for an agent), `dependencies`, `ai_subscription_plan`.

### Throttling

WakaTime's own rule for editor plugins: skip a heartbeat if the same file was
sent within 120 seconds, unless it is a write.

Same rule here. The last-sent time per entity lives in `state.json` via
`store.saveState` — **not** in `store`'s `seen` file, which is a set of keys and
cannot carry a timestamp. Entities not seen for over 24 hours are pruned on
write so the file cannot grow without bound.

Writes are never throttled: `edit_file` is the signal WakaTime cares most about.

## Sending

`POST <api_url>/users/current/heartbeats.bulk`, **25 heartbeats per request**
(the documented cap). A 201 comes back with an array of per-item status codes;
items that individually failed are logged, not retried — a heartbeat WakaTime
rejected on content will be rejected again.

Failure classification, mirroring `upload.mjs`:

| Response | Verdict |
|---|---|
| network error, timeout | retry — back to the spool |
| 429 | retry — back to the spool, and stop sending further batches this run |
| 5xx | retry — back to the spool |
| 401 / 403 | retry — back to the spool, **and** record a `authFailures` counter in state |
| 400 | drop the batch, log it |

401 spools rather than drops because a revoked or mistyped key is a
configuration problem someone will fix, and the hours behind it are worth
keeping. But a key that is wrong forever would grow the spool forever, so:
**the spool is capped — `store.writeSpool`'s existing `MAX_SPOOL_EVENTS = 5000`,
oldest dropped first, with a log line for the drop** — and
`authFailures` is what `--status` shouts about.

Rate limit: WakaTime allows under 10 requests/second averaged over five
minutes. At 25 per request and one turn per several seconds, a single harness
session cannot approach it; several sessions flushing at once could, which is
what the 429 rule above and `store`'s existing lock are for.

Request timeout 10s, same reasoning as `upload.mjs`: a hook that hangs is worse
than activity reported a turn late.

## Project and language detection

**Project:** walk up from `workspace_root` looking for `.git`; the directory
containing it gives the project name. **Branch:** `git rev-parse --abbrev-ref
HEAD`. Both cached in `state.json` keyed by `workspace_root`, with the branch
re-read when the cache entry is older than 60 seconds — forking `git` on every
turn to learn something that changes a few times a day is not worth it, and a
branch shown 60 seconds stale is not worth caring about.

No `.git` at all: `project` is the basename of `workspace_root`, no `branch`.

**Language:** a plain extension table (`.go` → `Go`, `.ts` → `TypeScript`,
`.astro` → `Astro`, …). Unknown extension → omit the field and let WakaTime's
server guess from the entity. This is measurably coarser than `wakatime-cli`,
which sniffs content; it is the accepted cost of not shipping the binary.

## Privacy

**This tool sends file paths and project names off the machine. That is what it
is for.** It has to be stated plainly, in the README, above the install
instructions — not softened, and not in a footnote under `jyl-usage`'s
"counts only" promise.

What it sends: absolute file paths, project name, git branch, language, token
counts (fresh and cached separately), prompt length in characters, **the model
id**, and a per-run session id.

**The model id is sent. An earlier version of this section said it was not, and
explained why — that explanation was wrong.** The reasoning was "there is
nowhere to put it: WakaTime's heartbeat has no model field". Half of that is
true and was confirmed by experiment: a heartbeat posted with a `model` field
comes back stored without it (§3 of the verification section). The conclusion
drawn from it was not. **WakaTime keeps the model in the User-Agent**, in a
positional AI-model slot it parses into `ai_model` / `ai_model_version` and then
uses to drive `ai_model_costs`, `ai_model_breakdown` and
`ai_model_line_changes` in the summaries. Every other AI integration reporting
into this account already fills that slot (`opus/5`, `gemini/3.8-flash-high`,
`gpt/5.6-sol`).

Not filling it was not a neutral omission, which is the other half of why this
reversed: with the slot left empty, WakaTime's parser slid the User-Agent's own
leading `wakatime/1.0.0` token into it, and the account's model-cost breakdown
grew **a phantom model named "Wakatime" carrying real dollar figures**. The
choice was never "send the model or send nothing"; it was "send the model or
send a lie about it".

**Why this trade is acceptable.** A model id is far less sensitive than what
this tool already sends by design — absolute file paths and project names. It
names which model did the work, not what the work was: no prompt, no code, no
file content. Anyone for whom a model id is too much is already ruled out by the
file paths, and their answer is `hide_file_names` or not installing this tool.
It is called out here, above the install instructions in the README, rather than
left for someone to discover in a request dump.

### What this looks like on the dashboard

The model goes out as **one bare token carrying the whole model string** —
`… go0.0.0 claude-opus-5 harness/27.0.17 harness-wakatime/0.1.0` — which WakaTime
records as `ai_model: "Claude-Opus-5"` with `ai_model_version: null`. Read back
from the live API: `claude-opus-5` → `"Claude-Opus-5"` (P13), `gpt-5.6-sol` →
`"Gpt-5.6-Sol"` (P15), `anthropic/claude-opus-5` → `"Anthropic-Claude-Opus-5"`
(P14).

So **every exact model string gets its own row** in `ai_model_costs`,
`ai_model_breakdown` and `ai_model_line_changes`. That is the point: those three
structures bucket by `ai_model` **name only** — `ai_model_costs` is
`{name: cost}` and a breakdown row is exactly `{name, lines, cost}`, with the
version in neither — so the name *is* the bucket and anything after a slash is
decoration.

**This deliberately does not merge with Claude Code's `Opus` row, and that is the
accepted cost.** Claude Code reports `opus/4-8`, `sonnet/5`, `haiku/…`, so its
buckets are `Opus`, `Sonnet`, `Haiku`; harness's will be `Claude-Opus-5`,
`Claude-Sonnet-5`. Why that is acceptable:

- **There is no single convention in the account to align with.** `Opus` /
  `Sonnet` / `Haiku` / `Fable` are variant-first from Claude Code; `Claude`
  (200 user-agent rows, $696 in one day) is not a model at all but Claude Code's
  `ClaudeCode/2.1.143` *editor* token misparsed as model `Claude` version
  `2.1.143`; `Pi`, `OpenCode`, `Codex`, `Cursor`, `Copilot` are tools rather than
  models; `Gemini` arrives with version `gemini-3-flash-preview`.
- **Slicing by tool is what the `editors` breakdown is for**, and `Harness` is
  already its own row there. Nothing is lost by not sharing a model bucket.

**Why not mimic the others and send the variant first** (`opus/5`): **it is not
computable.** `gpt-5.6-sol`'s family is its first segment; `claude-opus-5`'s
family is its *second*. Separating those needs a table of which leading words are
vendors rather than families — and that table fails in the worst available way:
when it lacks an entry it does not error, it silently mints a bucket under the
wrong name, undetectable without another live probe. That is the same failure
shape as the `ai_model: "Wakatime"` bug this whole section exists to fix. One
bucket per exact model string needs no table and cannot be silently wrong.

An earlier revision of this document said the `family/variant` split would make
harness "aggregate with" the other integrations. **That was backwards** —
`claude/opus-5` produces the bucket `Claude`, not `Opus`, so it aligned with
nothing and merely buried harness's spend inside another tool's row.

The mapping tables above deliberately do **not** list the model: it is not a
heartbeat field, and putting it there would suggest it can be set per heartbeat.
It is per User-Agent, which means per request — a batch that mixes a fresh run's
heartbeats with heartbeats spooled by an earlier run under a different model
labels all of them with the current run's model, and `--flush` (no payload at
all) sends no model token. Per-heartbeat attribution would mean one request per
model; not worth it for a field WakaTime only keeps per user-agent row.

What it never sends: prompts, completions, file contents, tool arguments,
command lines, tool results. harness's payload does not contain any of them
(hook spec §5.3), so this is enforced upstream rather than by our discretion.

`hide_file_names` in `~/.wakatime.cfg` is honoured, with WakaTime's own
semantics: the entity becomes an obfuscated placeholder and the project is
still reported. Setting it means giving up per-file stats, which is the trade
WakaTime's own users already understand.

## Failure modes

**Nothing here may make a harness turn go red.** `scripts/wakatime` follows
`scripts/run`'s rule verbatim — never exit non-zero, not even with no runtime
on `PATH`. harness's side already treats a hook failure as a notice rather than
an error, so the two agree.

The cost of that is silence, and silence is how a broken reporter goes
unnoticed for a month. The one antidote is `--status`:

```text
$ ./scripts/wakatime --status
jyl-wakatime 0.1.0
  api url     https://api.wakatime.com/api/v1
  api key     waka…9f3c   (from ~/.wakatime.cfg)
  spool       0 heartbeat(s)
  last send   2026-09-12T06:14:02Z  ok, 12 accepted
  auth fails  0
```

| What happened | What the tool does |
|---|---|
| no key anywhere | log once, exit 0, `--status` says "no API key configured" |
| `api_key_vault_cmd` configured but fails (not found / non-zero exit / timed out / output too large / empty output) | log once, exit 0 — but `--status` says which of those it was, not the generic "no API key configured", and never the command or its output |
| stdin is not valid JSON | log, exit 0 |
| payload's `event` is not `RunEnd` | log, exit 0 — forward compatibility with a harness that grows more events |
| WakaTime down | spool, retry next turn |
| key revoked | spool, `authFailures` climbs, `--status` shouts |
| spool at 5000 | `store.writeSpool` drops oldest and logs it — a silent cap reads as "everything was sent" |
| two sessions flush at once | `store.withLock`; the loser bows out and the next turn picks it up |
| `git` not on `PATH` | no `branch`, project falls back to the basename |

## Testing

`bun test`, no network, no real API key — same as the existing suites.

1. **Mapping** — the fixture payload produces exactly the expected heartbeat
   array: three tool calls in, two file heartbeats plus one run heartbeat out
   (`bash` contributes none), token fields only on the run heartbeat.
2. **The two input counters land in the right fields** — `input_tokens` +
   `cache_creation_input_tokens` in `ai_input_tokens`, `cache_read_input_tokens`
   in `ai_cached_input_tokens`. Asserted with three *distinct non-zero* values,
   because the contract fixture has `cache_creation_input_tokens: 0` and so
   cannot tell a correct split from either wrong one.
3. **Throttling** — same entity twice inside 120s yields one heartbeat; the
   same entity as a write yields two; 121s apart yields two.
4. **State pruning** — an entity last seen 25 hours ago is gone after a save.
5. **Config chain** — env beats cfg beats json; a cfg file with unknown keys
   and junk lines still parses; `api_url` trailing slash trimmed; missing key
   is a clean "not configured", not a throw.
6. **Auth header** is `Basic ` + base64, and the key never appears in a URL.
7. **Batching** — 60 heartbeats go out as 25 / 25 / 10.
8. **Failure classification** — 429, 500, 401, 400 each land in the right
   bucket; the spool holds what should be retried and not what was dropped.
9. **Spool cap** — 5001 in, 5000 kept, the oldest gone, one log line (this is
   `store`'s behaviour, asserted here because jyl-wakatime relies on it).
10. **`hide_file_names`** — entities obfuscated, project still present.
11. **Language table** — a known extension maps, an unknown one omits the field.
12. **Never exits non-zero** — no runtime, bad stdin, no key, unwritable state
    dir: exit code 0 in every case.
13. **The User-Agent's fixed shape.** The `go` token sits between the platform
    group and the model slot, and is present even when there is no model —
    it is what keeps `wakatime/1.0.0` out of that slot, so a "tidy-up" that
    removes it is a server-side regression no other assertion would catch.
    The model goes out as one bare token carrying the whole model string, and
    **no slash is ever emitted** — a slash would split it into name/version and
    re-create the bucket-by-vendor shape. Both whitespace and `/` are collapsed
    to `-`, stranded end hyphens trimmed, a name with nothing alphanumeric left
    reporting no model at all; no model means no token rather than a literal
    `undefined`. The UA stays exactly six tokens whatever the model contains.
14. **`payload.model` actually reaches `userAgent()`.** Asserted on the `ctx`
    `runHook` builds, not on `userAgent` in isolation — dropping that one
    property is exactly the regression that silently restores the phantom
    "Wakatime" model, and nothing else in the suite would go red.

`tests/fixtures/runend.json` is the shared contract fixture; a test asserts it
parses into the fields the mapper expects, which is what makes a harness-side
rename show up here as a red test rather than as missing data.

## What has to be verified against the real service

Two things cannot be settled from documentation, and the implementation plan
needs a step for each. **Both were attempted on 2026-09-13 — see "Verified
against the real service" at the end of this document. The first is settled;
the second is only half settled, because no browser was reachable.**

1. **Editor attribution.** The dashboard identifies the editor by parsing the
   User-Agent, and we assemble ours by hand:
   `wakatime/1.0.0 (darwin-27.0.0-arm64) go0.0.0 claude-opus-5 harness/27.0.17 harness-wakatime/0.1.0`
   (the `go` token and the model token are both there for reasons established by
   experiment — see §1 of the verification section).
   WakaTime's guide only says to send one and then check the User Agents API
   endpoint to confirm editor, version and OS were detected. **Send one real
   heartbeat and read that endpoint back.** If `harness` is not recognised, the
   fallbacks are to adopt a name it does know, or to ask WakaTime to register
   one.
2. **`type: "app"` with `entity: "harness"`.** Documented as a legal type, but
   whether the dashboard renders it usefully next to file entities is unknown.
   If it looks wrong, the alternative is to attach the token fields to the
   run's last file heartbeat and emit the app heartbeat only for turns that
   touched no file.

## Open items to settle during implementation

1. **`ai_subscription_plan`** is left unsent. harness knows its provider
   (`jyl`, `anthropic`, …) but that is a gateway, not a subscription tier, and
   guessing would be fiction.
2. **The 120-second throttle is WakaTime's number for humans typing.** An agent
   editing the same file eight times in ninety seconds is a different pattern.
   Ship WakaTime's rule; revisit once there is a week of real data.
3. **`--backfill` has no meaning here** and is not implemented: unlike
   `jyl-usage`, there is no local record to rescan — if a turn's payload was
   lost, it is gone. Worth stating in the README so nobody looks for the flag.
4. **The `.gitmodules` mismatch.** The workspace root records `path =
   claude-plugin` while the working copy sits at `harness-plugin/`. That has to
   be reconciled before any pin can be committed; it is not this design's
   problem, but it is this change's blocker.

## Verified against the real service (2026-09-13)

Everything in this section was observed first-hand against
`https://api.wakatime.com/api/v1` with the author's own key, on
`darwin-27.0.0-arm64`, with harness built from `JianyueLab/harness` at
`27c49f9`. **Anything not stated here was not observed.** Two things in
particular were *not* verifiable and are marked as such below: a real harness
agent run, and the rendered dashboard.

### How the heartbeats were produced

Three heartbeats were sent through the production path: `hook.Runner` (harness's
own, at `27c49f9`) read the `[[hooks]]` block below out of a `config.toml` via
harness's own `config.Load`, encoded the payload with harness's own
`hook.Encode`, and piped it into `scripts/wakatime --detach`, which resolved the
key through `api_key_vault_cmd`, mapped, and posted.

**What was not exercised: a real agent run.** The environment this verification
was carried out from would not let the harness binary be started with a prompt
(three attempts: `-p` with `--permission auto`, with `--permission accept`, and a
read-only prompt in the default `manual` mode — each refused by that
environment's own tool-permission classifier, nothing to do with harness;
`harness --help` ran fine, so the binary itself was not the obstacle). The
payload's *field values* were therefore hand-built to a realistic shape rather
than filled by `cmd/harness`'s `RunEnd` observer from live agent events.
Everything downstream of `hook.Encode` — the wire bytes, the mapping, the
User-Agent, the request, the account — is real. **The observer that turns an
`agent.RunRecord` into a `hook.Payload` remains unverified against the live
service.**

### 1. Editor attribution: `harness` is recognised. No fallback needed.

`GET /users/current/user_agents/ed271f88-1a19-41a1-8102-d4320dc85f30`, the row
WakaTime created for our request, verbatim:

```json
{
  "value": "wakatime/1.0.0 (darwin-27.0.0-arm64) harness/27c49f9 harness-wakatime/0.1.0",
  "editor": "Harness",
  "version": "0.1.0",
  "os": "Mac",
  "cli_version": "1.0.0",
  "go_version": null,
  "ai_model": "Wakatime",
  "ai_model_version": "1.0.0",
  "ai_model_complexity": null,
  "is_desktop_app": false,
  "is_browser_extension": false
}
```

- **`editor` is `"Harness"`** — title-cased from our `harness` token, with no
  prior registration. **Neither documented fallback is needed:** we do not have
  to adopt an editor name WakaTime already knows, and we do not have to ask
  WakaTime to register one.
- **`os` is `"Mac"`** — correct.
- **`version` is `0.1.0`, this tool's version, not harness's.** `27c49f9` — the
  harness version we send — does not land in any field of this resource. This is
  WakaTime's own scheme rather than a defect on our side: every other plugin in
  this account parses the same way (`Zed/1.19.2-… macos-wakatime/5.28.5` →
  `editor: "Zed"`, `version: "5.28.5"`; `Xcode/27.0-… macos-wakatime/5.28.5` →
  `version: "5.28.5"`). The **editor's** own version is discarded by WakaTime in
  every case observed.
- **`ai_model` is `"Wakatime"`, which is wrong, and it is not cosmetic.**
  WakaTime read our leading `wakatime/1.0.0` token as the AI-model slot. The
  consequence is visible in the day's summary: `grand_total.ai_model_costs`
  gained an entry `"Wakatime": 0.097965` and `ai_model_breakdown` gained
  `{"name": "Wakatime", "lines": 0, "cost": 0.097965}`. harness's run is
  therefore reported as **dollar spend on a model called "Wakatime"**.

The slot exists because wakatime-cli's User-Agent carries one. Observed shapes
from the same account (all pre-existing, none ours):

| `value` | `editor` | `version` | `ai_model` / `ai_model_version` |
|---|---|---|---|
| `wakatime/v2.26.0 (…) go1.26.6 opus/5 claude-code/2.1.236 antigravity-cli/1.2.0 antigravity-cli-wakatime/1.0.0` | Claude Code | 1.0.0 | Opus / 5 |
| `wakatime/v2.26.0 (…) go1.26.6 gemini/3.8-flash-high antigravity-cli/1.2.0 antigravity-cli-wakatime/1.0.0` | Antigravity CLI | 1.0.0 | Gemini / 3.8-flash |
| `wakatime/v2.26.0 (…) go1.26.6 gpt/5.6-sol Xcode/27.0-… macos-wakatime/5.28.5` | Xcode | 5.28.5 | GPT / 5.6-sol |
| `wakatime/v2.26.0 (…) go1.26.6 Zed/1.19.2-… macos-wakatime/5.28.5` | Zed | 5.28.5 | null / null |

**Recommendation, not implemented here:** insert a `<model>/<version>` token
ahead of `harness/<version>` in `userAgent()`, sourced from the payload's
`model` field (which harness already sends and this tool currently ignores).
That both removes the phantom "Wakatime" model and gives the model a home — see
§3. The exact grammar WakaTime uses to slot these tokens was **not** determined;
only the input/output pairs above were observed.

### 2. `type: "app"` with `entity: "harness"` — what could and could not be checked

**Not checked: the rendered dashboard.** No browser was reachable from this
environment (the browser extension was not connected), and `wakatime.com`'s
dashboard needs a session cookie, which an API key does not provide. **How the
app heartbeat *looks* on the dashboard remains unverified.** Nothing below
should be read as a claim about the rendering.

What *was* checked is the data the dashboard is built on.

`GET /users/current/durations?date=2026-09-13&project=harness-plugin` returned
our run as three consecutive blocks:

| time (UTC) | entity | type | duration |
|---|---|---|---|
| 11:15:29 | `…/harness-plugin/src/wakatime/send.mjs` | file | 28.00s |
| 11:15:57 | `…/harness-plugin/.temp/e2e-workspace/probe.txt` | file | 11.00s |
| 11:16:08 | `harness` | app | 29.27s |

- The app block sits **beside** the file blocks in the same project, not on top
  of them: 28 + 11 + 29.27 = 68.27s, which is exactly the `Harness` figure in
  the day's `editors` breakdown (`68.267582`). **No double counting was
  observed.**
- The same endpoint shows this account's *other* AI tools doing the same thing:
  Claude Code's own WakaTime integration emits `entity: "Claude <session-uuid>"`,
  `type: "app"`, and Antigravity CLI emits `entity: "Antigravity CLI <uuid>"`,
  `type: "app"` — same project, same `category: "AI Coding"`. Our shape is the
  shape the reference implementations use. (They put the session id *in* the
  entity; we keep it in `ai_session` and use a bare `harness`.)
- App heartbeats are assigned `language: "Other"` by WakaTime (ours and Claude
  Code's alike), so the run heartbeat contributes to an "Other" language bucket.
- `branch` is `null` on our app heartbeat, per the mapping table above. Claude
  Code's app heartbeats do carry a branch.

**Nothing observed indicates the documented alternative** (moving the token
fields onto the run's last file heartbeat) is needed — but the question it was
meant to answer, how it renders, is still open.

### 3. The `model` field: settled, both halves

An earlier review marked "WakaTime's heartbeat has no `model` field" as
unverified. It is now verified, by sending one and reading it back:

- A probe heartbeat was posted with `"model": "gpt-5.6-sol"` and
  `"ai_cached_input_tokens": 4242`. It was accepted (per-item `201`).
- Reading it back from `GET /users/current/heartbeats?date=2026-09-13`, the
  stored resource has **26 keys and none of them is `model`**:
  `ai_cached_input_tokens, ai_input_tokens, ai_line_changes, ai_output_tokens,
  ai_prompt_length, ai_session, ai_subscription_plan, branch, category,
  created_at, cursorpos, dependencies, entity, human_line_changes, id, is_write,
  language, lineno, lines, machine_name_id, project, project_root_count, time,
  type, user_agent_id, user_id`. The `model` we sent was silently dropped.

So the Privacy section's first clause holds: **the heartbeat body has no model
field.** Its second clause does not: **"There is nowhere to put it" is wrong.**
The User-Agent has an AI-model slot (§1), WakaTime parses it into
`ai_model` / `ai_model_version` on the user-agent resource, and it drives
`ai_model_costs` / `ai_model_breakdown` / `ai_model_line_changes` in the
summaries. Sending the model would be a real change in what leaves the machine
and belongs in the Privacy section either way — **it is recorded here as a
finding, not made.**

**Also found, unprompted: `ai_cached_input_tokens` exists and is writable.** The
4242 we sent came back stored. The mapping above folds
`cache_read_input_tokens` + `cache_creation_input_tokens` into
`ai_input_tokens` because "splitting them out would need a field WakaTime does
not have" — that reason is now known to be false. Whether to split them is a
judgement call, not a bug; recorded, not changed.

### 4. What leaves the machine — checked, not inferred

The exact request body for the run above, as `heartbeatsFrom` produced it:

```json
[
  {"entity":"/Users/jhl/…/harness-plugin/src/wakatime/send.mjs","type":"file","time":1789298129.732418,
   "category":"ai coding","is_write":false,"project":"harness-plugin","branch":"feat/wakatime","language":"JavaScript"},
  {"entity":"/Users/jhl/…/harness-plugin/.temp/e2e-workspace/probe.txt","type":"file","time":1789298157.732418,
   "category":"ai coding","is_write":true,"project":"harness-plugin","branch":"feat/wakatime"},
  {"entity":"harness","type":"app","time":1789298168.732418,"category":"ai coding",
   "ai_session":"task8e2e00000001","ai_input_tokens":23843,"ai_output_tokens":887,
   "ai_prompt_length":214,"project":"harness-plugin"}
]
```

Paths, project, branch, language, timestamps, counts, a session id. No prompt,
no completion, no command line, no file content, no tool argument, no tool
result. `language` is absent on the `.txt` entity, as designed — WakaTime's
server guessed `"Text"` for it.

The payload harness itself wrote to the hook's stdin was read back in full.
The `bash` tool call appears as
`{"name":"bash","at":…,"elapsed_ms":2400,"is_error":false}` — **the `path` key is
absent entirely, and the command line appears nowhere.** A string that existed
only on a command line was grepped for across the whole state directory and not
found.

**The log file was never created.** A healthy run logs nothing, so
`~/.config/jyl-wakatime/log` does not exist after one — which means the
"grep the log for leaks" check passes *vacuously*: `grep … ~/.config/jyl-wakatime/log
|| echo "log is clean"` prints `log is clean` because the file is missing, not
because a file was examined. Grepping the whole state directory (including
`state.json`, which does hold file paths by design) found no `new_string`,
`old_string`, `tool_result`, `password` or `api_key`.

### 5. Smaller things that only a real request showed

- **`POST …/heartbeats.bulk` answers `202 ACCEPTED`, not `201`**, with a body of
  `{"responses": [[{"data": {"id": …}}, 201]]}` — per-item codes nested one level
  deeper than "an array of per-item status codes" suggests. `send.mjs` treats any
  `res.ok` as success and does not read the per-item codes at all, so the Sending
  section's "items that individually failed are logged" does not describe the
  code. Observed, not changed.
- **`category: "ai coding"` is accepted and comes back as `"AI Coding"`.**
- **The machine is reported as "Unknown Hostname".** The day's `machines`
  breakdown attributes exactly `68.267582s` — all of harness's time — to
  `Unknown Hostname`, while every wakatime-cli-sent heartbeat in the account
  lands on `jhlsMacBookPro`. `send.mjs` sends no machine-name header. Fixing it
  would mean sending the hostname, which is new data leaving the machine and a
  Privacy-section change; recorded, not made.
- **The user-agent resource is created asynchronously.** Its `created_at` was
  `11:17:12Z` for a heartbeat whose `last_seen_at` is `11:16:08Z`, and it was
  absent from `GET /users/current/user_agents` (capped at 100 rows, newest
  `last_seen_at` first) for about a minute afterwards. A verification that reads
  that list immediately after sending will not find the entry.
- **Project and branch detection worked on the real repo**: `project:
  "harness-plugin"`, `branch: "feat/wakatime"`, cached in `state.json` keyed by
  `workspace_root`, as designed.
- **`config.Load` applies `timeout_seconds = 10`** to a `[[hooks]]` block that
  omits it.

### 6. The `[[hooks]]` block that was used

```toml
[[hooks]]
event   = "RunEnd"
command = "/Users/jhl/Documents/Dev/JianyueLab/harness-plugin/scripts/wakatime"
args    = ["--detach"]
```

It was **not** written into the user's own `config.toml`, and that file was not
touched: on this machine it is a symlink into the nix store, managed by
home-manager, so editing it in place is neither possible nor right. It was
passed to harness as `--config <copy>` instead, which exercises the same
`config.Load` path.

### 7. Fix round 1 (2026-09-13): the UA grammar, established by experiment

§1 above recommended "insert a `<model>/<version>` token ahead of
`harness/<version>`". **Taken literally, that does not work**, and four probes
establish why. Each row below is a real request whose `user_agent` resource was
read back; only the `value` differs between them.

| probe | User-Agent sent | `ai_model` | `ai_model_version` | `go_version` |
|---|---|---|---|---|
| P1 | `wakatime/1.0.0 (…) gpt/5.6-sol harness/27c49f9 harness-wakatime/0.1.0` | `"Wakatime"` | `"1.0.0"` | `null` |
| P2 | `… gpt-5.6-sol/0 harness/… harness-wakatime/…` | `"Wakatime"` | `"1.0.0"` | `null` |
| P3 | `… o3 harness/… harness-wakatime/…` | `"Wakatime"` | `"1.0.0"` | `null` |
| P4 | `… o3/0 harness/… harness-wakatime/…` | `"Wakatime"` | `"1.0.0"` | `null` |

The model token in that position is simply ignored. What actually decides the
slot is a token **between the platform group and the model** that literally
begins with `go` — the one element our User-Agent never had, and which every
real `wakatime-cli` User-Agent in the account does:

| probe | third token | `ai_model` | `ai_model_version` | `go_version` |
|---|---|---|---|---|
| P5 | `go1.27.1` | **`"GPT"`** | **`"5.6-sol"`** | `"1.27.1"` |
| P6 | `bun1.4.2` | `"Wakatime"` | `"1.0.0"` | `null` |
| P7 | `bun/1.4.2` | `"Wakatime"` | `"1.0.0"` | `null` |
| P8 | `go0.0.0` | **`"GPT"`** | **`"5.6-sol"`** | `"0.0.0"` |

So the grammar is positional with a mandatory `go…` element, and **its value is
not validated** (P8 parses identically to P5). `editor: "Harness"`,
`version: "0.1.0"`, `os: "Mac"` and `cli_version: "1.0.0"` were unchanged in
every one of P1–P8 — the fix costs none of them.

Three more probes settled the remaining choices rather than guessing them:

- **P9 — drop the leading `wakatime/<ver>` token entirely** (so there is nothing
  to misattribute): *worse.* The platform group itself slides into the slot —
  `ai_model: "(Darwin-27.0.0-Arm64)"` — and `cli_version` becomes `null`. The
  leading token stays.
- **P10 — a second model name.** `claude/opus-5` → `ai_model: "Claude"`,
  `ai_model_version: "opus-5"`. At the time this was read as "the first-hyphen
  split generalises"; §8 shows what it actually proved — that the split buckets
  by vendor, which is why the split was abandoned.
- **P11 — a hyphen-less model name as a bare token**, no slash: `o3` →
  `ai_model: "O3"`, `ai_model_version: null`. **No filler version is needed**,
  so none is invented.
- **P12 — no model token at all** (the `--flush` case), with the `go` token
  present: `ai_model: null`, everything else intact. The empty slot is clean and
  does *not* reintroduce the "Wakatime" bug — that bug needs the `go` token to be
  missing.

**What this round produced** — later superseded by §8, which replaced the
`family/variant` split with one bare token; the `go0.0.0` finding above stands
unchanged. Verified end-to-end through harness's real `hook.Runner` into
`scripts/wakatime` with `model: "claude-sonnet-5"` in the payload:

```
wakatime/1.0.0 (darwin-27.0.0-arm64) go0.0.0 claude/sonnet-5 harness/27c49f9 harness-wakatime/0.1.0
```

read back as `editor: "Harness"`, `version: "0.1.0"`, `os: "Mac"`,
`cli_version: "1.0.0"`, `go_version: "0.0.0"`, **`ai_model: "Claude"`**,
**`ai_model_version: "sonnet-5"`**. The same request's app heartbeat came back
with **`ai_input_tokens: 120`** (sent `input_tokens: 100` +
`cache_creation_input_tokens: 20`) and **`ai_cached_input_tokens: 300`** (sent
`cache_read_input_tokens: 300`), and still **no `model` key** on the heartbeat
resource — confirming both halves of §3 in one request.

**Residue this verification left in the account, since it is visible on the
user's own dashboard:** the day's `ai_model_breakdown` now carries four phantom
models from the probes — `Wakatime` ($0.098073, from the pre-fix rows),
`GPT` ($0.000048), `O3` ($0.000018) and `(Darwin-27.0.0-Arm64)` ($0.000018) —
plus about 13 minutes of `Harness` editor time. None of them will grow: every
future request carries the model token and the `go` token.

### 8. Fix round 1, revised: one bare token per model, not `family/variant`

§7's `family/variant` split was reviewed before it shipped and **rejected**. The
reason is in the Privacy section above; this section records the evidence.

**The account was sampled wrong the first time.** `GET /users/current/user_agents`
is paginated — `total: 643`, `total_pages: 7` — and §1 read only page 1. "There is
no existing `Claude` row" was an artefact of that. Reading all seven pages:

| `ai_model` | rows | a raw `value` that produces it |
|---|---|---|
| `Claude` | 200 | `wakatime/2.14.5 (darwin-27.0.0-arm64) go1.26.5 ClaudeCode/2.1.143` |
| `Opus` | 76 | `wakatime/v2.20.3 (windows-…) go1.26.4 opus/4-8 claude-code/2.1.168 vscode/1.123.0 vscode-wakatime/30.2.0` |
| `Sonnet` | 4 | `wakatime/v2.26.0 (darwin-…) go1.26.6 sonnet/5 claude-code/2.1.236` |
| `Haiku` | 10 | `wakatime/v2.20.5 (windows-…) go1.26.4 haiku/4-5-20251001 claude-code/2.1.185` |
| `Claude-Code` | 13 | `wakatime/v2.20.5 (windows-…) go1.26.4 claude-code/2.1.183 vscode/1.123.0 vscode-wakatime/30.2.1` |

Two things follow. **`Claude` is not the Claude model** — it is
`ClaudeCode/2.1.143`, an *editor* token with an app version, misparsed by WakaTime
into model `Claude` version `2.1.143`; it carried $696.59 in one day. And
**Claude Code reports real models variant-first** (`opus/4-8`, `sonnet/5`,
`haiku/…`, `fable/5`), so the family half is `Opus`, never `Claude`.

The two rows §7 shipped therefore land in the wrong place, which the API confirms
directly:

```
… go1.27.1 claude/opus-5   harness/27c49f9 …  -> ai_model "Claude", ai_model_version "opus-5"
… go0.0.0  claude/sonnet-5 harness/27c49f9 …  -> ai_model "Claude", ai_model_version "sonnet-5"
```

Both in `Claude`. Since attribution is by name only (§3), that is not just "opus
and sonnet not separated" — it is harness's spend disappearing into another
tool's $696 bucket and inflating its numbers.

**The replacement, verified:**

| probe | model token sent | `ai_model` | `ai_model_version` |
|---|---|---|---|
| P13 | `claude-opus-5` | `"Claude-Opus-5"` | `null` |
| P15 | `gpt-5.6-sol` | `"Gpt-5.6-Sol"` | `null` |
| P14 | `anthropic-claude-opus-5` | `"Anthropic-Claude-Opus-5"` | `null` |

`editor: "Harness"`, `cli_version: "1.0.0"`, `os: "Mac"`, `go_version: "0.0.0"`
in all three — the change costs none of §1's results.

**P14 exists because `payload.model` can contain a `/`.** Verified in harness's
source, not assumed: `resolveModelSpec` (`cmd/harness/main.go`) splits a `/model`
argument at the **first** slash only and deliberately leaves the remainder in the
model name — its own comment says 「模型名本身可能含 "/"（某些网关用路径式命名）」 —
so `anthropic/claude-opus-5` is a reachable value. Passing it through untouched
would have re-created the `family/variant` shape with a *vendor* as the bucket
name. Both `/` and whitespace are collapsed to `-`.

**A zero-pollution probe channel, found while doing this.** A `GET` with a custom
User-Agent creates **no** user-agent row (none of the read-only strings used here
appear among the 643). A heartbeat with `ai_input_tokens: 0` /
`ai_output_tokens: 0` creates the parsed user-agent row but **no**
`ai_model_breakdown` row — verified by diffing the day's breakdown across P13,
P14 and P15: the same seven rows before and after, none of `Claude-Opus-5`,
`Gpt-5.6-Sol` or `Anthropic-Claude-Opus-5` present. **These probes added zero
phantom rows**, unlike P1–P12. Their only trace is a few minutes of `Harness`
editor time and four more rows in the user-agent list.

The fourth of those is the final end-to-end check: the tool's own output, fired
through harness's real `hook.Runner` with `model: "anthropic/claude-opus-5"` and
zero usage counters, produced

```
wakatime/1.0.0 (darwin-27.0.0-arm64) go0.0.0 anthropic-claude-opus-5 harness/27c49f9 harness-wakatime/0.1.0
  -> editor "Harness", version "0.1.0", os "Mac", cli_version "1.0.0",
     go_version "0.0.0", ai_model "Anthropic-Claude-Opus-5", ai_model_version null
```

— byte-identical to P14's `value`, and it still got **its own** `user_agent_id`
(`cd968598-…` beside P14's `811fe25f-…`). **User-agent rows are not deduplicated
by value**, so repeating an identical User-Agent adds a row; only the
`ai_model_breakdown` is spared by the zero-token trick.

The four phantom rows P1–P12 left (`Wakatime`, `GPT`, `O3`,
`(Darwin-27.0.0-Arm64)`) were **not** deleted: removing data from the user's own
account is their call, not this task's.
