# JianyueLab harness tools

Two independent, dependency-free tools run on Bun or Node:

- **[`jyl-memory`](#jyl-memory)** recalls and distils session memories through
  the memory MCP server. Install it through the `jianyuelab-claude` marketplace.
- **[`jyl-wakatime`](#jyl-wakatime)** sends harness coding activity and token
  counts to WakaTime. Configure its standalone `scripts/wakatime` launcher.

## jyl-memory

Recalls JianyueLab memory at session start and distils each session into it when the session ends.

**What leaves the machine:** distilled memories only, written through the `memory` MCP server into your personal project or a team project matched to the repository. Repository origin URLs, without credentials, go to the `memory` server for project lookup. Session text goes only to the model of the host you are already using (`claude -p`, `codex exec`, `omp -p`), with tool output dropped and known secret shapes redacted.

### Install

Prerequisite: the `memory` MCP server is configured and logged in for each host (`/mcp` in Claude Code, `codex mcp login memory`).

- Claude Code: `/plugin marketplace add JianyueLab/harness-plugin`, then `/plugin install jyl-memory@jianyuelab-claude`.
- Codex: `codex plugin marketplace add JianyueLab/harness-plugin`, `codex plugin add jyl-memory@jianyuelab-claude`, then trust both hooks in `/hooks`.
- omp: link `plugins/jyl-memory/hooks/post/jyl-memory.ts` into `~/.omp/agent/hooks/post/` (omp loads `hooks/post/*.ts`; it ignores `hooks/hooks.json`), or run omp with `--plugin-dir plugins/jyl-memory`.

This repo's `.agents/plugins/marketplace.json` takes precedence over `.claude-plugin/marketplace.json` for Codex, so Codex lists only `jyl-memory` from this repo.

`JYL_MEMORY_RUNTIME` may name an absolute `node` or `bun` binary; otherwise the launcher uses `bun`, then `node`, from `PATH`.

### How it works

- Session start: a short prompt tells the agent to search memory before working. In omp, it is appended to the system prompt.
- Session end: the hook hands the transcript to a background worker and returns. The worker takes messages not distilled yet, skips sessions with fewer than 3 new user messages or under an excluded directory, and runs the host CLI with only the memory MCP tools:
  - Claude Code: built-in tools off.
  - Codex: shell, plugins, apps, hooks and every other configured MCP server off.
  - omp: always-ask approval, with only the seven memory tools allowed.
- Allowed tools: `jyl_project_list`, `jyl_project_find`, `jyl_project_get_context`, `jyl_memory_search`, `jyl_memory_get`, `jyl_memory_add`, `jyl_memory_update`.
- In omp, `/new`, fork, resume and branch switches also distil the session left behind.
- The worker lists the git repositories of the session directory: its repository and checked-out submodules, or its direct child repositories. Each has an origin and an optional project id. At most 50 repositories are listed, and listing stops after 5 s.
- Each memory goes to one project, first match wins:
  1. a project the user named in the session;
  2. the repository's project from `projects` in the config, then from `.jyl-memory.json` in the repository root;
  3. the team project registered for the repository's origin (`jyl_project_find`);
  4. your personal project.
- Team projects get only decisions, facts and background about their repository, with visibility `project`. Private preferences, personal information and content matching no repository go to your personal project. A team project where you are `reader` falls back to your personal project.
- The host searches existing memories first and updates them instead of adding duplicates; at most 5 writes per project.
- Progress is recorded only when the host exits 0 and its last line is `done`.
- A failed run is retried at the next session end. The log line carries the last line of the host's stderr, with known secret shapes redacted.
- A refusal (omp prints a stderr line starting with `Refusal`) is not retried: those messages are recorded as refused, and later runs send only newer messages.
- A session closed before its first message has no transcript; it is logged as `skip no_transcript`.
- Each distillation costs one host model run.

### Config

`~/.config/jyl-memory/plugin.json`, optional:

| Key | Default | |
|---|---|---|
| `enabled` | `true` | `false` turns the plugin off |
| `exclude_paths` | `[]` | sessions under these directories are not distilled |
| `min_user_messages` | `3` | fewer new user messages: skip |
| `max_chars` | `200000` | text cap per run (newest messages kept) |
| `mcp_server` | `memory` | name of the memory MCP server in each host |
| `models` | `{"claude-code":"haiku","codex":null,"omp":"@smol"}` | model per host; `null` uses the host default |
| `projects` | `{}` | directory → project UUID; the longest matching directory applies to repositories under it |

`.jyl-memory.json` in a repository root: `{"project_id": "<UUID>"}`. An invalid file is ignored and logged as `<session> warning: …`.

State and log: `~/.local/state/jyl-memory/` (`plugin-state.json`, `plugin.log`).

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
counts (fresh input and cache-served input reported separately),
the prompt length in characters, **the model id**, and the session id — **not
one this tool invents per run**, but the id harness generates once for its
own process and stamps into every run's payload, so it is a single value
shared by everything that process reports, not a fresh one per run. The
request itself also carries a User-Agent identifying this tool, harness, the
model and the machine, e.g.
`wakatime/1.0.0 (darwin-27.0.0-arm64) go0.0.0 claude-opus-5 harness/27.0.17 harness-wakatime/0.1.0`
— OS, kernel release, CPU architecture, the model, harness's version and this
tool's own. **It never sends** prompts, completions, file contents, tool
arguments, command lines, or tool results — harness's `RunEnd` payload does
not carry any of those to begin with, so this is enforced upstream, not by
this tool's restraint.

**The model id is on that list, and an earlier version of this README said it
was not.** The reason given was "WakaTime's heartbeat has no model field, so
there is nowhere to put it". The first half is true — a heartbeat posted with a
`model` field comes back stored without it, checked against the live API — but
the conclusion was wrong. **WakaTime keeps the model in the User-Agent**, in the
`claude-opus-5` slot above, which it parses out and uses for the AI-model cost
and line-change breakdowns on your dashboard. Every other AI tool reporting into
WakaTime already fills that slot.

**On your dashboard the model shows up as `Claude-Opus-5`** — the whole model
name, one row per exact model, with no version. It is sent as a single token on
purpose: WakaTime buckets AI-model cost by **name only** (the version it parses
out appears in none of the cost, line-change or breakdown structures), so a
`claude/opus-5`-style token would put every Claude model — opus, sonnet, haiku —
into one `Claude` bucket. Worse, in a real account that bucket is not "the Claude
model" at all: it is Claude Code's own `ClaudeCode/<app version>` token, which
WakaTime misreads as a model, so harness's spend would vanish into another tool's
row and inflate its numbers.

The trade-off is that harness's Opus time will **not** merge with Claude Code's
`Opus` row. That is deliberate: there is no consistent model naming across
WakaTime integrations to merge with anyway, and slicing your time by tool is what
the **Editors** breakdown is for, where `Harness` is already its own row.

Leaving it empty was not the neutral choice it looked like: WakaTime's parser is
positional, and with the slot empty it took the User-Agent's own leading
`wakatime/1.0.0` token as the model — so the dashboard grew **a model called
"Wakatime" with real dollar figures against it**. The `go0.0.0` token above is
what holds that position; its value is ignored and deliberately fake, because
this tool has no Go version to report and a hardcoded one would go stale while
still reading as authoritative.

Why this trade is fine: a model id is far less sensitive than what this tool
already sends on purpose — your absolute file paths and project names. It says
which model did the work, not what the work was. If a model id is more than you
want to share, the file paths already are too; use `hide_file_names`, or do not
install this.

One kind of model name never reaches the dashboard: one written outside
printable ASCII. Two different reasons, worth separating because they affect
different people:

- **A character above U+00FF** — a gateway alias in Chinese, say. The model slot
  lives in the User-Agent, and an HTTP header genuinely cannot carry those:
  `fetch` refuses the whole request. Reporting no model is what stops that from
  turning every send into a "network error" that respools forever.
- **An accented latin1 name like `café-5`** — which the header layer *would*
  accept; this was measured, not assumed. It is dropped anyway, because this
  token's whole job is to be a stable bucket name in your dashboard, and a byte
  sequence whose reading depends on how the server decodes it is not one.

Either way the run still reports everything else — files, project, branch,
tokens — and the AI-model slot is simply empty rather than wrong.

One caveat about those token counts: when a run's `outcome` is `"cancelled"`
or `"error"` instead of `"ok"`, harness may not have finished accumulating
that run's *last* turn of usage before it returned — the failing path exits
before that turn's tokens are added in. This is a deliberate choice on
harness's side (`outcome` is exactly how a consumer is meant to recognise an
incomplete run), not a bug here — but jyl-wakatime does not forward `outcome`
to WakaTime at all, so nothing on the heartbeat itself distinguishes a
complete run's counts from a possibly-short one. Treat `ai_input_tokens` /
`ai_cached_input_tokens` / `ai_output_tokens` as a lower bound, not a
guaranteed-exact count, on any run
that did not end `"ok"`.

### Install: wire it into harness

Clone or copy this repository somewhere that will not move. There is no
marketplace install for jyl-wakatime: harness's `command` needs a real
absolute path. The directory must stay at that path. The launcher also
needs `bun` or `node` on `PATH` at the moment harness execs it — set
`JYL_WAKATIME_RUNTIME` to an absolute interpreter path if neither resolves in
harness's environment (harness inherits its own full environment into the
hook, so this is usually the same `PATH` your shell has). If no runtime is
found, `scripts/wakatime` writes a line to stderr *and*, since harness
discards a hook's stderr and never runs `--status` for you, to
`~/.config/jyl-wakatime/log` — the one thing that keeps this specific failure
from being completely invisible (see "Is it working?" below). The same line
is written, naming the case, for the two other ways this can break before the
JS runs: a **moved or half-copied checkout** (`entry point missing at …`, the
failure the "somewhere that will not move" warning above is about) and a
`JYL_WAKATIME_RUNTIME` that exists and is executable but is not a working JS
runtime (`JYL_WAKATIME_RUNTIME exited N`). And the API
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
This tool does not honour `$XDG_CONFIG_HOME`. Its state path is defined by
`STATE_DIR`/`JSON_CONFIG_FILE` in `src/wakatime/cfg.mjs`; the
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
Splitting that value into a command and arguments mirrors `wakatime-cli`'s
own approach (quotes and backslash escapes are understood), but nothing
else is interpreted: no pipes, no `$VAR` expansion, no `;` chaining, no
`` ` `` or `$(...)` substitution — it is never handed to an actual shell. If
both `api_key` and `api_key_vault_cmd` are present, `api_key` wins and the
command never runs.

**Expanding a leading `~/` or bare `~` to your home directory is this
tool's own addition, not part of `wakatime-cli`'s behaviour** — real config
values commonly need it, and without it such a value simply failed to find
the command at all. It is not shell-faithful, though, and deliberately so:
a real shell skips tilde expansion for a quoted or escaped `~`, but this
splitter doesn't track which characters were quoted, so `"~"`, `'~'`, and
`\~` all expand exactly like a bare `~`. The consequence is real: **there
is no way to put a literal `~` in this command's arguments.** Teaching this
one character shell-accurate quoting, when every other character in this
value is already knowingly not shell, wasn't worth it for a case nothing
has needed.

The command gets 5 seconds — sized against harness's own 10-second default
hook timeout mentioned above, with headroom to spare, so this tool's own
timeout fires and gets logged well before harness would kill an undetached
hook process out from under it (a hung command is killed outright, not
asked nicely — but only the command itself, not anything it may have
forked off in the meantime). If the command is missing, exits non-zero,
times out, produces too much output, or prints nothing at all, it never
yields a key and never crashes — but unlike an outright absent config,
`--status` and the log say *which* of those happened
(`api_key_vault_cmd: command not found`, `: exited 9`, `: timed out`,
`: output too large`, or `: produced no output`), so it doesn't read
identically to "you never configured a key." What is never logged, on any
of those paths, is the command itself or anything it printed: a failing
vault command's stderr is exactly the kind of place a key, a passphrase
prompt, or other secret-shaped text could leak, so it is discarded unread
rather than risk that. When it does succeed, `--status` attributes the key
to `api_key_vault_cmd`, not to `~/.wakatime.cfg`'s path, so a key resolved
this way is visibly different from one written in plaintext (see below).

**If `--status` says `api_key_vault_cmd: command not found` for a command
you know exists,** check `PATH` before anything else: the hook runs with
whatever environment harness itself inherited, which on macOS is often *not*
your interactive shell's `PATH` (a GUI- or launchd-started harness commonly
gets a bare `/usr/bin:/bin`) — exactly where a password-manager CLI
installed via Homebrew (`/opt/homebrew/bin/…`) or a language-specific
installer would be missing. An absolute path in `api_key_vault_cmd` sidesteps
this entirely.

Self-hosted **wakapi** or **hakatime**: point `api_url` at it, in either file
above. A trailing slash is trimmed.

`[settings] hide_file_names = true` (or `"hideFileNames": true` in the JSON
config) is honoured: file entities are replaced with an obfuscated
placeholder that keeps only the file's own extension (`agent.go` becomes
`HIDDEN.go`; `a.test.ts` becomes `HIDDEN.ts`; `Makefile`, `.env` and
`.gitignore` become `HIDDEN`). Directory names never contribute. The branch
is not sent. The project name is still reported. This matches `wakatime-cli`,
except that it sends `HIDDEN.env` for a dotfile. `hide_branch_names` and
`hide_project_names` are not read.
Multiline `hide_file_names` regex lists hide matching paths case-insensitively
and suppress the branch on those file heartbeats. JSON `hideFileNames` also
accepts an array of patterns and keeps JavaScript's case-sensitive matching.
Both use JavaScript regex syntax; malformed expressions, unsupported POSIX
character classes and unsupported values stop reporting with a configuration
error. They never silently disable privacy.

**No API key anywhere means this tool quietly does nothing.** Not a crash,
not a log line on every single run — one line logged the first time, then
silence until the config is fixed. (`JYL_WAKATIME_DISABLED=1`, or
`"enabled": false` in the JSON config, turns it off the same way, on
purpose.) An install with no key configured is inert.

### Is it working? (`--status`)

**jyl-wakatime never exits non-zero and never throws, on any path it can
reach** — a bad config, a network failure, an unwritable state directory, no
runtime on `PATH`, a `JYL_WAKATIME_RUNTIME` that fails, a checkout missing
`src/wakatime/main.mjs`: none of it may turn a harness run red. (The one
exception is not reachable from inside the script: if no `sh` can be found for
`scripts/wakatime`'s `#!/usr/bin/env sh` line, `env` reports 127 before a single
line of it runs. Nothing in a shell script can catch its own interpreter going
missing.) That agrees with harness's own side: a hook failure
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
| `last send` | `accepted N, failed M` from the most recent attempt; `failed` staying above 0 across several runs means something is wrong, not a fluke. A third number, `rejected K`, appears **only when it is non-zero**: those heartbeats were refused outright and dropped for good, so they are neither `accepted` nor coming back via the spool. Any `rejected` at all is worth a look at the log — a partially-refused run is otherwise indistinguishable from a perfectly healthy one |
| `auth fails` | counts *consecutive runs that had something to send* and got a 401/403 back; a run that sends successfully, or fails for a different reason, resets it to 0 — but a run with nothing queued at all does neither, so a stale nonzero value can persist through a quiet gap. Nonzero means the key WakaTime saw the last time this tool actually tried to send was wrong or revoked |
| `accepted 0` with an **empty spool and no `PROBLEM` line** | the dangerous healthy-looking reading. Two ways to get here, both meaning "everything went in the bin". **The whole request was refused** with a non-retryable 4xx (anything but 401/403/429) — `send.mjs` drops that batch for good, so it never reaches the spool. Not hypothetical: a mistyped path on a self-hosted wakapi/hakatime `api_url` produces exactly this. Or **the request was accepted and each heartbeat inside it was refused** — WakaTime answers `202` with a status per heartbeat, and a heartbeat rejected on content is dropped for the same reason. Either way `rejected N` now appears on the `last send` line — that is the tell, and it is the reason to read the log next: `wakatime rejected 3 heartbeat(s), dropping: 400 bad request` for the whole-request case, `wakatime rejected 3 of 3 heartbeat(s) individually, dropping: 400 x3` for the per-item one. What `accepted` counts is heartbeats WakaTime said it **kept** — never heartbeats merely handed over — which is what makes this reading a signal at all |

The full log behind that summary is `~/.config/jyl-wakatime/log`, capped at
256 KB by `src/core/store.mjs`. `./scripts/wakatime --flush` retries whatever is
currently spooled right away, reading no stdin — worth running immediately
after fixing a bad key or a wakapi outage rather than waiting for harness's
next run to pick the spool back up (which happens automatically too, on
every hook invocation).

### There is no `--backfill`

jyl-wakatime's only input is one JSON line on stdin, read once, by a process
that then exits. A heartbeat
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

## Local checks

From the repository root:

```sh
bun test
node --test tests/review-blockers.test.mjs
./scripts/wakatime --status
printf '%s\n' '{"cwd":"/nonexistent/jyl-memory-smoke"}' | ./plugins/jyl-memory/scripts/run start
printf '%s\n' '{}' | ./plugins/jyl-memory/scripts/run end
```

The memory start command prints the recall prompt. The empty end payload
does not start a distillation. WakaTime status does not send heartbeats.
