# jyl-wakatime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn harness's `RunEnd` hook payload into WakaTime heartbeats, so the hours an agent spends editing files stop being invisible.

**Architecture:** A second, independent tool in this repo, beside `jyl-usage` and sharing only `src/core/store.mjs`. `scripts/wakatime` finds a runtime; `src/wakatime/main.mjs` reads one JSON line from stdin; `heartbeats.mjs` maps it to WakaTime heartbeats and throttles them; `send.mjs` POSTs them 25 at a time to `heartbeats.bulk`; anything undelivered goes back to the spool.

**Tech Stack:** Plain ESM on node/bun built-ins. No dependencies, no build step. `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-12-wakatime-reporter-design.md`

**Depends on:** harness's `RunEnd` hook — `harness/docs/superpowers/plans/2026-09-12-harness-hook-system.md`. Tasks 1–6 here need only the fixture, so they can be built before harness ships; Task 8 needs a real harness that fires the hook.

**BASE:** `main` (suggested branch `feat/wakatime`).

## Global Constraints

Every task inherits these.

- **Zero dependencies, zero build.** Nothing added to `package.json` beyond the existing `private` / `type` / `test`.
- **Runs under both `bun` and `node`.** No `bun:`-only import outside `try`/`catch`, none at module top level.
- **Never exit non-zero, never throw out of the hook.** A broken reporter must not turn a harness run red.
- **This tool sends file paths and project names.** That is its purpose, it is stated in the README above the install instructions, and it is the reason it is not part of `jyl-usage`. It must never send prompts, completions, tool arguments, tool results, or command lines — harness's payload does not contain them (hook spec §5.3), and nothing here may reconstruct them.
- **The API key never appears in a URL.** `Authorization: Basic <base64(key)>`, never `?api_key=`.
- **`jyl-usage` is not touched.** No edits to `src/reporter.mjs`, `src/core/config.mjs`, `src/core/upload.mjs`, `src/core/report.mjs`, `src/hosts/*`, `hooks.json`, `plugin.json`, or `.claude-plugin/`. `src/core/store.mjs` is **read and used, not modified**.
- **WakaTime limits, copied verbatim from the API docs:** 25 heartbeats per `heartbeats.bulk` request; under 10 requests/second averaged over five minutes; `type` ∈ {`file`, `app`, `url`, `domain`}; `category` includes `ai coding`; `time` is float epoch seconds.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/wakatime` | New. Launcher: find `bun`/`node`, handle `--detach`, never exit non-zero. |
| `src/wakatime/main.mjs` | New. CLI: read stdin, dispatch `--hook` / `--flush` / `--status`. |
| `src/wakatime/cfg.mjs` | New. `loadWakaConfig` — env → `~/.wakatime.cfg` → `~/.config/jyl-wakatime/config.json`. |
| `src/wakatime/language.mjs` | New. `languageFor(path)` — extension table. |
| `src/wakatime/project.mjs` | New. `detectProject(root, state, now)` — git project + branch, cached in state. |
| `src/wakatime/heartbeats.mjs` | New. `heartbeatsFrom(payload, opts)` + `throttle(beats, state, now)`. |
| `src/wakatime/send.mjs` | New. `sendAll(ctx, beats)` — batches of 25, `{tally, failed}`. |
| `tests/fixtures/runend.json` | New. **Byte-for-byte copy** of `harness/hook/testdata/runend.json`. |
| `tests/wakatime-*.test.js` | New. One file per module above. |
| `src/core/store.mjs` | **Unmodified.** Used for `withLock`, `readSpool`/`writeSpool`, `loadState`/`saveState`, `log`. |

---

### Task 1: Config resolution

**Files:**
- Create: `src/wakatime/cfg.mjs`
- Test: `tests/wakatime-cfg.test.js`

**Interfaces:**
- Produces:
  ```js
  export const DEFAULT_API_URL = "https://api.wakatime.com/api/v1";
  export function parseWakaCfg(text)        // INI text -> { api_key?, api_url?, hide_file_names? }
  export function loadWakaConfig({ env, cfgPath, jsonPath })  // -> { apiKey, apiUrl, hideFileNames, enabled, source }
  export function configProblem(cfg)        // -> string | null
  export function redactKey(key)            // -> "waka…9f3c" | "(unset)"
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/wakatime-cfg.test.js`:

```js
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_API_URL,
  configProblem,
  loadWakaConfig,
  parseWakaCfg,
  redactKey,
} from "../src/wakatime/cfg.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-waka-cfg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const writeFile = (name, body) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, body);
  return p;
};

test("parses only [settings], and survives everything else in the file", () => {
  const got = parseWakaCfg(`
# a comment
[settings]
api_key = waka_abcd-1234
api_url = https://wakapi.example/api/v1
hide_file_names = true
exclude =
    ^/tmp/
    ^/private/
proxy = https://user:pass@host:port

[git]
disable_submodules = true
`);
  expect(got.api_key).toBe("waka_abcd-1234");
  expect(got.api_url).toBe("https://wakapi.example/api/v1");
  expect(got.hide_file_names).toBe("true");
  // Keys outside [settings] must not leak in — [git]'s value would otherwise
  // become a stray field.
  expect(got.disable_submodules).toBeUndefined();
});

test("a malformed cfg is not fatal", () => {
  expect(() => parseWakaCfg("]]] not ini at all\n\x00\x01")).not.toThrow();
  expect(parseWakaCfg("")).toEqual({});
});

test("env beats cfg beats json", () => {
  const cfgPath = writeFile("wakatime.cfg", "[settings]\napi_key = from_cfg\napi_url = https://cfg.example/api/v1\n");
  const jsonPath = writeFile("config.json", JSON.stringify({ apiKey: "from_json", apiUrl: "https://json.example/api/v1" }));

  expect(loadWakaConfig({ env: {}, cfgPath, jsonPath }).apiKey).toBe("from_cfg");
  expect(loadWakaConfig({ env: {}, cfgPath: "/nope", jsonPath }).apiKey).toBe("from_json");
  expect(loadWakaConfig({ env: { WAKATIME_API_KEY: "from_env" }, cfgPath, jsonPath }).apiKey).toBe("from_env");
});

test("api url defaults, and a trailing slash is trimmed", () => {
  expect(loadWakaConfig({ env: {}, cfgPath: "/nope", jsonPath: "/nope" }).apiUrl).toBe(DEFAULT_API_URL);

  const cfgPath = writeFile("slash.cfg", "[settings]\napi_url = https://wakapi.example/api/v1///\n");
  expect(loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" }).apiUrl).toBe("https://wakapi.example/api/v1");
});

test("hide_file_names is read from the cfg", () => {
  const cfgPath = writeFile("hide.cfg", "[settings]\napi_key = k\nhide_file_names = true\n");
  expect(loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" }).hideFileNames).toBe(true);

  const off = writeFile("show.cfg", "[settings]\napi_key = k\n");
  expect(loadWakaConfig({ env: {}, cfgPath: off, jsonPath: "/nope" }).hideFileNames).toBe(false);
});

test("missing key is a clean problem, not a throw", () => {
  const cfg = loadWakaConfig({ env: {}, cfgPath: "/nope", jsonPath: "/nope" });
  expect(cfg.apiKey).toBe("");
  expect(configProblem(cfg)).toBe("no API key configured");
});

test("JYL_WAKATIME_DISABLED switches it off", () => {
  const cfgPath = writeFile("on.cfg", "[settings]\napi_key = k\n");
  const cfg = loadWakaConfig({ env: { JYL_WAKATIME_DISABLED: "1" }, cfgPath, jsonPath: "/nope" });
  expect(configProblem(cfg)).toBe("disabled");
});

test("redactKey never shows the middle", () => {
  expect(redactKey("waka_0123456789abcdef")).toBe("waka…cdef");
  expect(redactKey("")).toBe("(unset)");
  expect(redactKey("short")).toBe("…");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test tests/wakatime-cfg.test.js
```

Expected: FAIL — cannot resolve `../src/wakatime/cfg.mjs`.

- [ ] **Step 3: Write the implementation**

Create `src/wakatime/cfg.mjs`:

```js
/**
 * Where to send heartbeats and with what key.
 *
 * Reading `~/.wakatime.cfg` is the whole point, not a convenience: anyone who
 * has ever installed a WakaTime editor plugin already has a key there, and
 * asking for a second copy of a secret is asking for it to rot.
 *
 * `api_url` matters as much as the key — self-hosted wakapi and hakatime are
 * common, and hardcoding wakatime.com locks those users out.
 *
 * Only `[settings]` is parsed, and only four keys out of it. `exclude`,
 * `include`, `proxy` and the rest are wakatime-cli's business; a parser that
 * threw on an unfamiliar line would break on WakaTime's next release.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API_URL = "https://api.wakatime.com/api/v1";
export const WAKA_CFG_FILE = path.join(os.homedir(), ".wakatime.cfg");
export const JSON_CONFIG_FILE = path.join(os.homedir(), ".config", "jyl-wakatime", "config.json");
export const STATE_DIR = path.join(os.homedir(), ".config", "jyl-wakatime");

/** Parse the `[settings]` section of a wakatime.cfg. Never throws. */
export function parseWakaCfg(text) {
  const out = {};
  let inSettings = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inSettings = line.toLowerCase() === "[settings]";
      continue;
    }
    if (!inSettings) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue; // continuation line of a multi-line value: not ours
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function readCfg(file) {
  try {
    return parseWakaCfg(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

const trimUrl = (u) => String(u ?? "").trim().replace(/\/+$/, "");

export function loadWakaConfig({ env = process.env, cfgPath = WAKA_CFG_FILE, jsonPath = JSON_CONFIG_FILE } = {}) {
  const cfg = readCfg(cfgPath);
  const json = readJson(jsonPath);

  let source = null;
  let apiKey = String(env.WAKATIME_API_KEY ?? "").trim();
  if (apiKey) source = "WAKATIME_API_KEY";
  if (!apiKey && cfg.api_key) { apiKey = cfg.api_key.trim(); source = cfgPath; }
  if (!apiKey && json.apiKey) { apiKey = String(json.apiKey).trim(); source = jsonPath; }

  const apiUrl =
    trimUrl(env.WAKATIME_API_URL) || trimUrl(cfg.api_url) || trimUrl(json.apiUrl) || DEFAULT_API_URL;

  return {
    apiKey,
    apiUrl,
    source,
    hideFileNames: String(cfg.hide_file_names ?? json.hideFileNames ?? "").toLowerCase() === "true",
    enabled: env.JYL_WAKATIME_DISABLED === "1" ? false : json.enabled !== false,
  };
}

export function configProblem(cfg) {
  if (!cfg.enabled) return "disabled";
  if (!cfg.apiKey) return "no API key configured";
  try {
    new URL(cfg.apiUrl);
  } catch {
    return `api url is not a URL: ${cfg.apiUrl}`;
  }
  return null;
}

export function redactKey(key) {
  if (!key) return "(unset)";
  return key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
bun test tests/wakatime-cfg.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/wakatime/cfg.mjs tests/wakatime-cfg.test.js
git commit -m "feat(wakatime): resolve api key and url from env, ~/.wakatime.cfg, then json"
```

---

### Task 2: Language and project detection

**Files:**
- Create: `src/wakatime/language.mjs`
- Create: `src/wakatime/project.mjs`
- Test: `tests/wakatime-detect.test.js`

**Interfaces:**
- Produces:
  ```js
  export function languageFor(filePath)   // -> string | null
  export function detectProject(root, state, nowMs, runGit)  // -> { project, branch|null }
  ```
  `detectProject` mutates `state.wakatimeProjects` (its cache) and returns the result.
  `runGit` is injected so tests never fork a real `git`; production passes the default.

- [ ] **Step 1: Write the failing test**

Create `tests/wakatime-detect.test.js`:

```js
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { languageFor } from "../src/wakatime/language.mjs";
import { detectProject } from "../src/wakatime/project.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-waka-detect-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("known extensions map, unknown ones do not", () => {
  expect(languageFor("/a/b/main.go")).toBe("Go");
  expect(languageFor("/a/b/x.ts")).toBe("TypeScript");
  expect(languageFor("/a/b/x.tsx")).toBe("TypeScript");
  expect(languageFor("/a/b/page.astro")).toBe("Astro");
  expect(languageFor("/a/b/x.mjs")).toBe("JavaScript");
  // Unknown: omit the field and let WakaTime's server guess from the entity.
  expect(languageFor("/a/b/thing.zzz")).toBeNull();
  expect(languageFor("/a/b/Makefile")).toBeNull();
});

test("project comes from the directory holding .git, branch from git", () => {
  const repo = path.join(root, "myrepo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });

  const state = {};
  const got = detectProject(path.join(repo, "src", "deep"), state, 1_000, () => "feature/x\n");
  expect(got.project).toBe("myrepo");
  expect(got.branch).toBe("feature/x");
});

test("no .git falls back to the basename and reports no branch", () => {
  const plain = path.join(root, "plainthing");
  fs.mkdirSync(plain, { recursive: true });

  const got = detectProject(plain, {}, 1_000, () => {
    throw new Error("git must not be consulted when there is no .git");
  });
  expect(got.project).toBe("plainthing");
  expect(got.branch).toBeNull();
});

test("git failure is survivable", () => {
  const repo = path.join(root, "brokengit");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const got = detectProject(repo, {}, 1_000, () => {
    throw new Error("git not on PATH");
  });
  expect(got.project).toBe("brokengit");
  expect(got.branch).toBeNull();
});

test("the branch is cached for 60s, then re-read", () => {
  const repo = path.join(root, "cached");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  let calls = 0;
  const git = () => { calls++; return "main\n"; };
  const state = {};

  detectProject(repo, state, 1_000, git);
  detectProject(repo, state, 30_000, git);
  expect(calls).toBe(1);            // inside the window: no second fork

  detectProject(repo, state, 100_000, git);
  expect(calls).toBe(2);            // window expired: re-read
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test tests/wakatime-detect.test.js
```

Expected: FAIL — cannot resolve the two new modules.

- [ ] **Step 3: Write the implementation**

Create `src/wakatime/language.mjs`:

```js
/**
 * Extension -> WakaTime language name.
 *
 * This is measurably coarser than wakatime-cli, which sniffs file content.
 * That is the accepted cost of not shipping a 10MB binary; an unknown
 * extension omits the field entirely and WakaTime's server guesses from the
 * entity, which is better than asserting something wrong.
 */
import path from "node:path";

const TABLE = {
  ".go": "Go",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".astro": "Astro", ".vue": "Vue.js", ".svelte": "Svelte",
  ".py": "Python", ".rb": "Ruby", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++",
  ".cs": "C#", ".swift": "Swift", ".php": "PHP", ".lua": "Lua", ".zig": "Zig",
  ".sh": "Bash", ".bash": "Bash", ".zsh": "Bash", ".fish": "Fish",
  ".sql": "SQL", ".html": "HTML", ".css": "CSS", ".scss": "SASS",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".ini": "INI",
  ".md": "Markdown", ".mdx": "Markdown", ".rst": "reStructuredText", ".tex": "TeX",
  ".dockerfile": "Docker", ".tf": "Terraform", ".proto": "Protocol Buffer",
};

export function languageFor(filePath) {
  if (!filePath) return null;
  return TABLE[path.extname(String(filePath)).toLowerCase()] ?? null;
}
```

Create `src/wakatime/project.mjs`:

```js
/**
 * Which project a workspace root belongs to, and which branch it is on.
 *
 * Both are cached in the shared state file keyed by root. Forking `git` on
 * every run to learn something that changes a few times a day is not worth it,
 * and a branch shown 60 seconds stale is not worth caring about.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BRANCH_TTL_MS = 60_000;

/** Default git runner. Injected in tests so no test ever forks a real git. */
export function gitBranch(dir) {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
}

/** Walk up looking for .git; return the directory holding it, or null. */
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function detectProject(root, state, nowMs, runGit = gitBranch) {
  const cache = (state.wakatimeProjects ??= {});
  const hit = cache[root];
  if (hit && nowMs - hit.at < BRANCH_TTL_MS) return { project: hit.project, branch: hit.branch };

  const repo = findRepoRoot(root);
  const project = path.basename(repo ?? root);
  let branch = null;
  if (repo) {
    try {
      const out = String(runGit(repo)).trim();
      // A detached HEAD prints "HEAD"; that is not a branch name worth sending.
      if (out && out !== "HEAD") branch = out;
    } catch {
      /* git missing, not a repo yet, timed out: no branch, not an error */
    }
  }
  cache[root] = { project, branch, at: nowMs };
  return { project, branch };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
bun test tests/wakatime-detect.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/wakatime/language.mjs src/wakatime/project.mjs tests/wakatime-detect.test.js
git commit -m "feat(wakatime): detect language by extension and project/branch from git"
```

---

### Task 3: The contract fixture, mapping, and throttling

**Files:**
- Create: `tests/fixtures/runend.json`
- Create: `src/wakatime/heartbeats.mjs`
- Test: `tests/wakatime-heartbeats.test.js`

**Interfaces:**
- Consumes: `languageFor` (Task 2), `detectProject` (Task 2).
- Produces:
  ```js
  export const THROTTLE_MS = 120_000;
  export function heartbeatsFrom(payload, { project, branch, hideFileNames })  // -> heartbeat[]
  export function throttle(beats, state, nowMs)  // -> heartbeat[]  (mutates state.wakatimeSeen)
  ```

- [ ] **Step 1: Create the contract fixture**

`tests/fixtures/runend.json` — **copy this byte-for-byte from
`harness/hook/testdata/runend.json`**. Do not retype it; if the two files
differ, the contract has already drifted.

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
  "usage": {
    "input_tokens": 12043,
    "output_tokens": 887,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 11800
  },
  "tools": [
    { "name": "read_file", "path": "/abs/agent/agent.go", "at": 1757650003.2, "elapsed_ms": 8, "is_error": false },
    { "name": "edit_file", "path": "/abs/agent/agent.go", "at": 1757650031.7, "elapsed_ms": 12, "is_error": false },
    { "name": "bash", "at": 1757650038.0, "elapsed_ms": 2400, "is_error": false }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/wakatime-heartbeats.test.js`:

```js
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { THROTTLE_MS, heartbeatsFrom, throttle } from "../src/wakatime/heartbeats.mjs";

const payload = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/runend.json"), "utf8"));
const opts = { project: "harness", branch: "main", hideFileNames: false };

test("the fixture parses into the fields the mapper needs", () => {
  // This is the cross-repo contract assertion: a rename on harness's side
  // shows up here as a red test rather than as missing data.
  expect(payload.event).toBe("RunEnd");
  expect(payload.tools).toHaveLength(3);
  expect(payload.tools[0].path).toBe("/abs/agent/agent.go");
  expect(payload.tools[2].path).toBeUndefined(); // bash has no entity
  expect(payload.usage.cache_read_input_tokens).toBe(11800);
  expect(payload.prompt_chars).toBe(214);
});

test("three tool calls become two file heartbeats plus one run heartbeat", () => {
  const beats = heartbeatsFrom(payload, opts);
  expect(beats).toHaveLength(3);

  const files = beats.filter((b) => b.type === "file");
  const runs = beats.filter((b) => b.type === "app");
  expect(files).toHaveLength(2);
  expect(runs).toHaveLength(1);

  expect(files[0]).toMatchObject({
    entity: "/abs/agent/agent.go",
    type: "file",
    time: 1757650003.2,
    category: "ai coding",
    is_write: false,
    project: "harness",
    branch: "main",
    language: "Go",
  });
  expect(files[1].is_write).toBe(true); // edit_file
});

test("token fields ride only on the run heartbeat", () => {
  const beats = heartbeatsFrom(payload, opts);
  const run = beats.find((b) => b.type === "app");
  const file = beats.find((b) => b.type === "file");

  expect(run.entity).toBe("harness");
  expect(run.ai_session).toBe("3f9a1c7e2b4d5068");
  expect(run.ai_prompt_length).toBe(214);
  expect(run.ai_output_tokens).toBe(887);
  // All three input counters summed: cache reads are tokens the model
  // processed and the subscription paid for.
  expect(run.ai_input_tokens).toBe(12043 + 11800 + 0);

  // A run that edits five files must not report its tokens five times.
  expect(file.ai_input_tokens).toBeUndefined();
  expect(file.ai_session).toBeUndefined();
});

test("a run that touched no file still produces the run heartbeat", () => {
  const bashOnly = { ...payload, tools: [{ name: "bash", at: 1757650038.0, elapsed_ms: 2400, is_error: false }] };
  const beats = heartbeatsFrom(bashOnly, opts);
  expect(beats).toHaveLength(1);
  expect(beats[0].type).toBe("app");
});

test("hide_file_names obfuscates the entity but keeps the project", () => {
  const beats = heartbeatsFrom(payload, { ...opts, hideFileNames: true });
  const file = beats.find((b) => b.type === "file");
  expect(file.entity).not.toContain("agent.go");
  expect(file.project).toBe("harness");
});

test("an unknown extension omits language rather than guessing", () => {
  const odd = { ...payload, tools: [{ name: "read_file", path: "/a/b/thing.zzz", at: 1, elapsed_ms: 1, is_error: false }] };
  const file = heartbeatsFrom(odd, opts).find((b) => b.type === "file");
  expect("language" in file).toBe(false);
});

test("the same file inside 120s is sent once; a write always goes", () => {
  const state = {};
  const read = (t) => ({ entity: "/a.go", type: "file", time: t, is_write: false });
  const write = (t) => ({ entity: "/a.go", type: "file", time: t, is_write: true });

  expect(throttle([read(1)], state, 0)).toHaveLength(1);
  expect(throttle([read(2)], state, 30_000)).toHaveLength(0);       // inside the window
  expect(throttle([write(3)], state, 40_000)).toHaveLength(1);      // writes are never throttled
  expect(throttle([read(4)], state, THROTTLE_MS + 1_000)).toHaveLength(1); // window expired
});

test("entities unseen for over a day are pruned from state", () => {
  const state = {};
  throttle([{ entity: "/old.go", type: "file", time: 1, is_write: false }], state, 0);
  expect(Object.keys(state.wakatimeSeen)).toContain("/old.go");

  throttle([{ entity: "/new.go", type: "file", time: 2, is_write: false }], state, 25 * 3600 * 1000);
  expect(Object.keys(state.wakatimeSeen)).not.toContain("/old.go");
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
bun test tests/wakatime-heartbeats.test.js
```

Expected: FAIL — cannot resolve `../src/wakatime/heartbeats.mjs`.

- [ ] **Step 4: Write the implementation**

Create `src/wakatime/heartbeats.mjs`:

```js
/**
 * harness's RunEnd payload -> WakaTime heartbeats.
 *
 * Two kinds come out of one payload:
 *
 *   - one `file` heartbeat per tool call that carries a path;
 *   - exactly one `app` heartbeat for the run itself, which is where the
 *     token fields ride.
 *
 * Keeping the tokens on the run heartbeat is not tidiness: a run that edits
 * five files would otherwise report the same tokens five times. The run
 * heartbeat also covers the run where the agent did nothing but `bash` —
 * work happened, and the time should not be zero because no file was named.
 */
import { languageFor } from "./language.mjs";

export const THROTTLE_MS = 120_000;
const SEEN_TTL_MS = 24 * 3600 * 1000;
const CATEGORY = "ai coding";

/** Tools that mean "this file was written", per WakaTime's is_write. */
const WRITE_TOOLS = new Set(["edit_file", "write_file"]);

/**
 * WakaTime's own convention for hidden names: keep the extension so language
 * stats survive, drop everything identifying.
 */
const obfuscate = (p) => {
  const dot = p.lastIndexOf(".");
  return dot > 0 ? `HIDDEN${p.slice(dot)}` : "HIDDEN";
};

export function heartbeatsFrom(payload, { project, branch, hideFileNames } = {}) {
  const beats = [];

  for (const call of Array.isArray(payload.tools) ? payload.tools : []) {
    // No path means no entity. bash, glob, grep and every MCP tool land here;
    // inventing an entity for them would be a lie.
    if (typeof call.path !== "string" || !call.path) continue;

    const beat = {
      entity: hideFileNames ? obfuscate(call.path) : call.path,
      type: "file",
      time: call.at,
      category: CATEGORY,
      is_write: WRITE_TOOLS.has(call.name),
    };
    if (project) beat.project = project;
    if (branch) beat.branch = branch;
    const lang = languageFor(call.path);
    if (lang) beat.language = lang;
    beats.push(beat);
  }

  const usage = payload.usage ?? {};
  const run = {
    entity: "harness",
    type: "app",
    time: payload.ended_at,
    category: CATEGORY,
    ai_session: payload.session_id,
    // All three input counters. Cache reads are tokens the model processed and
    // the subscription paid for; WakaTime has no field to split them out.
    ai_input_tokens:
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    ai_output_tokens: usage.output_tokens ?? 0,
    ai_prompt_length: payload.prompt_chars ?? 0,
  };
  if (project) run.project = project;
  beats.push(run);

  return beats;
}

/**
 * WakaTime's rule for editor plugins: skip a heartbeat if the same file went
 * out within 120 seconds, unless it is a write.
 *
 * The last-sent time per entity lives in the shared state file. It is not in
 * `store`'s `seen` file — that is a set of keys and cannot carry a timestamp.
 */
export function throttle(beats, state, nowMs) {
  const seen = (state.wakatimeSeen ??= {});
  const out = [];

  for (const beat of beats) {
    const last = seen[beat.entity];
    if (!beat.is_write && typeof last === "number" && nowMs - last < THROTTLE_MS) continue;
    seen[beat.entity] = nowMs;
    out.push(beat);
  }

  // Prune on write so the state file cannot grow without bound.
  for (const [entity, at] of Object.entries(seen)) {
    if (nowMs - at > SEEN_TTL_MS) delete seen[entity];
  }
  return out;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
bun test tests/wakatime-heartbeats.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/runend.json src/wakatime/heartbeats.mjs tests/wakatime-heartbeats.test.js
git commit -m "feat(wakatime): map RunEnd payloads to heartbeats, with WakaTime's 120s throttle"
```

---

### Task 4: Sending

**Files:**
- Create: `src/wakatime/send.mjs`
- Test: `tests/wakatime-send.test.js`

**Interfaces:**
- Produces:
  ```js
  export const BATCH_SIZE = 25;
  export function userAgent({ harnessVersion, pluginVersion, platform, release, arch })  // -> string
  export function authHeader(apiKey)   // -> "Basic <base64>"
  export async function sendAll(ctx, beats)  // -> { tally, failed, authFailed }
  ```
  `ctx` is `{ apiUrl, apiKey, ua, log, fetch }` — `fetch` injected so tests never touch the network.

- [ ] **Step 1: Write the failing test**

Create `tests/wakatime-send.test.js`:

```js
import { expect, test } from "bun:test";
import { BATCH_SIZE, authHeader, sendAll, userAgent } from "../src/wakatime/send.mjs";

const beat = (i) => ({ entity: `/f${i}.go`, type: "file", time: i, category: "ai coding" });
const beats = (n) => Array.from({ length: n }, (_, i) => beat(i));

function ctxWith(responder) {
  const calls = [];
  return {
    calls,
    ctx: {
      apiUrl: "https://api.wakatime.com/api/v1",
      apiKey: "waka_secret",
      ua: "wakatime/1.0.0 (darwin) harness/27.0.17 harness-wakatime/0.1.0",
      log: () => {},
      fetch: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return responder(calls.length);
      },
    },
  };
}

const ok = () => new Response(JSON.stringify({ responses: [] }), { status: 201 });

test("the key goes in the header, never in the url", async () => {
  const { ctx, calls } = ctxWith(ok);
  await sendAll(ctx, beats(1));

  expect(calls[0].url).toBe("https://api.wakatime.com/api/v1/users/current/heartbeats.bulk");
  expect(calls[0].url).not.toContain("waka_secret");
  expect(calls[0].init.headers.Authorization).toBe(authHeader("waka_secret"));
  expect(calls[0].init.headers.Authorization.startsWith("Basic ")).toBe(true);
  expect(calls[0].init.headers["User-Agent"]).toContain("harness-wakatime/");
});

test("60 heartbeats go out as 25 / 25 / 10", async () => {
  const { ctx, calls } = ctxWith(ok);
  const res = await sendAll(ctx, beats(60));

  expect(calls.map((c) => c.body.length)).toEqual([25, 25, 10]);
  expect(BATCH_SIZE).toBe(25);
  expect(res.tally.sent).toBe(60);
  expect(res.failed).toHaveLength(0);
});

test("network trouble and 5xx go back to the spool", async () => {
  for (const responder of [
    () => { throw new Error("ECONNREFUSED"); },
    () => new Response("boom", { status: 500 }),
  ]) {
    const { ctx } = ctxWith(responder);
    const res = await sendAll(ctx, beats(3));
    expect(res.failed).toHaveLength(3);
  }
});

test("429 spools and stops sending further batches this run", async () => {
  const { ctx, calls } = ctxWith(() => new Response("slow down", { status: 429 }));
  const res = await sendAll(ctx, beats(60));

  expect(calls).toHaveLength(1);          // gave up after the first 429
  expect(res.failed).toHaveLength(60);    // including the batches never attempted
});

test("401 spools and is reported as an auth failure", async () => {
  const { ctx } = ctxWith(() => new Response("bad key", { status: 401 }));
  const res = await sendAll(ctx, beats(2));

  expect(res.failed).toHaveLength(2);
  expect(res.authFailed).toBe(true);
});

test("400 drops the batch — the same bytes will never be accepted", async () => {
  const { ctx } = ctxWith(() => new Response("malformed", { status: 400 }));
  const res = await sendAll(ctx, beats(2));

  expect(res.failed).toHaveLength(0);
  expect(res.tally.rejected).toBe(2);
});

test("the user agent names the editor, its version and the plugin", () => {
  const ua = userAgent({
    harnessVersion: "27.0.17", pluginVersion: "0.1.0",
    platform: "darwin", release: "27.0.0", arch: "arm64",
  });
  expect(ua).toBe("wakatime/1.0.0 (darwin-27.0.0-arm64) harness/27.0.17 harness-wakatime/0.1.0");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test tests/wakatime-send.test.js
```

Expected: FAIL — cannot resolve `../src/wakatime/send.mjs`.

- [ ] **Step 3: Write the implementation**

Create `src/wakatime/send.mjs`:

```js
/**
 * POST heartbeats to WakaTime.
 *
 * This is not `src/core/upload.mjs`. That one is written for llm-web's ingest
 * route and bound to it — 500 per batch, the `invalid_source` code, the
 * accepted/duplicates/rejected body. What is copied from it is the part worth
 * keeping: classify every failure by whether *the same bytes* could ever
 * succeed, return `{tally, failed}`, and let the caller own the spool. Writing
 * the spool in here would mean two functions deciding what is still owed.
 */

/** WakaTime's documented cap for the bulk endpoint. */
export const BATCH_SIZE = 25;
/** A hook that hangs is worse than activity reported a run late. */
const REQUEST_TIMEOUT_MS = 10_000;

export function authHeader(apiKey) {
  return `Basic ${Buffer.from(apiKey).toString("base64")}`;
}

/**
 * WakaTime detects editor and OS by parsing this. The shape mirrors what
 * wakatime-cli sends.
 *
 * **Whether the dashboard recognises `harness` as an editor is unverified** —
 * see Task 8, which sends one real heartbeat and reads the User Agents
 * endpoint back.
 */
export function userAgent({ harnessVersion, pluginVersion, platform, release, arch }) {
  return `wakatime/1.0.0 (${platform}-${release}-${arch}) harness/${harnessVersion} harness-wakatime/${pluginVersion}`;
}

async function postBatch(ctx, batch) {
  const url = `${ctx.apiUrl}/users/current/heartbeats.bulk`;
  const doFetch = ctx.fetch ?? fetch;

  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(ctx.apiKey),
        "User-Agent": ctx.ua,
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { retry: true, message: String(err?.message ?? err) };
  }

  if (res.ok) return { ok: true };

  const text = await res.text().catch(() => "");
  // 401/403 retries for the same reason upload.mjs spools them: a revoked or
  // mistyped key is a configuration problem someone will fix, and the hours
  // behind it are worth keeping. The spool cap is what stops it growing
  // forever, and `authFailed` is what --status shouts about.
  if (res.status === 401 || res.status === 403) {
    return { retry: true, auth: true, status: res.status, message: text };
  }
  if (res.status === 429 || res.status >= 500) {
    return { retry: true, rateLimited: res.status === 429, status: res.status, message: text };
  }
  return { retry: false, status: res.status, message: text };
}

export async function sendAll(ctx, beats) {
  const tally = { sent: 0, accepted: 0, rejected: 0 };
  const failed = [];
  let authFailed = false;

  for (let i = 0; i < beats.length; i += BATCH_SIZE) {
    const batch = beats.slice(i, i + BATCH_SIZE);
    const result = await postBatch(ctx, batch);
    tally.sent += batch.length;

    if (result.ok) {
      tally.accepted += batch.length;
      continue;
    }
    if (!result.retry) {
      tally.rejected += batch.length;
      ctx.log(`wakatime rejected ${batch.length} heartbeat(s), dropping: ${result.status} ${result.message}`);
      continue;
    }

    failed.push(...batch);
    if (result.auth) authFailed = true;
    ctx.log(`wakatime send failed (will retry): ${result.status ?? "network"} ${result.message}`);

    // A 429 means the whole run should stop, not just this batch — WakaTime
    // allows under 10 req/s averaged over five minutes, and hammering it with
    // the remaining batches is how a soft limit becomes a hard one.
    if (result.rateLimited) {
      failed.push(...beats.slice(i + BATCH_SIZE));
      break;
    }
  }

  return { tally, failed, authFailed };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
bun test tests/wakatime-send.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/wakatime/send.mjs tests/wakatime-send.test.js
git commit -m "feat(wakatime): POST heartbeats.bulk in batches of 25, classify every failure"
```

---

### Task 5: Entry point and launcher

**Files:**
- Create: `src/wakatime/main.mjs`
- Create: `scripts/wakatime` (mode 0755)
- Test: `tests/wakatime-main.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–4, plus `createStore` from `src/core/store.mjs`.
- Produces:
  ```js
  export function parseArgs(argv)      // -> { command }
  export async function runHook(deps)  // -> void, never throws
  export function renderStatus(deps)   // -> string
  export async function main(argv, stdinText)  // -> exit code, always 0
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/wakatime-main.test.js`:

```js
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/core/store.mjs";
import { main, parseArgs, renderStatus, runHook } from "../src/wakatime/main.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-waka-main-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const fixture = fs.readFileSync(path.join(import.meta.dir, "fixtures/runend.json"), "utf8");
const freshStore = (name) => createStore(path.join(root, name));

test("parseArgs defaults to the hook path", () => {
  expect(parseArgs([]).command).toBe("--hook");
  expect(parseArgs(["--status"]).command).toBe("--status");
  expect(parseArgs(["--flush"]).command).toBe("--flush");
  expect(parseArgs(["--detach"]).command).toBe("--hook"); // handled by the launcher
});

test("a good payload turns into heartbeats and goes out", async () => {
  const store = freshStore("happy");
  const sent = [];
  await runHook({
    store,
    stdinText: fixture,
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", hideFileNames: false, enabled: true },
    now: 1_000,
    send: async (_ctx, beats) => { sent.push(...beats); return { tally: { sent: beats.length }, failed: [], authFailed: false }; },
  });

  expect(sent).toHaveLength(3);
  expect(store.readSpool()).toHaveLength(0);
});

test("what could not be delivered lands in the spool and goes again next run", async () => {
  const store = freshStore("spooling");
  let attempt = 0;
  const send = async (_ctx, beats) => {
    attempt++;
    return attempt === 1
      ? { tally: { sent: beats.length }, failed: beats, authFailed: false }
      : { tally: { sent: beats.length }, failed: [], authFailed: false };
  };

  await runHook({ store, stdinText: fixture, cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true }, now: 1_000, send });
  expect(store.readSpool()).toHaveLength(3);

  // Second run: nothing new on stdin, but the spool drains.
  await runHook({ store, stdinText: "", cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true }, now: 500_000, send });
  expect(store.readSpool()).toHaveLength(0);
});

test("a payload for another event is ignored, not an error", async () => {
  const store = freshStore("otherevent");
  let called = false;
  await runHook({
    store,
    stdinText: JSON.stringify({ event: "PostToolUse", tools: [] }),
    cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
    now: 1_000,
    send: async () => { called = true; return { tally: {}, failed: [], authFailed: false }; },
  });
  expect(called).toBe(false);
});

test("garbage on stdin is survivable", async () => {
  const store = freshStore("garbage");
  await expect(
    runHook({
      store, stdinText: "}{not json", now: 1_000,
      cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
      send: async () => { throw new Error("must not be reached"); },
    }),
  ).resolves.toBeUndefined();
});

test("no key configured: nothing is sent, nothing throws", async () => {
  const store = freshStore("nokey");
  await runHook({
    store, stdinText: fixture, now: 1_000,
    cfg: { apiKey: "", apiUrl: "https://x/api/v1", enabled: true },
    send: async () => { throw new Error("must not be reached"); },
  });
  expect(store.readSpool()).toHaveLength(0);
});

test("--status shows the url, a redacted key, the spool and auth failures", () => {
  const store = freshStore("status");
  store.writeSpool([{ entity: "/a.go" }, { entity: "/b.go" }]);
  store.saveState({ version: 2, files: {}, wakatimeAuthFailures: 3 });

  const out = renderStatus({
    store,
    cfg: { apiKey: "waka_0123456789abcdef", apiUrl: "https://wakapi.example/api/v1", enabled: true, source: "~/.wakatime.cfg" },
  });

  expect(out).toContain("https://wakapi.example/api/v1");
  expect(out).toContain("waka…cdef");
  expect(out).not.toContain("0123456789");   // the middle of the key never shows
  expect(out).toContain("2 heartbeat(s)");
  expect(out).toContain("3");                 // the auth-failure count
});

test("main always returns 0", async () => {
  expect(await main(["--status"], "")).toBe(0);
  expect(await main([], "}{ not json")).toBe(0);
  expect(await main(["--nonsense"], "")).toBe(0);
});

// This is store.writeSpool's behaviour, not ours — asserted here because
// jyl-wakatime relies on it as its only defence against a permanently wrong
// key growing the spool forever. A silent cap would read as "everything was
// sent", which is why the drop is logged.
test("the spool is capped at 5000, oldest dropped, and the drop is logged", () => {
  const store = freshStore("cap");
  store.writeSpool(Array.from({ length: 5001 }, (_, i) => ({ entity: `/f${i}.go` })));

  const kept = store.readSpool();
  expect(kept).toHaveLength(5000);
  expect(kept[0].entity).toBe("/f1.go");                    // /f0.go was the oldest
  expect(kept.at(-1).entity).toBe("/f5000.go");
  expect(fs.readFileSync(store.logFile, "utf8")).toContain("spool overflow");
});

test("an unwritable state dir does not throw", async () => {
  // A directory where a file must go: every write inside runHook fails.
  const blocked = path.join(root, "blocked");
  fs.mkdirSync(path.join(blocked, "spool.jsonl"), { recursive: true });

  await expect(
    runHook({
      store: createStore(blocked),
      stdinText: fixture,
      cfg: { apiKey: "k", apiUrl: "https://x/api/v1", enabled: true },
      now: 1_000,
      send: async (_c, beats) => ({ tally: { sent: beats.length }, failed: beats, authFailed: false }),
    }),
  ).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test tests/wakatime-main.test.js
```

Expected: FAIL — cannot resolve `../src/wakatime/main.mjs`.

- [ ] **Step 3: Write the implementation**

Create `src/wakatime/main.mjs`. Key points, all of them load-bearing:

- `runHook` takes every collaborator as a parameter (`store`, `cfg`, `send`,
  `now`, `stdinText`) so the tests above never touch the network, the clock,
  or the real home directory. `main` is the only place that assembles the real ones.
- **The throttle state and the project cache live in `store.loadState()`.**
  That state object is `{version, files, …}`; `store.loadState` returns it
  untouched when the version matches, so extra keys survive. **This is a
  deliberate dependency on `store`'s current behaviour** — if `jyl-usage` ever
  bumps `STATE_VERSION`, our throttle table resets, and the cost is one extra
  batch of heartbeats. Acceptable, and written down here so it is not a surprise.
- **Everything runs inside `store.withLock`**, because several harness sessions
  can end a run at the same moment and they share one spool.

```js
/**
 * jyl-wakatime — harness's RunEnd hook -> WakaTime heartbeats.
 *
 * **This tool sends file paths and project names off the machine.** That is
 * what it is for, and it is why it is a separate tool from jyl-usage rather
 * than a second sink inside it. It never sends prompts, completions, tool
 * arguments or tool results: harness's payload does not contain them.
 */
import os from "node:os";
import { createStore } from "../core/store.mjs";
import { JSON_CONFIG_FILE, STATE_DIR, configProblem, loadWakaConfig, redactKey } from "./cfg.mjs";
import { heartbeatsFrom, throttle } from "./heartbeats.mjs";
import { detectProject } from "./project.mjs";
import { sendAll, userAgent } from "./send.mjs";

export const VERSION = "0.1.0";
const EVENT = "RunEnd";

export function parseArgs(argv) {
  const out = { command: "--hook" };
  for (const arg of argv) {
    if (arg === "--detach") continue;              // the launcher handles it
    if (arg.startsWith("--")) out.command = arg;
  }
  return out;
}

/**
 * One hook invocation: parse stdin, map, throttle, send, spool the remainder.
 *
 * Never throws. A broken reporter must not make a harness run go red.
 */
export async function runHook({ store, stdinText, cfg, now, send = sendAll, harnessVersion = "unknown" }) {
  try {
    if (configProblem(cfg)) {
      store.log(`not reporting: ${configProblem(cfg)}`);
      return;
    }

    let payload = null;
    if (stdinText && stdinText.trim()) {
      try {
        payload = JSON.parse(stdinText);
      } catch (err) {
        store.log(`stdin was not JSON: ${err.message}`);
        return;
      }
      // Forward compatibility: a harness that grows more events must not make
      // this tool log an error on every one of them.
      if (payload.event !== EVENT) {
        store.log(`ignoring event ${payload.event}`);
        return;
      }
    }

    await store.withLock(async () => {
      const state = store.loadState();
      let fresh = [];

      if (payload) {
        const { project, branch } = detectProject(payload.workspace_root ?? "", state, now);
        fresh = throttle(
          heartbeatsFrom(payload, { project, branch, hideFileNames: cfg.hideFileNames }),
          state,
          now,
        );
      }

      const queued = [...store.readSpool(), ...fresh];
      if (queued.length === 0) {
        store.saveState(state);
        return;
      }

      const ctx = {
        apiUrl: cfg.apiUrl,
        apiKey: cfg.apiKey,
        ua: userAgent({
          harnessVersion: payload?.harness_version ?? harnessVersion,
          pluginVersion: VERSION,
          platform: process.platform,
          release: os.release(),
          arch: process.arch,
        }),
        log: store.log,
      };

      const { tally, failed, authFailed } = await send(ctx, queued);
      store.writeSpool(failed);
      state.wakatimeAuthFailures = authFailed ? (state.wakatimeAuthFailures ?? 0) + 1 : 0;
      state.wakatimeLastSend = { at: now, sent: tally.sent ?? 0, failed: failed.length };
      store.saveState(state);
    });
  } catch (err) {
    // The outermost net. Anything that got here is a bug, but the hook still
    // has to come back clean.
    try {
      store.log(`unexpected failure: ${err?.stack ?? err}`);
    } catch {
      /* logging must never be the thing that breaks a hook */
    }
  }
}

export function renderStatus({ store, cfg }) {
  const state = store.loadState();
  const spool = store.readSpool();
  const last = state.wakatimeLastSend;
  return [
    `jyl-wakatime ${VERSION}`,
    `  api url     ${cfg.apiUrl}`,
    `  api key     ${redactKey(cfg.apiKey)}   (from ${cfg.source ?? "nowhere"})`,
    `  spool       ${spool.length} heartbeat(s)`,
    `  last send   ${last ? `${new Date(last.at).toISOString()}  sent ${last.sent}, failed ${last.failed}` : "never"}`,
    `  auth fails  ${state.wakatimeAuthFailures ?? 0}`,
    configProblem(cfg) ? `  PROBLEM     ${configProblem(cfg)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function main(argv, stdinText) {
  const { command } = parseArgs(argv);
  const cfg = loadWakaConfig({});
  const store = createStore(STATE_DIR);

  if (command === "--status") {
    process.stdout.write(renderStatus({ store, cfg }) + "\n");
    return 0;
  }
  // --flush is --hook with nothing on stdin: it drains whatever is spooled.
  await runHook({ store, stdinText: command === "--flush" ? "" : stdinText, cfg, now: Date.now() });
  return 0;
}
```

The module ends with the real entry, guarded so tests can import it freely:

```js
if (import.meta.main ?? process.argv[1]?.endsWith("main.mjs")) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  process.exit(await main(process.argv.slice(2), Buffer.concat(chunks).toString("utf8")));
}
```

`JSON_CONFIG_FILE` is imported for the `--status` line that names where the key
came from; if the final code does not use it, drop it from the import rather
than leaving it unused.

- [ ] **Step 4: Create the launcher**

Create `scripts/wakatime`, then `chmod +x scripts/wakatime`:

```sh
#!/usr/bin/env sh
# Launcher for the WakaTime reporter.
#
# Deliberately a second launcher rather than a flag on scripts/run: jyl-usage
# sends counts only, this one sends file paths. Two privacy postures sharing
# one entry point is how a shared config path and an accidental cross-import
# get introduced later.
#
# Never exits non-zero. This is bookkeeping; a harness run must not go red
# because a reporter could not find a runtime.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENTRY="$ROOT/src/wakatime/main.mjs"

# A project-level NODE_OPTIONS is meant for that project's code, not for a
# hook it knows nothing about.
if [ -n "${NODE_OPTIONS:-}" ]; then
  unset NODE_OPTIONS
fi

DETACH=0
ARGS=""
for arg in "$@"; do
  if [ "$arg" = "--detach" ]; then
    DETACH=1
  else
    ARGS="$ARGS $arg"
  fi
done

if [ "$DETACH" = "1" ]; then
  # The payload is read here because the child cannot: this process owns stdin.
  PAYLOAD=$(cat 2>/dev/null || true)
  # $ARGS is intentionally unquoted so it re-splits on whitespace. Safe because
  # the only caller is harness's [[hooks]] args, which carry no paths.
  # shellcheck disable=SC2086
  ( printf '%s' "$PAYLOAD" | "$0" $ARGS >/dev/null 2>&1 & ) </dev/null >/dev/null 2>&1
  exit 0
fi

if [ -n "${JYL_WAKATIME_RUNTIME:-}" ] && [ -x "${JYL_WAKATIME_RUNTIME}" ]; then
  exec "${JYL_WAKATIME_RUNTIME}" "$ENTRY" "$@"
fi

if command -v bun >/dev/null 2>&1; then
  exec bun "$ENTRY" "$@"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$ENTRY" "$@"
fi

echo "jyl-wakatime: no bun or node on PATH; not reporting. Set JYL_WAKATIME_RUNTIME to an absolute path to override." >&2
exit 0
```

**Note the one difference from `scripts/run`:** it does not print `{}`. That is
Claude Code's and `agy`'s hook output contract; harness discards hook stdout
entirely.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
bun test tests/wakatime-main.test.js
bun test                                  # the whole suite, jyl-usage included
```

Expected: PASS. **The existing `jyl-usage` tests must be untouched and green.**

- [ ] **Step 6: Verify the launcher by hand**

```bash
./scripts/wakatime --status
echo '}{ garbage' | ./scripts/wakatime ; echo "exit=$?"
cat tests/fixtures/runend.json | ./scripts/wakatime --detach ; echo "exit=$?"
```

Expected: a status block, then `exit=0` twice. With no key configured nothing
is sent; check `~/.config/jyl-wakatime/log` for the "not reporting" line.

- [ ] **Step 7: Commit**

```bash
git add src/wakatime/main.mjs scripts/wakatime tests/wakatime-main.test.js
git commit -m "feat(wakatime): entry point and launcher, exit 0 on every path"
```

---

### Task 6: README and versions

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-12-wakatime-reporter-design.md` (status line only)

- [ ] **Step 1: Restructure the README's opening**

The README currently opens as "one repository, one reporter, two hosts". It is
now **two tools**. The opening has to say so, and `jyl-usage`'s "Only counts
leave the machine" promise must stay attached to `jyl-usage` and not drift into
covering the whole repo.

Add a `## jyl-wakatime` section carrying, in this order:

1. What it does, in one sentence.
2. **The privacy statement, above the install instructions, not in a footnote:**
   it sends absolute file paths, project name, git branch, language, token
   counts, prompt length in characters, model id, and a per-run session id.
   It never sends prompts, completions, file contents, tool arguments,
   command lines or tool results.
3. Install: what to paste into harness's `config.toml`.

   ```toml
   [[hooks]]
   event   = "RunEnd"
   command = "/absolute/path/to/harness-plugin/scripts/wakatime"
   args    = ["--detach"]
   ```

4. Config: the key/url resolution chain, and that `~/.wakatime.cfg` is read
   first so an existing WakaTime user needs no second copy of their key.
   Mention self-hosted wakapi/hakatime via `api_url`.
5. `hide_file_names` is honoured.
6. `./scripts/wakatime --status` is the only way to notice it is broken,
   because it never fails loudly by design.
7. **There is no `--backfill`.** Unlike `jyl-usage` there is no local record to
   rescan; a lost payload is gone. Say so, so nobody looks for the flag.
8. The payload is a cross-repo contract with `JianyueLab/harness`; changing it
   means changing both repos, and `tests/fixtures/runend.json` must stay
   byte-identical to `harness/hook/testdata/runend.json`.

- [ ] **Step 2: Check the two fixtures really are identical**

```bash
diff -u ../harness/hook/testdata/runend.json tests/fixtures/runend.json && echo "fixtures identical"
```

Expected: no output from `diff`, then the confirmation line. **If they differ,
stop and reconcile before going further** — this is the drift the whole
fixture arrangement exists to catch.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-12-wakatime-reporter-design.md
git commit -m "docs: document jyl-wakatime, its privacy posture and its lack of backfill"
```

---

### Task 7: Reconcile the workspace submodule path

**Files:**
- Modify: the workspace root repo's `.gitmodules` (**a different repo** — `ssh://git@git.jyl.as/jhl-hk/JianyueLab.git`)

This is a blocker for committing any pin, not a code change. The workspace root
records `path = claude-plugin`; the working copy is at `harness-plugin/`.

- [ ] **Step 1: Decide which name is right**

Ask before acting. The repo's origin is still `JianyueLab/claude-plugin.git`
and its plugin manifests still say `jyl-usage`, so the two candidates are:

- rename the working copy back to `claude-plugin/` (nothing else changes), or
- keep `harness-plugin/` and update the root's `.gitmodules` path plus
  `git mv` the gitlink.

- [ ] **Step 2: Apply the decision in the root repo, and verify**

```bash
git -C /Users/jhl/Documents/Dev/JianyueLab submodule status | grep -E "claude-plugin|harness-plugin"
git -C /Users/jhl/Documents/Dev/JianyueLab status --short
```

Expected: the submodule resolves, and the root shows a moved pin rather than a
deleted submodule.

---

### Task 8: End-to-end verification against the real service

**Prerequisites:** harness's plan is done and installed; a real WakaTime (or
wakapi) API key is in `~/.wakatime.cfg`.

Everything before this task is verified against fixtures. **These two questions
cannot be answered from documentation** and the spec says so explicitly.

- [ ] **Step 1: Wire it up for real**

Put the `[[hooks]]` block from Task 6 into harness's `config.toml`, start
harness, and have it edit one file.

- [ ] **Step 2: Confirm it left the machine**

```bash
./scripts/wakatime --status
tail -20 ~/.config/jyl-wakatime/log
```

Expected: spool 0, a `last send` within the last minute.

- [ ] **Step 3: Verify the editor is attributed correctly**

```bash
curl -s -H "Authorization: $(printf 'Basic %s' "$(printf '%s' "$WAKATIME_API_KEY" | base64)")" \
  https://wakatime.com/api/v1/users/current/user_agents | python3 -m json.tool
```

Expected: an entry at the top of the list whose `editor`, `version` and `os`
are detected correctly. **If `harness` is not recognised**, the fallbacks in
priority order are: (a) adopt an editor name WakaTime already knows,
(b) ask WakaTime to register `harness`. Record which one was taken and why.

- [ ] **Step 4: Verify the `app` heartbeat renders sensibly**

Open the WakaTime dashboard and look at how `entity: "harness"` with
`type: "app"` appears beside the file entities.

**If it looks wrong**, the documented alternative is to attach the token fields
to the run's last file heartbeat and emit the app heartbeat only for runs that
touched no file. That is a change to `heartbeatsFrom` and its tests, nothing else.

- [ ] **Step 5: Confirm nothing sensitive went out**

```bash
grep -riE "new_string|old_string|tool_result|password|api[_-]?key" ~/.config/jyl-wakatime/log || echo "log is clean"
```

Then read one real payload as harness sends it (harness's plan Task 7 Step 5
writes one to `~/.harness-hook-last.json`) and confirm by eye that no prompt,
completion, command line or file content appears in any field.

- [ ] **Step 6: Record the findings**

Append a short "verified against the real service" section to the spec: what
the User Agents endpoint reported, how the app heartbeat looked, and anything
that had to change. **Findings only — do not claim anything that was not
actually observed.**

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-12-wakatime-reporter-design.md
git commit -m "docs: record what the real WakaTime service actually did"
```

---

## Wrap-up checklist

- [ ] `bun test` fully green, including every pre-existing `jyl-usage` test
- [ ] `diff` between the two `runend.json` fixtures is empty
- [ ] `./scripts/wakatime --status` readable, key redacted
- [ ] Exit code 0 verified for: no runtime, bad stdin, no key, unwritable state dir
- [ ] `jyl-usage` untouched — `git diff --stat main` shows no change under
      `src/core/{config,upload,report}.mjs`, `src/hosts/`, `src/reporter.mjs`,
      `hooks.json`, `plugin.json`, `.claude-plugin/`
- [ ] README states the privacy posture **above** the install instructions
- [ ] Editor attribution question answered with real evidence (Task 8 Step 3)
- [ ] Workspace `.gitmodules` reconciled before any pin is pushed
