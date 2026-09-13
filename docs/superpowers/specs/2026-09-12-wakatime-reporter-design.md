# Reporting harness activity to WakaTime

**Status:** implemented and documented (Tasks 1–6); Task 7 (reconcile the
workspace submodule path) and Task 8 (verify against a real WakaTime
endpoint) still open
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
as the key. Split into argv like a shell would (quotes, backslash escapes, a
leading `~/` or bare `~` expanded to `$HOME`), but never handed to an actual
shell — no pipes, no `$VAR` expansion, no `;` chaining. `api_key` wins if
both are present; the command never runs in that case. A failing command
(not found, non-zero exit, timed out, empty output) never yields a key and
never throws, but is diagnosed distinctly from "no key configured at all" —
see the failure table below — without ever logging the command or its
output. The 5s timeout on the command is sized against harness's own 10s
hook timeout (`DefaultHookTimeoutSeconds`), not picked independently: it has
to fire, log, and return well before harness would kill an undetached hook
process out from under it.

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
| `ai_input_tokens` | `usage.input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |
| `ai_output_tokens` | `usage.output_tokens` |
| `ai_prompt_length` | `prompt_chars` |

**Token fields ride only on this heartbeat, never on the file ones.** A run
that edits five files would otherwise report its tokens five times.

This heartbeat also covers the run where the agent ran nothing but `bash`:
work happened, and the time should not be zero because no file was named.

`ai_input_tokens` sums all three input counters deliberately. Cache reads are
tokens the model processed and the subscription paid for; splitting them out
would need a field WakaTime does not have.

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
counts, prompt length in characters, and a per-run session id.

It does **not** send the model id, though harness's payload carries one. There is
nowhere to put it: WakaTime's heartbeat has no model field, and its AI fields
(`ai_session`, `ai_input_tokens`, `ai_output_tokens`, `ai_prompt_length`,
`ai_line_changes`, `human_line_changes`, `ai_subscription_plan`) are all
counts or identifiers of a different kind. An earlier draft of this section
listed it; the mapping tables above never did, and the code never read it.

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
| `api_key_vault_cmd` configured but fails (not found / non-zero exit / timed out / empty output) | log once, exit 0 — but `--status` says which of those it was, not the generic "no API key configured", and never the command or its output |
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
2. **`ai_input_tokens` sums all three input counters.**
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

`tests/fixtures/runend.json` is the shared contract fixture; a test asserts it
parses into the fields the mapper expects, which is what makes a harness-side
rename show up here as a red test rather than as missing data.

## What has to be verified against the real service

Two things cannot be settled from documentation, and the implementation plan
needs a step for each.

1. **Editor attribution.** The dashboard identifies the editor by parsing the
   User-Agent, and we assemble ours by hand:
   `wakatime/1.0.0 (darwin-27.0.0-arm64) harness/27.0.17 harness-wakatime/0.1.0`.
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
