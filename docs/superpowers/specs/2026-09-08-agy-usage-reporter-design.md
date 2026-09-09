# Reporting Antigravity CLI usage to the portal

**Status:** approved design, not yet implemented
**Date:** 2026-09-08
**Repos touched:** `JianyueLab/claude-plugin` (this one), `JianyueLab/llm-web`

## Why

`jyl-usage` closes the gap where Claude Code spends an Anthropic subscription
the portal cannot see. The Antigravity CLI (`agy`) opens the same gap against a
Google subscription: every turn burns Gemini tokens that never pass through
`llm-web`'s `/v1` proxy, so they appear nowhere in the portal's reports or
leaderboard.

This design adds a second reporter, for `agy` only, that lands its counts in the
same `usage_events` table under a new `source`.

## Scope

**In:** the Antigravity **CLI** (`agy`, Homebrew, `~/.gemini/antigravity-cli/`).

**Out:** Antigravity 2.0 desktop (`~/.gemini/antigravity/`) and the IDE
(`~/.gemini/antigravity-ide/`). They share the plugin format and the hook
contract, and the reader takes a directory list rather than a constant, so
adding them later is a list entry plus a verification pass — but nothing here is
verified against them, and this machine has no data from either.

## What `agy` actually gives us

Established by inspecting `agy` 2.12.0 (`/opt/homebrew/bin/agy`, a Go binary
whose embedded documentation is readable with `strings`) and the live state under
`~/.gemini/antigravity-cli/`.

### Plugins

Same shape as Claude Code's, different spelling:

```text
plugins/<plugin_name>/
  plugin.json       # required; `name` is the only documented field, defaults to the dir name
  hooks.json        # optional; lifecycle hooks
  skills/<name>/SKILL.md
  rules/AGENTS.md
  mcp_config.json
```

Plugins live under a customization root's `plugins/` directory (e.g.
`.agents/plugins/`). `agy plugin install <target>` accepts `plugin@marketplace`,
`agy plugin import from claude` imports Claude Code plugins, and `.claude-plugin`
appears in the binary — but the marketplace file format is **not** documented in
the binary, so the install path is an open item (below).

### Hooks

Events: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`.
`hooks.json` is keyed by **hook name**, each mapping to its events; `Stop` takes a
flat list of handler objects (no `matcher`/`hooks` wrapper — that shape is only
for the two tool events).

Handlers run via `sh -c`, with the working directory set to the directory
containing `hooks.json`, `~` expanded, and a default 30-second timeout. Payload
arrives as JSON on **stdin** in camelCase (protojson): `conversationId`,
`workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`, plus
per-event fields. `Stop` additionally carries `executionNum`,
`terminationReason`, `fullyIdle`. Its output contract: `{"decision": "continue"}`
blocks the stop; **any other value lets the agent stop**, so `{}` is the safe
reply.

**Hooks run synchronously and block the agent loop.** There is no `async: true`
as in Claude Code. This is the single most important constraint in this design.

### Where the token counts are

Not in `transcriptPath`. `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`
carries `step_index`, `source`, `type`, `status`, `created_at`, `content`,
`tool_calls`, `thinking` — and no usage of any kind. Neither the CLI logs, nor
`conversation_summaries.db`, nor `annotations/*.pbtxt` (titles only) carry it.
`agy agentapi get-conversation-metadata <id>` returns
`jetski.product.v1.ConversationMetadata` — create time, project id, parent/root
ids, title — also no usage, and it only works with `ANTIGRAVITY_LS_ADDRESS` set,
i.e. from inside a live session.

The counts live in `~/.gemini/antigravity-cli/conversations/<conversation-id>.db`,
a SQLite database with one row per generation in `gen_metadata(idx, data, size)`.
`data` is an opaque protobuf — no field names on the wire — but it embeds two
plain strings we need:

```text
gemini-3.8-flash
request_id  221847bd-ffa9-4bf9-ac73-9e739ddfe52c-40
```

and these varints, observed consistent across three conversations and many rows:

| Field path | Reading | Evidence |
|---|---|---|
| `1.4.1` | **not a token count** — the model enum | constant 1318 in every row; the blob also spells `model_enum: MODEL_PLACEHOLDER_M318` |
| `1.4.2` | input tokens **not** served from cache | 26404 on the first generation, 3507 / 5307 later |
| `1.4.5` | input tokens served from cache | absent on the first generation, then 82207 → 156239 monotonically |
| `1.4.9` | thinking output | |
| `1.4.10` | text output | |
| `1.4.3` | output total | equals `1.4.9 + 1.4.10` in every row sampled |

The same message is mirrored at `1.17.2.*`. A sibling message at `1.9.10` holds
`{1: context tokens used, 4: 256000}` — the context-window gauge `/usage`
displays, not per-request usage.

## Architecture

### Repository layout

One repository root, **two manifests side by side**. The two plugin formats do
not collide on a single filename, so nesting is unnecessary:

```text
.claude-plugin/plugin.json      Claude Code manifest
.claude-plugin/marketplace.json Claude Code marketplace (source stays "./")
plugin.json                     agy manifest
hooks/hooks.json                Claude Code hooks (SessionStart, Stop, …)
hooks.json                      agy hooks (Stop)
commands/jyl-usage.md           Claude Code slash command
skills/jyl-usage/SKILL.md       agy skill (same three verbs)
scripts/run                     shared launcher, now taking `--host`
src/core/                       config · lock · spool · seen · upload · log · state
src/hosts/claude-code.mjs       reads transcript JSONL `message.usage`
src/hosts/antigravity.mjs       reads conversations/*.db `gen_metadata`
src/reporter.mjs                entry point; `--host` selects the adapter
```

Nesting each plugin under `plugins/<name>/` was the obvious layout and is the
wrong one: an install copies the plugin directory, so the shared `src/` would be
left behind on both sides, and `agy` resolves a hook's `command` relative to the
directory holding `hooks.json` — from a nested directory that path would have to
escape upwards, out of what was installed. Keeping both manifests at the root
means each host copies the whole thing, `${CLAUDE_PLUGIN_ROOT}` keeps pointing
where it always did, and the marketplace `"source": "./"` needs no change, so
existing installs are untouched.

The two hosts differ only in *where the bytes are and how they parse*. Everything
that made `jyl-usage` safe — the lock, the spool, the global dedup window, the
retry classification, the catch-up sweep — is host-agnostic and moves to
`src/core/` unchanged in behaviour.

### Trigger

The root `hooks.json` registers one handler, on `Stop`:

```json
{
  "jyl-usage": {
    "Stop": [
      { "type": "command", "command": "./scripts/run --host antigravity --detach", "timeout": 10 }
    ]
  }
}
```

`agy` runs the command with its working directory set to the directory holding
`hooks.json` — the plugin root — so `./scripts/run` is the launcher this repo
already ships.

Because the hook blocks the loop, `--detach` makes `scripts/run` fork the real
work into the background with its stdout and stderr redirected away from the
hook's — the hook itself prints `{}` and exits immediately. Anything the child
writes to the hook's stdout would be parsed as a `Stop` decision, so the
redirection is a correctness requirement, not tidiness.

No other event is used. `PreInvocation` fires before every model call and would
multiply the work for nothing; the catch-up sweep already covers what a missed
`Stop` would strand.

### Reading

Per conversation the state file records `lastIdx`, the highest `gen_metadata.idx`
already read, so a run reads `WHERE idx > lastIdx` and nothing twice. This
replaces the byte-offset bookkeeping the Claude Code host uses; the ordering
guarantee that protects it is the same — spool first, then advance `lastIdx`, so
a crash re-reads rather than drops.

Every run also sweeps conversation databases whose mtime moved since the offset
was last advanced, newest first, capped per run, exactly as the Claude Code host
sweeps transcripts.

Field extraction is by **structural signature with invariants**, not by trusting
field numbers alone. A candidate usage message is checked by two guards:
1. The output total must equal thinking plus text (`f3 == f9 + f10`) — this catches
   drift in the output triad if `agy` renumbers those three fields.
2. Every varint field number in the counts message must be from the known set
   {1, 2, 3, 5, 6, 9, 10} — this catches renumbering that introduces new fields.
   Field 6 joined the set during Task 11: agy 1.1.27 (the version actually
   installed, newer than the 2.12.0 this mapping was read from) adds it to
   every row, always the constant `24` regardless of token counts — permitted
   because it is evidently not a token count, but not read into any output
   field, since what it is remains unknown.
3. Neither guard catches a permutation among the six token-bearing field numbers.
A row failing either guard is skipped and logged, never guessed at. The
consequence of `agy` changing its protobuf is under-reporting, which is visible
in `--status`, rather than fabricated numbers in the portal.

SQLite access, in order, first that works: `bun:sqlite`, `node:sqlite`, the
system `sqlite3` binary, otherwise skip and log. Databases are opened read-only;
`agy` keeps them in WAL mode and must not be disturbed.

### Event mapping

The existing wire contract covers this with no new fields:

| Portal field | Antigravity source |
|---|---|
| `requestId` | the `request_id` string in the blob (`<trajectory-id>-<idx>`) |
| `model` | the model-id string in the blob (e.g. `gemini-3.8-flash`) |
| `ts` | `created_at` for the matching step in `transcript.jsonl`, falling back to the database's mtime |
| `inputTokens` | uncached input (`1.4.2`) |
| `cacheReadTokens` | cached input (`1.4.5`) |
| `outputTokens` | thinking + text (`1.4.3`) |
| `cacheWrite5mTokens`, `cacheWrite1hTokens` | always 0 — Gemini's implicit caching has no priced write |
| `source` | `"antigravity"` |
| `client` | `antigravity-usage-reporter/<version>` |

`request_id` is per generation and unique, which is exactly what the portal's
`missing_request_id` check and its unique index want, so retries and repeated
backfills stay idempotent.

Events older than the portal's `MAX_EVENT_AGE_DAYS` (100) are rejected as
`too_old`; the timestamp fallback must therefore be a real time, not `now`, or
old conversations would be silently re-dated.

### Configuration and state

Config resolution gains a shared path so one key serves both hosts:

1. environment (`JYL_USAGE_BASE_URL`, `JYL_API_KEY`, `JYL_USAGE_DISABLED`)
2. `~/.config/jyl-usage/config.json` (new, shared)
3. `~/.claude/jyl-usage/config.json` (existing, kept working)

State stays **per host** — `~/.claude/jyl-usage/` and `~/.gemini/jyl-usage/` —
each with its own `state.json`, `seen`, `spool.jsonl`, `log`, `lock`. Offsets
mean different things per host and the dedup windows cover disjoint id spaces, so
sharing them would only create ways to corrupt one host from the other.

### The `/jyl-usage` equivalent

`agy` exposes plugin commands as skills, so the Claude Code command gets a
sibling at `skills/jyl-usage/SKILL.md` with the same three verbs: status, flush,
backfill.

That directory is also visible to Claude Code, which loads a plugin's `skills/`
too, so the repo would expose both a `/jyl-usage` command and a `jyl-usage` skill
to the same host. Confirm during implementation whether Claude Code minds; if it
does, the skill directory takes a distinct name and `agy` gets the longer verb.

## The `llm-web` change

Separate repo, separate PR, and the plugin is useless until it lands:

1. `INGEST_SOURCES` (`src/server/ingest.ts:57`) gains `"antigravity"`. It is a
   whitelist — until then every upload is a 400, which the plugin spools and
   retries, so no usage is lost in the meantime.
2. Wherever a source is rendered with a human label (reports, leaderboard), add
   the new one.
3. `gemini-3.8-flash` is not in the model catalogue, so the first report creates
   an unpriced `model_prices` row that an admin has to price. Worth doing before
   announcing the plugin, or the first week of Antigravity usage shows tokens at
   zero cost.

## Failure modes

| Situation | Behaviour |
|---|---|
| Not configured | silent no-op, as today |
| No SQLite access of any kind | logged, no report; never a non-zero exit from a hook |
| `agy` changes its protobuf | invariants fail, rows skipped, `--status` shows it |
| Portal rejects `antigravity` (401/403/429/5xx/400 whitelist) | spooled and retried per the existing classification |
| Hook times out | agent loop is untouched: the handler returns `{}` in milliseconds and the work is detached |
| Two sessions report at once | the existing lock serialises them; the loser's bytes are picked up by the next sweep |
| Portal predates `antigravity` in `INGEST_SOURCES` (today's reality — Task 10 has not shipped) | `postBatch` reads the 400's `error.code`; `"invalid_source"` (with a prose fallback for an older portal build) is treated exactly like a revoked key — spooled, not dropped — so a plugin installed before the portal learns the new source loses nothing, it just queues until the portal side lands |

## Testing

The repo has no test runner today (`node --check` is the whole build). This adds
`bun test`, with:

- fixture `.db` files copied from real conversations, asserting parsed events
  match expected counts, model ids and request ids;
- the invariant check exercised against a deliberately-mutated fixture, asserting
  the row is skipped rather than misread;
- a pure-function test that the field mapping produces the portal payload above;
- the existing Claude Code host kept green through the `src/core/` extraction —
  the refactor is the risk this PR carries, not the new host.

## Open items to settle during implementation

1. **Install path.** Still open — `agy plugin install` was deliberately never
   run, across every task that touched this repo, because it writes into the
   user's own `agy` customization root and `config.json`. `agy plugin
   validate .` returns `[ok]`, so the manifest itself is accepted; whether
   `install <target>` takes a bare path, needs `agy plugin import from
   claude`, or wants a marketplace file in a format the binary does not
   document, is unverified. The README documents `agy plugin validate` plus
   installation by path as the expected route, explicitly flagged there as
   the untested half.
2. **`plugin.json` fields.** ~~Only `name` is documented.~~ **Resolved.**
   `agy plugin validate .` returned `[ok]` with `description` present (Task
   8) and, later, with `version` added alongside it (Task 9) — no reduction
   to `{"name": …}` was ever needed.
3. ~~**Step-index join for `ts`.**~~ **Resolved while writing the plan.**
   `gen_metadata.idx` *is* the transcript's `step_index` — both tables in the
   database are keyed on it, steps 40 and 84 of the sample conversation are
   `source: MODEL` entries carrying `created_at`, and the blob's own
   `last_step_index` and the suffix of its `request_id` both equal `idx`. The
   join is exact. The database-mtime fallback stays for conversations whose
   transcript is missing or half-written.
4. **Field-number confirmation.** ~~Step 5 extracted 168 generations~~ **Updated
   in Task 11, against agy 1.1.27 (not the 2.12.0 used to build the mapping):**
   before Task 11's fix, extraction against the live conversation's 462 real
   rows (grown from Task 3's 168) yielded **zero** events — the unknown-field
   guard (item 2 above) was correctly rejecting every row over a newly-added
   constant field, `1.4.6 = 24`. With field 6 added to the known set, 461/462
   rows yield valid events (the one exception has no model string at all — a
   different, pre-existing skip path). The output-triad invariant (`f3 == f9 +
   f10`) held on all 461. A cross-check against `agy`'s own `/usage` panel to
   validate these counts against ground truth was **not done** — the CLI's
   stored OAuth credentials had expired and refreshing them needed a fresh
   interactive Google consent flow, which was correctly not completed without
   asking the user first (see the Task 11 report); no interactive session, and
   so no `/usage` panel, was reachable in this run.
5. **Claude models under Antigravity.** The blob carries `used_claude` and
   `used_non_gemini_model` flags, so `agy` can spend non-Gemini models. The model
   string handles it; no special case is expected, but it is untested.
