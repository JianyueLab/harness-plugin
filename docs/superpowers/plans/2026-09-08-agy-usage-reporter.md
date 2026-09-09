# Antigravity CLI usage reporter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report the token counts the Antigravity CLI (`agy`) spends to `llm-web`'s `/v1/usage/ingest`, from the same repository and the same shared machinery that already does it for Claude Code.

**Architecture:** The existing 817-line `src/reporter.mjs` splits into a host-agnostic core (config, per-host store, upload, the reporting pass) and two host adapters that differ only in where the bytes are and how they parse. Claude Code reads appended JSONL; Antigravity reads new rows out of a per-conversation SQLite database and walks an undocumented protobuf blob for the counts. Both manifests — Claude Code's and `agy`'s — sit at the repository root so one checkout is one installable plugin for either host.

**Tech Stack:** Plain ESM on node/bun built-ins. No dependencies, no build step. `bun test` for tests. SQLite via `bun:sqlite` / `node:sqlite` / the `sqlite3` binary, whichever is present.

**Spec:** `docs/superpowers/specs/2026-09-08-agy-usage-reporter-design.md`

## Global Constraints

Every task inherits these. They are the reason this plugin is safe to install.

- **Zero dependencies, zero build.** Nothing may be added to `package.json` beyond `"private"`, `"type"` and a `test` script. The plugin is the source; there is no `dist/`.
- **Runs under both `bun` and `node`.** `scripts/run` picks whichever it finds. No `bun:`-only import outside `try`/`catch`, and none at all in `src/` module top-level.
- **Never exit non-zero, never throw out of a hook.** `main()` already ends in a `catch` that logs and exits 0. Every new failure path logs and returns.
- **Only counts leave the machine.** Model id, timestamp, request id, token totals. Never prompts, completions, file paths, workspace names or conversation titles — including in the log file.
- **`agy` hooks block the agent loop.** There is no `async: true`. The hook must print `{}` and return in milliseconds; the work is detached.
- **Portal limits, copied verbatim from `llm-web`:** `MAX_INGEST_EVENTS = 500` per request, `MAX_EVENT_AGE_DAYS = 100`, `MAX_NEW_MODELS_PER_INGEST = 10`, `INGEST_SOURCES` is a whitelist.
- **`Stop` hook output contract:** `{"decision": "continue"}` blocks the stop. Anything else — including `{}` — lets the agent stop. Never emit `continue`.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | New. `private`, `type: module`, one `test` script. No dependencies. |
| `src/reporter.mjs` | Rewritten to be the CLI only: argv, host selection, `--status` rendering, command dispatch. |
| `src/core/config.mjs` | New. `loadConfig`, `configProblem`, `redactKey`. Owns the config search path. |
| `src/core/store.mjs` | New. `createStore(stateDir)` — log, lock, `state.json`, spool, dedup window, all rooted at one directory. |
| `src/core/upload.mjs` | New. `postBatch`, `upload`. Knows the wire format and the retry classification. |
| `src/core/report.mjs` | New. `sweepTargets`, `collect`, `report` — the pass that reads, dedups, uploads, persists. |
| `src/hosts/claude-code.mjs` | New. Transcript JSONL adapter, moved verbatim from `reporter.mjs`. |
| `src/hosts/antigravity.mjs` | New. Conversation-database adapter: units, cursor, sweep. |
| `src/hosts/antigravity/extract.mjs` | New. One `gen_metadata` blob → one portal event, with the invariant that guards the mapping. |
| `src/lib/protobuf.mjs` | New. Minimal wire-format walker for a blob with no schema. |
| `src/lib/sqlite.mjs` | New. `readGenMetadata` over three interchangeable backends. |
| `plugin.json` | New, repo root. `agy` manifest. |
| `hooks.json` | New, repo root. `agy` hooks — one `Stop` handler. |
| `skills/jyl-usage/SKILL.md` | New. The `agy` counterpart of `commands/jyl-usage.md`. |
| `scripts/run` | Modified. Understands `--detach`, forwards stdin to the detached child. |
| `tests/*.test.js` | New. `bun test`. |
| `tests/helpers/pb.js` | New. A protobuf *encoder*, so fixtures are built in the test rather than committed. |

---

### Task 1: Protobuf walker

A blob with no `.proto` is still readable: the wire format carries field numbers and types. This produces a lookup keyed by dotted field path, which every later task uses to find the model id, the request id and the counts.

**Files:**
- Create: `src/lib/protobuf.mjs`
- Create: `tests/helpers/pb.js`
- Create: `tests/protobuf.test.js`
- Create: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `scan(bytes, opts?) -> { varints: Map<string, number[]>, strings: Map<string, string[]>, submessages: Map<string, Uint8Array[]> }`. Paths are dotted field numbers from the root, e.g. `"1.4.2"`. Every map's values are in encounter order. `opts` is `{ maxDepth = 8, maxNodes = 50_000 }`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "jyl-usage",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test"
  }
}
```

- [ ] **Step 2: Write the encoder helper**

`tests/helpers/pb.js` — fixtures are built, never committed as binaries, so no real conversation data ever enters the repository.

```js
/** Minimal protobuf *encoder*, for building test fixtures. */
export function varint(n) {
  const out = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

const tag = (num, wire) => varint((num << 3) | wire);

/** Varint field: `vint(2, 26404)`. */
export const vint = (num, value) => Buffer.concat([tag(num, 0), varint(value)]);

/** Length-delimited field from raw bytes: `bytes(4, submessage)`. */
export const bytes = (num, buf) => Buffer.concat([tag(num, 2), varint(buf.length), buf]);

/** Length-delimited field from a string: `str(19, "gemini-3.8-flash")`. */
export const str = (num, s) => bytes(num, Buffer.from(s, "utf8"));

/** Concatenate fields into one message body. */
export const msg = (...parts) => Buffer.concat(parts);
```

- [ ] **Step 3: Write the failing test**

`tests/protobuf.test.js`:

```js
import { describe, expect, test } from "bun:test";
import { scan } from "../src/lib/protobuf.mjs";
import { bytes, msg, str, vint } from "./helpers/pb.js";

describe("scan", () => {
  test("indexes varints, strings and submessages by dotted path", () => {
    const inner = msg(vint(2, 26404), vint(3, 193), vint(9, 136), vint(10, 57));
    const blob = msg(bytes(1, msg(bytes(4, inner), str(19, "gemini-3.8-flash"))));

    const sc = scan(blob);

    expect(sc.varints.get("1.4.2")).toEqual([26404]);
    expect(sc.varints.get("1.4.3")).toEqual([193]);
    expect(sc.strings.get("1.19")).toEqual(["gemini-3.8-flash"]);
    expect(sc.submessages.get("1.4")).toHaveLength(1);
  });

  test("keeps repeated fields in encounter order", () => {
    const pair = (k, v) => bytes(20, msg(str(1, k), str(2, v)));
    const blob = msg(bytes(1, msg(pair("trajectory_id", "abc"), pair("request_id", "abc-40"))));

    const entries = scan(blob).submessages.get("1.20");

    expect(entries).toHaveLength(2);
    expect(scan(entries[0]).strings.get("1")).toEqual(["trajectory_id"]);
    expect(scan(entries[1]).strings.get("2")).toEqual(["abc-40"]);
  });

  test("returns empty maps for bytes that are not protobuf at all", () => {
    const sc = scan(Buffer.from("not a protobuf, just text", "utf8"));
    expect(sc.varints.size + sc.strings.size + sc.submessages.size).toBe(0);
  });

  test("does not recurse past maxDepth", () => {
    let blob = msg(vint(1, 99));
    for (let i = 0; i < 12; i++) blob = msg(bytes(1, blob));
    const sc = scan(blob, { maxDepth: 3 });
    expect([...sc.varints.keys()].every((k) => k.split(".").length <= 4)).toBe(true);
  });
});
```

- [ ] **Step 4: Run the test and watch it fail**

Run: `bun test tests/protobuf.test.js`
Expected: FAIL — `Cannot find module '../src/lib/protobuf.mjs'`.

- [ ] **Step 5: Implement the walker**

`src/lib/protobuf.mjs`:

```js
/**
 * The smallest protobuf reader that answers one question: what is in this blob,
 * when nobody shipped us a `.proto`?
 *
 * The wire format carries field numbers and wire types but no names, so this
 * indexes everything by dotted field path (`1.4.2`) and leaves the meaning to
 * the caller. A length-delimited field is ambiguous by design — the same bytes
 * may be a nested message, a string, or neither — so it is recorded as whatever
 * it successfully parses as, sometimes both. Reading by a known path is
 * therefore exact; guessing from the shape is not, which is why the caller
 * checks invariants rather than trusting a field number alone.
 *
 * Bounded on purpose: a hostile or simply unlucky blob must not turn a hook
 * into an unbounded walk.
 */

function readVarint(b, i) {
  let result = 0;
  let shift = 0;
  while (i < b.length) {
    const byte = b[i++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 63) throw new RangeError("varint too long");
  }
  throw new RangeError("truncated varint");
}

/** True when the bytes decode as UTF-8 without control characters. */
function asString(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.length === 0) return null;
  if (Buffer.byteLength(text, "utf8") !== bytes.length) return null; // lossy: not text
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null;
  }
  return text;
}

export function scan(bytes, { maxDepth = 8, maxNodes = 50_000 } = {}) {
  const varints = new Map();
  const strings = new Map();
  const submessages = new Map();
  let nodes = 0;

  const push = (map, path, value) => {
    const list = map.get(path);
    if (list) list.push(value);
    else map.set(path, [value]);
  };

  const walk = (buf, prefix, depth) => {
    let i = 0;
    while (i < buf.length) {
      if (++nodes > maxNodes) throw new RangeError("too many fields");
      let key;
      [key, i] = readVarint(buf, i);
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (field === 0) throw new RangeError("field number 0");
      const path = prefix ? `${prefix}.${field}` : String(field);

      if (wire === 0) {
        let value;
        [value, i] = readVarint(buf, i);
        push(varints, path, value);
      } else if (wire === 1) {
        if (i + 8 > buf.length) throw new RangeError("truncated fixed64");
        i += 8;
      } else if (wire === 5) {
        if (i + 4 > buf.length) throw new RangeError("truncated fixed32");
        i += 4;
      } else if (wire === 2) {
        let length;
        [length, i] = readVarint(buf, i);
        if (i + length > buf.length) throw new RangeError("truncated bytes");
        const payload = buf.subarray(i, i + length);
        i += length;
        if (depth < maxDepth && payload.length > 0) {
          // Try it as a message. A failure means it was never one; the partial
          // results it added are discarded so a string cannot leave debris
          // behind under a path that does not exist.
          const snapshot = [varints, strings, submessages].map((m) => new Map([...m].map(([k, v]) => [k, [...v]])));
          try {
            walk(payload, path, depth + 1);
            push(submessages, path, payload);
          } catch {
            const [v, s, m] = snapshot;
            varints.clear(); for (const [k, val] of v) varints.set(k, val);
            strings.clear(); for (const [k, val] of s) strings.set(k, val);
            submessages.clear(); for (const [k, val] of m) submessages.set(k, val);
          }
        }
        const text = asString(payload);
        if (text !== null) push(strings, path, text);
      } else {
        throw new RangeError(`unsupported wire type ${wire}`);
      }
    }
  };

  try {
    walk(Buffer.from(bytes), "", 0);
  } catch {
    // A blob this cannot parse yields nothing, which the caller treats as "no
    // usage here" — never as an error worth failing a hook over.
    return { varints: new Map(), strings: new Map(), submessages: new Map() };
  }
  return { varints, strings, submessages };
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `bun test tests/protobuf.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json src/lib/protobuf.mjs tests/helpers/pb.js tests/protobuf.test.js
git commit -m "feat(agy): read a protobuf blob nobody shipped a schema for"
```

---

### Task 2: SQLite reader

`agy` stores one row per generation in `conversations/<id>.db`. Three runtimes can read it and the plugin may run under any of them, so the choice is made once, here.

**Files:**
- Create: `src/lib/sqlite.mjs`
- Create: `tests/sqlite.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `readGenMetadata(dbFile, afterIdx) -> Array<{ idx: number, data: Uint8Array }> | null`. Rows with `idx > afterIdx`, ascending. `null` means no backend is available — distinct from `[]`, which means the database had nothing new. Also `sqliteBackend() -> "bun" | "node" | "cli" | null`, for `--status`.

- [ ] **Step 1: Write the failing test**

`tests/sqlite.test.js`:

```js
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGenMetadata, sqliteBackend } from "../src/lib/sqlite.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-sqlite-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(name, rows) {
  const file = path.join(dir, name);
  const db = new Database(file, { create: true });
  db.run("CREATE TABLE `gen_metadata` (`idx` integer, `data` blob, `size` integer NOT NULL DEFAULT 0, PRIMARY KEY (`idx`))");
  const insert = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
  for (const [idx, data] of rows) insert.run(idx, data, data.length);
  db.close();
  return file;
}

test("reads rows after a cursor, in order", () => {
  const file = fixture("a.db", [
    [0, Buffer.from([1, 2, 3])],
    [7, Buffer.from([4, 5])],
    [9, Buffer.from([6])],
  ]);

  const rows = readGenMetadata(file, 0);

  expect(rows.map((r) => r.idx)).toEqual([7, 9]);
  expect(Buffer.from(rows[0].data)).toEqual(Buffer.from([4, 5]));
});

test("returns an empty array when nothing is new", () => {
  const file = fixture("b.db", [[3, Buffer.from([1])]]);
  expect(readGenMetadata(file, 3)).toEqual([]);
});

test("returns an empty array for a database that is not there", () => {
  expect(readGenMetadata(path.join(dir, "missing.db"), 0)).toEqual([]);
});

test("reports which backend it used", () => {
  expect(["bun", "node", "cli"]).toContain(sqliteBackend());
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/sqlite.test.js`
Expected: FAIL — `Cannot find module '../src/lib/sqlite.mjs'`.

- [ ] **Step 3: Implement the reader**

`src/lib/sqlite.mjs`:

```js
/**
 * Read-only access to `agy`'s conversation databases.
 *
 * Three interchangeable backends, tried in the order that costs least: bun's
 * built-in, node's built-in (22.5+, and still flagged experimental in some
 * releases), then the `sqlite3` binary. Which one is available depends on how
 * the hook happened to be launched, so the choice cannot be made at install
 * time.
 *
 * Always read-only, never a write, never a schema change: `agy` owns these
 * files, keeps them in WAL mode, and is very likely writing to one right now.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const SQL = "SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC";

let cached;

function pickBackend() {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const { Database } = require_("bun:sqlite");
    cached = { kind: "bun", Database };
    return cached;
  } catch {
    /* not bun */
  }
  try {
    const { DatabaseSync } = require_("node:sqlite");
    cached = { kind: "node", DatabaseSync };
    return cached;
  } catch {
    /* node too old, or built without it */
  }
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    cached = { kind: "cli" };
  } catch {
    /* no sqlite3 on PATH */
  }
  return cached;
}

/**
 * `import()` is async and every caller here is on a synchronous path, so the
 * two built-ins are loaded through `createRequire`. Both are CJS-compatible.
 */
function require_(specifier) {
  // eslint-disable-next-line no-undef
  const { createRequire } = globalThis.process?.getBuiltinModule
    ? globalThis.process.getBuiltinModule("node:module")
    : require("node:module");
  return createRequire(import.meta.url)(specifier);
}

export function sqliteBackend() {
  return pickBackend()?.kind ?? null;
}

export function readGenMetadata(dbFile, afterIdx) {
  if (!fs.existsSync(dbFile)) return [];
  const backend = pickBackend();
  if (!backend) return null;

  if (backend.kind === "bun") {
    const db = new backend.Database(dbFile, { readonly: true });
    try {
      return db
        .query(SQL)
        .all(afterIdx)
        .map((r) => ({ idx: Number(r.idx), data: new Uint8Array(r.data) }));
    } finally {
      db.close();
    }
  }

  if (backend.kind === "node") {
    const db = new backend.DatabaseSync(dbFile, { readOnly: true });
    try {
      return db
        .prepare(SQL)
        .all(afterIdx)
        .map((r) => ({ idx: Number(r.idx), data: new Uint8Array(r.data) }));
    } finally {
      db.close();
    }
  }

  // The CLI cannot hand back binary, so the blob comes over as hex.
  const out = execFileSync(
    "sqlite3",
    ["-readonly", "-noheader", "-list", "-separator", "|", dbFile,
     `SELECT idx, hex(data) FROM gen_metadata WHERE idx > ${Number(afterIdx) || 0} ORDER BY idx ASC`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    rows.push({
      idx: Number(line.slice(0, sep)),
      data: new Uint8Array(Buffer.from(line.slice(sep + 1), "hex")),
    });
  }
  return rows;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/sqlite.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the two backends this repo does not exercise by default**

Run, and record the result in the commit message:

```bash
node --version
node -e "import('node:sqlite').then(() => console.log('node:sqlite available')).catch(() => console.log('node:sqlite absent'))"
sqlite3 -version
```

If `node:sqlite` is absent on this machine, that is fine — the fallback chain is the point — but say so in the commit body rather than claiming three verified backends.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sqlite.mjs tests/sqlite.test.js
git commit -m "feat(agy): read agy conversation databases through whichever sqlite exists"
```

---

### Task 3: Blob → event

The mapping the whole design rests on. It is inferred, so it is guarded: a row whose numbers do not satisfy the invariant is skipped rather than reported.

**Files:**
- Create: `src/hosts/antigravity/extract.mjs`
- Create: `tests/antigravity-extract.test.js`

**Interfaces:**
- Consumes: `scan` from `src/lib/protobuf.mjs`.
- Produces:
  - `eventFromBlob(data, { ts }) -> Event | null` where `Event` is `{ requestId, ts, model, inputTokens, outputTokens, cacheWrite5mTokens, cacheWrite1hTokens, cacheReadTokens }` — the exact object the portal's `/v1/usage/ingest` accepts.
  - `pairsFrom(sc) -> Map<string, string>` — the `1.20` key/value table (`request_id`, `trajectory_id`, `model_enum`, `used_claude`, …).

- [ ] **Step 1: Write the failing test**

`tests/antigravity-extract.test.js`. The fixture mirrors a real row observed in `agy` 2.12.0: model at `1.19`, key/value pairs at `1.20`, counts at `1.4`.

```js
import { describe, expect, test } from "bun:test";
import { eventFromBlob } from "../src/hosts/antigravity/extract.mjs";
import { bytes, msg, str, vint } from "./helpers/pb.js";

const TS = "2026-09-08T03:58:59Z";

/** One `gen_metadata.data` blob, shaped like the ones agy 2.12.0 writes. */
function blob({ input = 3507, cached = 82207, think = 993, text = 1736, model = "gemini-3.8-flash", requestId = "traj-40" } = {}) {
  const usage = msg(
    vint(1, 1318), // model enum, not a token count
    vint(2, input),
    vint(3, think + text),
    vint(5, cached),
    vint(9, think),
    vint(10, text),
  );
  const pair = (k, v) => bytes(20, msg(str(1, k), str(2, v)));
  return msg(
    bytes(1, msg(
      bytes(4, usage),
      str(19, model),
      pair("trajectory_id", "traj"),
      pair("request_id", requestId),
      pair("model_enum", "MODEL_PLACEHOLDER_M318"),
    )),
  );
}

describe("eventFromBlob", () => {
  test("maps agy's counts onto the portal's fields", () => {
    expect(eventFromBlob(blob(), { ts: TS })).toEqual({
      requestId: "traj-40",
      ts: TS,
      model: "gemini-3.8-flash",
      inputTokens: 3507,
      outputTokens: 2729,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 82207,
    });
  });

  test("treats a missing cache field as zero, not as a broken row", () => {
    const first = msg(
      bytes(1, msg(
        bytes(4, msg(vint(1, 1318), vint(2, 26404), vint(3, 193), vint(9, 136), vint(10, 57))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-0"))),
      )),
    );
    const event = eventFromBlob(first, { ts: TS });
    expect(event.cacheReadTokens).toBe(0);
    expect(event.inputTokens).toBe(26404);
    expect(event.outputTokens).toBe(193);
  });

  test("skips a row whose output total does not equal its parts", () => {
    const drifted = msg(
      bytes(1, msg(
        bytes(4, msg(vint(2, 100), vint(3, 999), vint(9, 10), vint(10, 20))),
        str(19, "gemini-3.8-flash"),
        bytes(20, msg(str(1, "request_id"), str(2, "traj-1"))),
      )),
    );
    expect(eventFromBlob(drifted, { ts: TS })).toBeNull();
  });

  test("skips a row with no request id, which could never be deduplicated", () => {
    expect(eventFromBlob(blob({ requestId: "" }), { ts: TS })).toBeNull();
  });

  test("skips a row that spent nothing", () => {
    expect(eventFromBlob(blob({ input: 0, cached: 0, think: 0, text: 0 }), { ts: TS })).toBeNull();
  });

  test("reports whatever model the row names, Gemini or not", () => {
    const event = eventFromBlob(blob({ model: "claude-sonnet-5" }), { ts: TS });
    expect(event.model).toBe("claude-sonnet-5");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/antigravity-extract.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the extraction**

`src/hosts/antigravity/extract.mjs`:

```js
/**
 * One `gen_metadata` blob → one reportable event.
 *
 * `agy` ships no schema for this, so the paths below were established by
 * reading real blobs from agy 2.12.0 and are documented in
 * `docs/superpowers/specs/2026-09-08-agy-usage-reporter-design.md`:
 *
 *   1.19   the model id, as a plain string ("gemini-3.8-flash")
 *   1.20   a repeated {1: key, 2: value} table holding `request_id` among others
 *   1.4    the counts, mirrored at 1.17.2
 *
 * Inside the counts message, field 1 is *not* a token count — it is the model
 * enum, constant across every row of a conversation (1318 ↔
 * `MODEL_PLACEHOLDER_M318` in the same blob's key/value table). Mistaking it for
 * input tokens would have added a fixed 1318 to every request.
 *
 * Because the mapping is inferred, it is checked rather than trusted: the
 * output total must equal thinking plus text. A future `agy` that renumbers
 * these fields makes the check fail, and a failed check means the row is
 * skipped — under-reporting, which `--status` shows, instead of wrong numbers,
 * which nobody would notice.
 */

import { scan } from "../../lib/protobuf.mjs";

const USAGE_PATHS = ["1.4", "1.17.2"];
const MODEL_PATH = "1.19";
const PAIRS_PATH = "1.20";

const int = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export function pairsFrom(sc) {
  const out = new Map();
  for (const entry of sc.submessages.get(PAIRS_PATH) ?? []) {
    const inner = scan(entry, { maxDepth: 2 });
    const key = inner.strings.get("1")?.[0];
    const value = inner.strings.get("2")?.[0];
    if (key) out.set(key, value ?? "");
  }
  return out;
}

function usageFrom(sc) {
  for (const base of USAGE_PATHS) {
    const at = (field) => int(sc.varints.get(`${base}.${field}`)?.[0]);
    const total = at(3);
    const thinking = at(9);
    const text = at(10);
    const input = at(2);
    const cached = at(5);
    if (total === 0 && input === 0 && cached === 0) continue;
    if (total !== thinking + text) continue; // the invariant; see the header
    return { input, cached, output: total };
  }
  return null;
}

export function eventFromBlob(data, { ts }) {
  const sc = scan(data);

  const model = sc.strings.get(MODEL_PATH)?.[0]?.trim();
  if (!model) return null;

  const requestId = pairsFrom(sc).get("request_id")?.trim();
  if (!requestId) return null;

  const usage = usageFrom(sc);
  if (!usage) return null;
  if (usage.input + usage.cached + usage.output === 0) return null;

  return {
    requestId,
    ts,
    model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    // Gemini's implicit caching has no separately-priced write, so both write
    // buckets are structurally zero here rather than merely unknown.
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: usage.cached,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/antigravity-extract.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Check the mapping against a real database**

This is spec open item 4 and it must not be skipped. With `agy` installed and at least one conversation on disk:

```bash
bun -e '
import { readGenMetadata } from "./src/lib/sqlite.mjs";
import { eventFromBlob } from "./src/hosts/antigravity/extract.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const dir = path.join(os.homedir(), ".gemini/antigravity-cli/conversations");
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".db"))) {
  const rows = readGenMetadata(path.join(dir, f), -1) ?? [];
  const events = rows.map((r) => eventFromBlob(r.data, { ts: new Date().toISOString() })).filter(Boolean);
  console.log(f, rows.length, "rows,", events.length, "events,",
    events.reduce((n, e) => n + e.inputTokens + e.cacheReadTokens + e.outputTokens, 0), "tokens");
}'
```

Expected: most rows yield an event; the token totals are plausible against what `/usage` reports inside `agy` for the same conversation. If a large fraction of rows are skipped, stop and investigate before continuing — a silently-skipping reporter is the failure mode this plan is built to avoid.

- [ ] **Step 6: Commit**

```bash
git add src/hosts/antigravity/extract.mjs tests/antigravity-extract.test.js
git commit -m "feat(agy): map a generation blob onto the portal's usage fields"
```

---

### Task 4: Config and per-host store

The first half of the extraction. Everything here moves out of `src/reporter.mjs` with its behaviour unchanged, except that the config gains a shared search path and the state directory becomes a parameter instead of a constant.

**Files:**
- Create: `src/core/config.mjs`
- Create: `src/core/store.mjs`
- Create: `tests/config.test.js`
- Create: `tests/store.test.js`
- Modify: `src/reporter.mjs` (delete the moved code; import from the new modules)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadConfig({ files }) -> { baseUrl, apiKey, enabled, reportGatewayTraffic }`. `files` is an ordered list of candidate config paths; the first that exists wins, and the environment beats all of them.
  - `configFiles(hostConfigFile) -> string[]` — `[~/.config/jyl-usage/config.json, hostConfigFile]`.
  - `configProblem(config) -> string | null`, `redactKey(key) -> string`, `hostOf(url) -> string | null`.
  - `createStore(stateDir) -> { dir, configFile, logFile, log(msg), withLock(fn) -> Promise<boolean>, loadState(), saveState(state), readSpool(), writeSpool(events), readSeen(), persistSeen(all, added) }`.

- [ ] **Step 1: Write the failing config test**

`tests/config.test.js`:

```js
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configProblem, loadConfig, redactKey } from "../src/core/config.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-config-"));
const write = (name, body) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

afterEach(() => {
  delete process.env.JYL_USAGE_BASE_URL;
  delete process.env.JYL_API_KEY;
  delete process.env.JYL_USAGE_DISABLED;
});

test("the environment beats every file", () => {
  const file = write("a.json", { baseUrl: "https://file.example", apiKey: "jyl-file" });
  process.env.JYL_USAGE_BASE_URL = "https://env.example";
  process.env.JYL_API_KEY = "jyl-env";

  const config = loadConfig({ files: [file] });

  expect(config.baseUrl).toBe("https://env.example");
  expect(config.apiKey).toBe("jyl-env");
});

test("the first file that exists wins", () => {
  const shared = write("shared.json", { baseUrl: "https://shared.example", apiKey: "jyl-shared" });
  const legacy = write("legacy.json", { baseUrl: "https://legacy.example", apiKey: "jyl-legacy" });

  expect(loadConfig({ files: [path.join(dir, "absent.json"), shared, legacy] }).baseUrl)
    .toBe("https://shared.example");
});

test("falls back to the legacy file when the shared one is absent", () => {
  const legacy = write("legacy2.json", { baseUrl: "https://legacy.example", apiKey: "jyl-legacy" });
  expect(loadConfig({ files: [path.join(dir, "absent.json"), legacy] }).apiKey).toBe("jyl-legacy");
});

test("strips a trailing /v1 from the origin", () => {
  const file = write("v1.json", { baseUrl: "https://llm.jianyuelab.net/v1/", apiKey: "jyl-x" });
  expect(loadConfig({ files: [file] }).baseUrl).toBe("https://llm.jianyuelab.net");
});

test("names the problem when it cannot report", () => {
  expect(configProblem({ enabled: false })).toBe("disabled");
  expect(configProblem({ enabled: true, baseUrl: "", apiKey: "k" })).toBe("no base URL configured");
  expect(configProblem({ enabled: true, baseUrl: "https://a.example", apiKey: "" })).toBe("no API key configured");
  expect(configProblem({ enabled: true, baseUrl: "https://a.example", apiKey: "k" })).toBeNull();
});

test("redacts the key for display", () => {
  expect(redactKey("jyl-abcdefghijkl")).toBe("jyl-…ijkl");
  expect(redactKey("")).toBe("(unset)");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/config.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/config.mjs`**

Move `loadConfig`, `configProblem`, `redactKey` and `hostOf` out of `src/reporter.mjs` unchanged, with two edits: `loadConfig` takes `{ files }` and walks them in order, and the shared path joins the list.

```js
/**
 * Where to report and with what key.
 *
 * The environment wins over every file, so a shell that already exports
 * `JYL_API_KEY` — the same variable `/setup` hands Claude Code's
 * `apiKeyHelper` — needs no second copy of the secret on disk. Among files, the
 * shared path is checked before the host's own, so one key serves both hosts
 * while an existing `~/.claude/jyl-usage/config.json` keeps working untouched.
 *
 * `baseUrl` is the portal **origin**, not its `…/v1` base: this posts to
 * `<origin>/v1/usage/ingest`, and a value already ending in `/v1` would resolve
 * to `/v1/v1/usage/ingest`. A trailing `/v1` is stripped rather than 404ing an
 * hour later in a log nobody is reading.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHARED_CONFIG_FILE = path.join(os.homedir(), ".config", "jyl-usage", "config.json");

export const configFiles = (hostConfigFile) => [SHARED_CONFIG_FILE, hostConfigFile];

export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function firstFile(files) {
  for (const file of files) {
    try {
      return { file, body: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      /* absent or unreadable: try the next */
    }
  }
  return { file: null, body: {} };
}

export function loadConfig({ files = [] } = {}) {
  const { file, body } = firstFile(files);
  const rawBase = process.env.JYL_USAGE_BASE_URL || process.env.JYL_LLM_BASE_URL || body.baseUrl || "";
  return {
    source: file,
    baseUrl: rawBase.trim().replace(/\/+$/, "").replace(/\/v1$/, ""),
    apiKey: (process.env.JYL_USAGE_API_KEY || process.env.JYL_API_KEY || body.apiKey || "").trim(),
    enabled: process.env.JYL_USAGE_DISABLED === "1" ? false : body.enabled !== false,
    reportGatewayTraffic: body.reportGatewayTraffic === true,
  };
}

export function configProblem(config) {
  if (!config.enabled) return "disabled";
  if (!config.baseUrl) return "no base URL configured";
  if (!config.apiKey) return "no API key configured";
  if (!hostOf(config.baseUrl)) return `base URL is not a URL: ${config.baseUrl}`;
  return null;
}

export function redactKey(key) {
  if (!key) return "(unset)";
  return key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
```

- [ ] **Step 4: Run the config test and watch it pass**

Run: `bun test tests/config.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing store test**

`tests/store.test.js`:

```js
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/core/store.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-store-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const fresh = (name) => createStore(path.join(root, name));

test("state round-trips and starts empty", () => {
  const store = fresh("state");
  expect(store.loadState()).toEqual({ version: 2, files: {} });
  store.saveState({ version: 2, files: { "/a.jsonl": { offset: 42 } } });
  expect(store.loadState().files["/a.jsonl"].offset).toBe(42);
});

test("migrates a v1 state, carrying its per-file seen keys", () => {
  const store = fresh("migrate");
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(
    path.join(store.dir, "state.json"),
    JSON.stringify({ version: 1, files: { "/a.jsonl": { offset: 7, seen: ["req_1", "req_2"] } } }),
  );

  const state = store.loadState();

  expect(state.version).toBe(2);
  expect(state.files["/a.jsonl"].offset).toBe(7);
  expect(state.carried).toEqual(["req_1", "req_2"]);
});

test("the spool round-trips and clears", () => {
  const store = fresh("spool");
  store.writeSpool([{ requestId: "a" }, { requestId: "b" }]);
  expect(store.readSpool().map((e) => e.requestId)).toEqual(["a", "b"]);
  store.writeSpool([]);
  expect(store.readSpool()).toEqual([]);
});

test("the dedup window appends, then compacts once it overshoots", () => {
  const store = fresh("seen");
  store.persistSeen(["a", "b"], ["a", "b"]);
  expect(store.readSeen()).toEqual(["a", "b"]);

  const many = Array.from({ length: 4600 }, (_, i) => `k${i}`);
  store.persistSeen(many, many.slice(-10));
  expect(store.readSeen()).toHaveLength(3000);
  expect(store.readSeen().at(-1)).toBe("k4599");
});

test("the lock keeps a second run out and is released afterwards", async () => {
  const store = fresh("lock");
  let inner = null;
  const ran = await store.withLock(async () => {
    inner = await store.withLock(async () => {});
  });
  expect(ran).toBe(true);
  expect(inner).toBe(false);
  expect(await store.withLock(async () => {})).toBe(true);
});

test("two stores in different directories do not share anything", () => {
  const a = fresh("hostA");
  const b = fresh("hostB");
  a.persistSeen(["only-a"], ["only-a"]);
  expect(b.readSeen()).toEqual([]);
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test tests/store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/core/store.mjs`**

Move these out of `src/reporter.mjs` **verbatim**, wrapped in a factory so the paths come from `stateDir` instead of module constants. Keep every explanatory comment — they record why the shapes are what they are.

| Function | Lines in today's `src/reporter.mjs` |
|---|---|
| `log` | 80–93 |
| `readJson` | 95–101 |
| `writeTextAtomic` | 103–108 |
| `withLock` | 177–215 |
| `readSpool` | 327–339 |
| `writeSpool` | 341–358 |
| `readSeen` | 380–396 |
| `persistSeen` | 398–406 |
| `loadState` | 483–526 |

Plus the constants they close over, from lines 61–74: `SEEN_KEYS`, `SEEN_COMPACT_AT`, `MAX_SPOOL_EVENTS`, `MAX_LOG_BYTES`, `STATE_VERSION`.

```js
export function createStore(stateDir) {
  const paths = {
    dir: stateDir,
    configFile: path.join(stateDir, "config.json"),
    stateFile: path.join(stateDir, "state.json"),
    spoolFile: path.join(stateDir, "spool.jsonl"),
    seenFile: path.join(stateDir, "seen"),
    lockFile: path.join(stateDir, "lock"),
    logFile: path.join(stateDir, "log"),
  };
  // The nine function bodies from the table above, unchanged except that
  // every `STATE_DIR` / `*_FILE` constant becomes the matching `paths.*`.
  return { ...paths, log, withLock, loadState, saveState, readSpool, writeSpool, readSeen, persistSeen };
}
```

`saveState(state)` is new and trivial — `writeTextAtomic(paths.stateFile, JSON.stringify(state, null, 2))` — because `report` used to inline it.

- [ ] **Step 8: Run the store test and watch it pass**

Run: `bun test tests/store.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add src/core/config.mjs src/core/store.mjs tests/config.test.js tests/store.test.js src/reporter.mjs
git commit -m "refactor: lift config and per-host state out of the reporter"
```

---

### Task 5: Upload

**Files:**
- Create: `src/core/upload.mjs`
- Create: `tests/upload.test.js`
- Modify: `src/reporter.mjs` (delete the moved code)

**Interfaces:**
- Consumes: `createStore(...).log` (passed in, so the module writes to the right host's log).
- Produces: `upload({ config, source, client, log }, events) -> { tally: { sent, accepted, duplicates, rejected, spooled }, failed: Event[] }`. Batches at 500. `failed` is what the caller must spool.

- [ ] **Step 1: Write the failing test**

`tests/upload.test.js`:

```js
import { afterEach, expect, test } from "bun:test";
import { upload } from "../src/core/upload.mjs";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

const ctx = { config: { baseUrl: "https://portal.example", apiKey: "jyl-k" }, source: "antigravity", client: "test/1", log: () => {} };
const events = (n) => Array.from({ length: n }, (_, i) => ({ requestId: `r${i}` }));

test("posts the declared source and client to the ingest route", async () => {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response(JSON.stringify({ received: 1, accepted: 1, duplicates: 0, rejected: [] }), { status: 200 });
  };

  const { tally } = await upload(ctx, events(1));

  expect(seen.url).toBe("https://portal.example/v1/usage/ingest");
  expect(seen.body.source).toBe("antigravity");
  expect(seen.body.client).toBe("test/1");
  expect(seen.auth).toBe("Bearer jyl-k");
  expect(tally.accepted).toBe(1);
});

test("splits batches at the portal's 500-event cap", async () => {
  const sizes = [];
  globalThis.fetch = async (_url, init) => {
    sizes.push(JSON.parse(init.body).events.length);
    return new Response(JSON.stringify({ accepted: 0, duplicates: 0, rejected: [] }), { status: 200 });
  };

  await upload(ctx, events(1100));

  expect(sizes).toEqual([500, 500, 100]);
});

test("spools a rejected key rather than dropping real usage", async () => {
  globalThis.fetch = async () => new Response("bad key", { status: 401 });
  const { failed, tally } = await upload(ctx, events(3));
  expect(failed).toHaveLength(3);
  expect(tally.spooled).toBe(3);
});

test("drops a payload no retry could fix", async () => {
  globalThis.fetch = async () => new Response("unknown source", { status: 400 });
  const { failed } = await upload(ctx, events(3));
  expect(failed).toHaveLength(0);
});

test("spools when the network fails", async () => {
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  const { failed } = await upload(ctx, events(2));
  expect(failed).toHaveLength(2);
});
```

Note the fourth test: a 400 is dropped, which is exactly what happens while `llm-web` still rejects `antigravity` as an unknown source. Task 10 lands that change; until it does, `agy` usage is discarded rather than queued. That is deliberate — see the failure-modes table in the spec — but it means Task 10 should land *first* in deployment order even though it is written last here.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/upload.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/upload.mjs`**

Move `postBatch` (lines 423–451) and `upload` (lines 453–477) across verbatim, plus `BATCH_SIZE` and `REQUEST_TIMEOUT_MS` from lines 49–51. The only edit: `SOURCE`, `CLIENT` and `log` come from the context argument instead of module constants, so one module serves both hosts. Keep the comment explaining why 401/403 retry — it is the reason a revoked key does not throw away usage.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test tests/upload.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/upload.mjs tests/upload.test.js src/reporter.mjs
git commit -m "refactor: lift the upload out of the reporter, parameterised by source"
```

---

### Task 6: The reporting pass, and the Claude Code adapter

The load-bearing refactor. When it is done the Claude Code path must behave exactly as it does today; the new seam is that `report` no longer knows what a transcript is.

**Files:**
- Create: `src/core/report.mjs`
- Create: `src/hosts/claude-code.mjs`
- Create: `tests/claude-code.test.js`
- Create: `tests/report.test.js`
- Modify: `src/reporter.mjs` (becomes the CLI only)

**Interfaces:**
- Consumes: `createStore`, `loadConfig`, `upload`.
- Produces:
  - A **host adapter** shape, implemented twice:
    ```js
    {
      id: string,                                  // "claude-code"
      source: string,                              // the portal's INGEST_SOURCES value
      client: string,                              // "claude-code-usage-reporter/0.3.0"
      title: string,                               // --status heading
      unitLabel: string,                           // "transcript" | "conversation"
      stateDir: string,
      unitsFromHook(hook: object): string[],
      recentUnits(days: number): string[],
      probe(unit: string, entry: object): { mtimeMs: number, pending: number } | null,
      read(unit: string, entry: object): { events: Event[], entry: object },
      skipReason(config: object): string | null,
      statusNotes(config: object): string[],
    }
    ```
    `entry` is whatever the adapter last returned; the core stores it under `state.files[unit]` and never inspects it. `probe` returning `null` means the unit is gone and should be forgotten. `pending > 0` means the sweep should pick it up.
  - `report(host, store, config, units, { sweep }) -> { sent, accepted, duplicates, rejected, spooled, known }`.
  - `keyOf(event) -> string` — `event.requestId || event.messageId`.

- [ ] **Step 1: Write the failing Claude Code adapter test**

`tests/claude-code.test.js`:

```js
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { host } from "../src/hosts/claude-code.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-cc-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const assistant = (requestId, usage, model = "claude-opus-5") =>
  JSON.stringify({ type: "assistant", requestId, timestamp: "2026-09-08T00:00:00.000Z", message: { id: "msg_1", model, usage } });

function transcript(name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("reads usage out of assistant entries", () => {
  const file = transcript("a.jsonl", [
    assistant("req_1", { input_tokens: 2, output_tokens: 389, cache_read_input_tokens: 22141, cache_creation: { ephemeral_1h_input_tokens: 18259 } }),
  ]);

  const { events, entry } = host.read(file, {});

  expect(events).toEqual([{
    requestId: "req_1",
    messageId: "msg_1",
    ts: "2026-09-08T00:00:00.000Z",
    model: "claude-opus-5",
    inputTokens: 2,
    outputTokens: 389,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 18259,
    cacheReadTokens: 22141,
  }]);
  expect(entry.offset).toBe(fs.statSync(file).size);
});

test("attributes an untyped cache-creation total to the 5-minute bucket", () => {
  const file = transcript("b.jsonl", [assistant("req_2", { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 900 })]);
  expect(host.read(file, {}).events[0].cacheWrite5mTokens).toBe(900);
});

test("ignores locally fabricated messages", () => {
  const file = transcript("c.jsonl", [assistant("req_3", { input_tokens: 5, output_tokens: 5 }, "<synthetic>")]);
  expect(host.read(file, {}).events).toEqual([]);
});

test("stops at the last complete line", () => {
  const file = path.join(dir, "d.jsonl");
  fs.writeFileSync(file, assistant("req_4", { input_tokens: 1, output_tokens: 1 }) + "\n{\"type\":\"assis");
  const { events, entry } = host.read(file, {});
  expect(events).toHaveLength(1);
  expect(entry.offset).toBeLessThan(fs.statSync(file).size);
});

test("restarts from zero when a transcript shrinks", () => {
  const file = transcript("e.jsonl", [assistant("req_5", { input_tokens: 1, output_tokens: 1 })]);
  const { events } = host.read(file, { offset: 10_000 });
  expect(events).toHaveLength(1);
});

test("probe reports the unread tail, and null once the file is gone", () => {
  const file = transcript("f.jsonl", [assistant("req_6", { input_tokens: 1, output_tokens: 1 })]);
  expect(host.probe(file, { offset: 0 }).pending).toBe(fs.statSync(file).size);
  fs.rmSync(file);
  expect(host.probe(file, { offset: 0 })).toBeNull();
});

test("skips a session already metered by the portal's proxy", () => {
  process.env.ANTHROPIC_BASE_URL = "https://llm.jianyuelab.net";
  try {
    expect(host.skipReason({ baseUrl: "https://llm.jianyuelab.net", reportGatewayTraffic: false })).toMatch(/portal/i);
    expect(host.skipReason({ baseUrl: "https://llm.jianyuelab.net", reportGatewayTraffic: true })).toBeNull();
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/claude-code.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/hosts/claude-code.mjs`**

Move `alreadyMeteredByPortal` (lines 168–171), `eventFromEntry` (lines 232–271), `readNewEvents` (lines 283–321), `recentTranscripts` (lines 574–615) and the `int` helper (line 110) across verbatim, and wrap them in the adapter shape:

```js
export const host = {
  id: "claude-code",
  source: "claude-code",
  client: "claude-code-usage-reporter/0.3.0",
  title: "jyl-usage — Claude Code → llm-web usage reporter",
  unitLabel: "transcript",
  stateDir: path.join(os.homedir(), ".claude", "jyl-usage"),
  unitsFromHook: (hook) => (typeof hook.transcript_path === "string" ? [hook.transcript_path] : []),
  recentUnits: (days) => recentTranscripts(days),
  probe(unit, entry) {
    let stat;
    try { stat = fs.statSync(unit); } catch { return null; }
    return { mtimeMs: stat.mtimeMs, pending: Math.max(0, stat.size - (entry.offset ?? 0)) };
  },
  read(unit, entry) {
    const { events, offset, gone } = readNewEvents(unit, entry.offset ?? 0);
    return gone ? { events: [], entry: null } : { events, entry: { offset } };
  },
  skipReason(config) {
    if (config.reportGatewayTraffic) return null;
    return alreadyMeteredByPortal(config)
      ? "this session talks to the portal directly, so /v1 already metered it"
      : null;
  },
  statusNotes(config) {
    if (!alreadyMeteredByPortal(config) || config.reportGatewayTraffic) return [];
    return [
      "",
      "  NOTE: ANTHROPIC_BASE_URL points at the portal, so this session's",
      "        traffic is metered by the /v1 proxy already and is not reported.",
    ];
  },
};
```

`read` returning `entry: null` is how an adapter says "this unit is gone"; the core deletes it from the state.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test tests/claude-code.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing report test**

`tests/report.test.js` — a fake adapter so the pass is tested without either real host:

```js
import { afterEach, afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/core/store.mjs";
import { report } from "../src/core/report.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-report-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

const config = { baseUrl: "https://portal.example", apiKey: "jyl-k", enabled: true, reportGatewayTraffic: false };
const ok = (body = { accepted: 0, duplicates: 0, rejected: [] }) => async () => new Response(JSON.stringify(body), { status: 200 });

/** An adapter whose units are plain arrays of events, handed out once. */
function fakeHost(units) {
  return {
    id: "fake", source: "fake", client: "fake/1", title: "fake", unitLabel: "unit",
    stateDir: path.join(root, `s${Math.random()}`),
    unitsFromHook: () => [], recentUnits: () => Object.keys(units),
    probe: (unit, entry) => (units[unit] ? { mtimeMs: 1, pending: entry.done ? 0 : 1 } : null),
    read: (unit, entry) => (entry.done ? { events: [], entry } : { events: units[unit], entry: { done: true } }),
    skipReason: () => null, statusNotes: () => [],
  };
}

const event = (id) => ({ requestId: id, ts: "2026-09-08T00:00:00.000Z", model: "m", inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 });

test("uploads new events and records the cursor", async () => {
  globalThis.fetch = ok({ accepted: 2, duplicates: 0, rejected: [] });
  const host = fakeHost({ u1: [event("a"), event("b")] });
  const store = createStore(host.stateDir);

  const tally = await report(host, store, config, ["u1"], {});

  expect(tally.accepted).toBe(2);
  expect(store.loadState().files.u1.done).toBe(true);
});

test("does not send the same event twice across units", async () => {
  let sent = 0;
  globalThis.fetch = async (_u, init) => {
    sent += JSON.parse(init.body).events.length;
    return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), { status: 200 });
  };
  const host = fakeHost({ u1: [event("dup")], u2: [event("dup")] });
  const store = createStore(host.stateDir);

  await report(host, store, config, ["u1", "u2"], {});

  expect(sent).toBe(1);
});

test("spools a failed upload and still advances the cursor", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const host = fakeHost({ u1: [event("x")] });
  const store = createStore(host.stateDir);

  await report(host, store, config, ["u1"], {});

  expect(store.readSpool()).toHaveLength(1);
  expect(store.loadState().files.u1.done).toBe(true);
});

test("retries the spool on the next pass", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const host = fakeHost({ u1: [event("y")] });
  const store = createStore(host.stateDir);
  await report(host, store, config, ["u1"], {});

  globalThis.fetch = ok({ accepted: 1, duplicates: 0, rejected: [] });
  const tally = await report(host, store, config, [], {});

  expect(tally.accepted).toBe(1);
  expect(store.readSpool()).toHaveLength(0);
});

test("the sweep picks up a tracked unit nobody named", async () => {
  globalThis.fetch = ok({ accepted: 1, duplicates: 0, rejected: [] });
  const host = fakeHost({ u1: [event("z")] });
  const store = createStore(host.stateDir);
  store.saveState({ version: 2, files: { u1: {} } });

  const tally = await report(host, store, config, [], { sweep: true });

  expect(tally.sent).toBe(1);
});

test("forgets a unit the adapter says is gone", async () => {
  globalThis.fetch = ok();
  const host = fakeHost({});
  const store = createStore(host.stateDir);
  store.saveState({ version: 2, files: { vanished: {} } });

  await report(host, store, config, [], { sweep: true });

  expect(store.loadState().files.vanished).toBeUndefined();
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test tests/report.test.js`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/core/report.mjs`**

Move `sweepTargets` (lines 528–560), `collect` (lines 562–572), `report` (lines 617–679) and `keyOf` (line 273) across, replacing every `fs.statSync` with `host.probe` and `readNewEvents` with `host.read`. Keep `MAX_SWEEP_FILES = 25` and `STATE_RETENTION_DAYS = 90` (lines 68–72), and keep the long comment explaining why the sweep exists — it is the record of a real bug.

`report` builds the upload context rather than importing constants:

```js
const { tally, failed } = await upload(
  { config, source: host.source, client: host.client, log: store.log },
  all,
);
```

and `collect` delegates the entry shape entirely:

```js
function collect(host, state, unit) {
  const { events, entry } = host.read(unit, state.files[unit] ?? {});
  if (entry === null) delete state.files[unit];
  else state.files[unit] = entry;
  return events;
}
```

While moving it, fix one stale sentence in that comment: it claims "the portal accepts events up to 400 days old". `MAX_EVENT_AGE_DAYS` in `llm-web` is **100**. Correct the number.

- [ ] **Step 8: Run it and watch it pass**

Run: `bun test tests/report.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 9: Rewrite `src/reporter.mjs` as the CLI**

What remains: argv parsing, host selection, `readHookInput`, `status`, and `main`. The argv parsing must change — today it is `args.find((a) => a.startsWith("--"))`, which would read `--host` as the command.

```js
const HOSTS = { "claude-code": claudeCode, antigravity };

function parseArgs(argv) {
  const out = { command: "--hook", host: "claude-code", days: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") { out.host = argv[++i] ?? out.host; continue; }
    if (arg === "--detach") continue;            // handled by scripts/run
    if (arg.startsWith("--")) { out.command = arg; continue; }
    if (/^\d+$/.test(arg)) out.days = Number(arg);
  }
  return out;
}
```

`main` then resolves `const host = HOSTS[args.host] ?? HOSTS["claude-code"]`, builds `const store = createStore(host.stateDir)` and `const config = loadConfig({ files: configFiles(store.configFile) })`, and dispatches exactly as before. `host.skipReason(config)` replaces the inline `alreadyMeteredByPortal` check. `status` prints `host.title`, the config file actually used (`config.source`), the SQLite backend when the host is `antigravity`, and `host.statusNotes(config)`.

- [ ] **Step 10: Verify the Claude Code path end to end, against the real state**

```bash
./scripts/run --status
```

Expected: the same shape of output as before this task, reporting the real transcript count and spool depth, with `status: ready`. Then, with a scratch HOME so nothing real is touched:

```bash
node --check src/reporter.mjs
bun test
```

Expected: `node --check` silent, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/core/report.mjs src/hosts/claude-code.mjs src/reporter.mjs tests/claude-code.test.js tests/report.test.js
git commit -m "refactor: split the reporting pass from what a host stores where"
```

---

### Task 7: The Antigravity adapter

**Files:**
- Create: `src/hosts/antigravity.mjs`
- Create: `tests/antigravity-host.test.js`
- Modify: `src/reporter.mjs` (register the host)

**Interfaces:**
- Consumes: `eventFromBlob` (Task 3), `readGenMetadata`/`sqliteBackend` (Task 2), the adapter shape (Task 6).
- Produces: `host` — the adapter, with `id: "antigravity"`, `source: "antigravity"`, `client: "antigravity-usage-reporter/0.3.0"`, `stateDir: ~/.gemini/jyl-usage`. Also `timestampsFor(dbFile) -> Map<number, string>`, exported for the test.

Entry shape for this host is `{ idx: number, mtimeMs: number }` — the highest `gen_metadata.idx` already reported, and the database mtime at that moment.

- [ ] **Step 1: Write the failing test**

`tests/antigravity-host.test.js`:

```js
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { host, timestampsFor } from "../src/hosts/antigravity.mjs";
import { bytes, msg, str, vint } from "./helpers/pb.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-agy-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const conversations = path.join(root, "conversations");
const brain = path.join(root, "brain");
fs.mkdirSync(conversations, { recursive: true });

function blob(idx) {
  const usage = msg(vint(1, 1318), vint(2, 100), vint(3, 30), vint(5, 200), vint(9, 10), vint(10, 20));
  return msg(bytes(1, msg(
    bytes(4, usage),
    str(19, "gemini-3.8-flash"),
    bytes(20, msg(str(1, "request_id"), str(2, `conv-${idx}`))),
  )));
}

function conversation(id, indices, steps = []) {
  const file = path.join(conversations, `${id}.db`);
  const db = new Database(file, { create: true });
  db.run("CREATE TABLE `gen_metadata` (`idx` integer, `data` blob, `size` integer NOT NULL DEFAULT 0, PRIMARY KEY (`idx`))");
  const insert = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
  for (const idx of indices) { const b = blob(idx); insert.run(idx, b, b.length); }
  db.close();

  const logs = path.join(brain, id, ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "transcript.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  return file;
}

test("reads new generations and stamps them from the transcript", () => {
  const file = conversation("c1", [3, 7], [
    { step_index: 3, type: "GENERIC", source: "MODEL", created_at: "2026-09-08T03:58:59Z" },
    { step_index: 7, type: "GENERIC", source: "MODEL", created_at: "2026-09-08T04:10:00Z" },
  ]);

  const { events, entry } = host.read(file, {});

  expect(events.map((e) => e.requestId)).toEqual(["conv-3", "conv-7"]);
  expect(events[0].ts).toBe("2026-09-08T03:58:59Z");
  expect(events[0].model).toBe("gemini-3.8-flash");
  expect(events[0].cacheReadTokens).toBe(200);
  expect(entry.idx).toBe(7);
});

test("reads nothing twice", () => {
  const file = conversation("c2", [1, 2], [
    { step_index: 1, created_at: "2026-09-08T03:00:00Z" },
    { step_index: 2, created_at: "2026-09-08T03:01:00Z" },
  ]);
  const first = host.read(file, {});
  expect(first.events).toHaveLength(2);
  expect(host.read(file, first.entry).events).toHaveLength(0);
});

test("falls back to the database mtime when the transcript has no such step", () => {
  const file = conversation("c3", [5], []);
  const event = host.read(file, {}).events[0];
  expect(Date.parse(event.ts)).toBeCloseTo(fs.statSync(file).mtimeMs, -3);
});

test("probe reports pending work only when the database has moved", () => {
  const file = conversation("c4", [1], [{ step_index: 1, created_at: "2026-09-08T03:00:00Z" }]);
  const stat = fs.statSync(file);
  expect(host.probe(file, { idx: 1, mtimeMs: stat.mtimeMs }).pending).toBe(0);
  expect(host.probe(file, { idx: 1, mtimeMs: stat.mtimeMs - 1000 }).pending).toBeGreaterThan(0);
  expect(host.probe(path.join(conversations, "gone.db"), {})).toBeNull();
});

test("a hook payload names its conversation database", () => {
  expect(host.unitsFromHook({ conversationId: "c1" })[0]).toMatch(/conversations\/c1\.db$/);
  expect(host.unitsFromHook({})).toEqual([]);
});

test("timestampsFor indexes the transcript by step", () => {
  conversation("c5", [], [{ step_index: 2, created_at: "2026-09-08T09:00:00Z" }]);
  expect(timestampsFor(path.join(conversations, "c5.db")).get(2)).toBe("2026-09-08T09:00:00Z");
});
```

The test needs the adapter's roots to be redirectable. Give `src/hosts/antigravity.mjs` a `roots` object it reads at call time, and let the test point it at the temp directory:

```js
import { host, roots } from "../src/hosts/antigravity.mjs";
roots.conversations = conversations;
roots.brain = brain;
```

Add those two lines at the top of the test, after the directories are created.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/antigravity-host.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/hosts/antigravity.mjs`**

```js
/**
 * Antigravity CLI → llm-web.
 *
 * `agy` records nothing about token spend where a reporter could simply read
 * it: the transcript it hands hooks carries steps and no counts, the logs carry
 * none, and `agentapi get-conversation-metadata` returns a title and some ids.
 * The only local copy is one protobuf blob per generation in
 * `conversations/<id>.db`, which is why this host reads SQLite while the Claude
 * Code host reads appended lines.
 *
 * The cursor is therefore a row index rather than a byte offset, and the mtime
 * rides along with it because a database's size says nothing about whether it
 * gained a row.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGenMetadata, sqliteBackend } from "../lib/sqlite.mjs";
import { eventFromBlob } from "./antigravity/extract.mjs";

const CLI_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");

/** Mutable so tests can point the adapter at a fixture tree. */
export const roots = {
  conversations: path.join(CLI_DIR, "conversations"),
  brain: path.join(CLI_DIR, "brain"),
};

const conversationId = (dbFile) => path.basename(dbFile, ".db");

/**
 * `gen_metadata.idx` is the same sequence as the transcript's `step_index` —
 * both tables in the database are keyed on it, and a generation at idx 40 is
 * step 40 in `transcript.jsonl`, whose `created_at` is the only real timestamp
 * on offer. Confirmed against agy 2.12.0.
 */
export function timestampsFor(dbFile) {
  const file = path.join(roots.brain, conversationId(dbFile), ".system_generated", "logs", "transcript.jsonl");
  const out = new Map();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line);
      if (typeof step.step_index === "number" && typeof step.created_at === "string") {
        out.set(step.step_index, step.created_at);
      }
    } catch {
      /* a half-written line is skipped, not fatal */
    }
  }
  return out;
}

export const host = {
  id: "antigravity",
  source: "antigravity",
  client: "antigravity-usage-reporter/0.3.0",
  title: "jyl-usage — Antigravity CLI → llm-web usage reporter",
  unitLabel: "conversation",
  stateDir: path.join(os.homedir(), ".gemini", "jyl-usage"),

  unitsFromHook(hook) {
    const id = typeof hook.conversationId === "string" ? hook.conversationId : null;
    return id ? [path.join(roots.conversations, `${id}.db`)] : [];
  },

  recentUnits(days) {
    const cutoff = Date.now() - days * 86_400_000;
    let names;
    try {
      names = fs.readdirSync(roots.conversations);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".db")) continue;
      const full = path.join(roots.conversations, name);
      try {
        if (fs.statSync(full).mtimeMs >= cutoff) out.push(full);
      } catch {
        /* vanished mid-walk */
      }
    }
    return out;
  },

  probe(unit, entry) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return null;
    }
    return { mtimeMs: stat.mtimeMs, pending: stat.mtimeMs > (entry.mtimeMs ?? 0) ? 1 : 0 };
  },

  read(unit, entry) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return { events: [], entry: null };
    }
    const after = Number.isFinite(entry.idx) ? entry.idx : -1;
    const rows = readGenMetadata(unit, after);
    if (rows === null) return { events: [], entry }; // no sqlite backend; try again later
    if (rows.length === 0) return { events: [], entry: { idx: after, mtimeMs: stat.mtimeMs } };

    const stamps = timestampsFor(unit);
    const fallback = new Date(stat.mtimeMs).toISOString();
    const events = [];
    let highest = after;
    for (const row of rows) {
      highest = Math.max(highest, row.idx);
      const event = eventFromBlob(row.data, { ts: stamps.get(row.idx) ?? fallback });
      if (event) events.push(event);
    }
    return { events, entry: { idx: highest, mtimeMs: stat.mtimeMs } };
  },

  // `agy` cannot be pointed at the portal — it speaks Google's Code Assist
  // protocol, which `/v1` does not serve — so there is no double-counting to
  // guard against here.
  skipReason: () => null,

  statusNotes: () =>
    sqliteBackend()
      ? [`  sqlite backend:        ${sqliteBackend()}`]
      : ["", "  NOTE: no sqlite backend (bun:sqlite, node:sqlite or the sqlite3 binary)", "        is available, so nothing can be read."],
};
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test tests/antigravity-host.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register the host and check `--status` against real data**

Add `antigravity` to the `HOSTS` map in `src/reporter.mjs`, then:

```bash
./scripts/run --host antigravity --status
```

Expected: the Antigravity heading, the config it found, the sqlite backend, and a count of tracked conversations (zero on the first run). It must **not** upload anything.

- [ ] **Step 6: Commit**

```bash
git add src/hosts/antigravity.mjs src/reporter.mjs tests/antigravity-host.test.js
git commit -m "feat(agy): report Antigravity CLI conversations to the portal"
```

---

### Task 8: The `agy` plugin — manifest, hook, launcher, skill

**Files:**
- Create: `plugin.json` (repo root)
- Create: `hooks.json` (repo root)
- Create: `skills/jyl-usage/SKILL.md`
- Modify: `scripts/run`

**Interfaces:**
- Consumes: `src/reporter.mjs --host antigravity`.
- Produces: an installable `agy` plugin. Nothing imports this.

- [ ] **Step 1: Write the `agy` manifest**

`plugin.json` at the repository root. `agy`'s documentation states `name` is the only field and is optional; anything else is unproven, which Step 6 tests.

```json
{
  "name": "jyl-usage",
  "description": "Reports Antigravity CLI token usage to the JianyueLab LLM portal. Counts only."
}
```

- [ ] **Step 2: Write the hook**

`hooks.json` at the repository root. `Stop` takes a **flat** list of handlers — the `matcher`/`hooks` wrapper is only for the two tool events, and using it here would silently register nothing.

```json
{
  "jyl-usage": {
    "Stop": [
      {
        "type": "command",
        "command": "./scripts/run --host antigravity --detach",
        "timeout": 10
      }
    ]
  }
}
```

- [ ] **Step 3: Teach `scripts/run` to detach**

`agy` hooks block the agent loop and there is no `async` flag, so the launcher must return immediately. Three details are load-bearing:

1. The hook payload arrives on **stdin**, and the parent has to read it before the child can — so it is read here and piped in.
2. The child must not inherit the hook's stdout. `agy` parses that stream as the `Stop` decision and waits for it to close; a background process holding it open would hang the agent for the full timeout.
3. `{}` is printed, never `{"decision": "continue"}` — the latter would refuse to let the agent stop.

Insert before the runtime selection in `scripts/run`:

```sh
# Detached mode, for hosts whose hooks block the agent loop (agy). The payload
# is read here because the child cannot: this process owns stdin.
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
  PAYLOAD=$(cat 2>/dev/null || true)
  # shellcheck disable=SC2086
  ( printf '%s' "$PAYLOAD" | "$0" $ARGS >/dev/null 2>&1 & ) </dev/null >/dev/null 2>&1
  printf '{}\n'
  exit 0
fi
```

- [ ] **Step 4: Write the skill**

`skills/jyl-usage/SKILL.md` — `agy` surfaces a plugin's skills the way Claude Code surfaces its commands, so this is the counterpart of `commands/jyl-usage.md` with the same three verbs and the same refusal to touch the config file.

```markdown
---
name: jyl-usage
description: Inspect or drive the JianyueLab usage reporter for the Antigravity CLI (status, flush, backfill)
---

Run the reporter's CLI and report what it says. The script is `./scripts/run`
inside this plugin's directory; every invocation needs `--host antigravity`.

| Ask | Command |
|---|---|
| status (default) | `./scripts/run --host antigravity --status` |
| retry queued uploads | `./scripts/run --host antigravity --flush` |
| rescan recent conversations | `./scripts/run --host antigravity --backfill 30` |

Summarise the output in a sentence or two. If it says it is not reporting:

- **no base URL / no API key** — export `JYL_USAGE_BASE_URL` (the portal
  origin, *not* its `/v1` base) and `JYL_API_KEY`, or write
  `~/.config/jyl-usage/config.json`:

  ```json
  { "baseUrl": "https://llm.jianyuelab.net", "apiKey": "jyl-…" }
  ```

- **disabled** — `"enabled": false` in that file, or `JYL_USAGE_DISABLED=1`.
- **no sqlite backend** — the reporter needs `bun`, a Node with `node:sqlite`,
  or the `sqlite3` binary on `PATH`.

Do not edit the config file unless asked; it holds a secret.
```

- [ ] **Step 5: Verify the detach path by hand**

```bash
echo '{"conversationId":"nonexistent"}' | ./scripts/run --host antigravity --detach
```

Expected: prints exactly `{}`, returns immediately (well under a second), and leaves no child holding the terminal. Then confirm the child actually ran:

```bash
tail -3 ~/.gemini/jyl-usage/log
```

Expected: a line from the run, or no file at all if the plugin is unconfigured — an unconfigured plugin is silent by design.

- [ ] **Step 6: Validate the plugin against `agy` itself**

```bash
agy plugin validate .
```

Expected: it accepts the directory. If it rejects `description` in `plugin.json`, reduce the manifest to `{"name": "jyl-usage"}` and note it in the commit body — this is spec open item 2.

Then install and confirm the hook is registered:

```bash
agy plugin install "$PWD"
agy plugin list
```

Expected: `jyl-usage` is listed and enabled. If `install` will not take a path, record what it does want; that is spec open item 1, and the README in Task 9 must document whatever actually works.

- [ ] **Step 7: Confirm Claude Code still loads its own manifest**

The two manifests share a directory, and `skills/` is read by both hosts.

```bash
ls .claude-plugin/plugin.json plugin.json hooks/hooks.json hooks.json skills/jyl-usage/SKILL.md
```

Then, in a Claude Code session with the plugin installed from this checkout, run `/jyl-usage` and confirm it still answers. If the new `skills/jyl-usage/` collides with the `/jyl-usage` command, rename the directory to `skills/jyl-usage-report/` and update the skill's front-matter `name`.

- [ ] **Step 8: Commit**

```bash
git add plugin.json hooks.json skills scripts/run
git commit -m "feat(agy): ship the agy plugin manifest, Stop hook and skill"
```

---

### Task 9: Documentation and versions

**Files:**
- Modify: `README.md`
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

**Interfaces:** none.

- [ ] **Step 1: Bump the versions**

`0.2.0` → `0.3.0` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. The `client` strings in both adapters already say `0.3.0`; confirm they match.

- [ ] **Step 2: Rewrite the README for two hosts**

Keep the existing structure and add, without deleting anything that still holds:

- A first paragraph saying the repository is one plugin for two hosts, Claude Code and the Antigravity CLI, sharing one reporter.
- An **Install (Antigravity CLI)** section with whatever Task 8 Step 6 established actually works.
- The shared config path `~/.config/jyl-usage/config.json`, noting that the environment still wins and that `~/.claude/jyl-usage/config.json` keeps working.
- A short **How it works (agy)** block, mirroring the existing one:

  ```
  agy turn ends
    └─ Stop hook (blocking!) → scripts/run --detach → prints {} and forks
          reads conversations/<id>.db rows after the recorded idx
          walks each generation blob for model, request id and counts
          POST <portal>/v1/usage/ingest  { source: "antigravity", events: [...] }
  ```

- Under *Things worth knowing*, three new entries: that `agy`'s hooks block so the work is detached; that the field mapping is inferred and guarded by an invariant, so drift under-reports rather than misreports; and that reporting needs `source: "antigravity"` on the portal side.
- A note that `~/.gemini/jyl-usage/` is the Antigravity state directory, with the same file table as the Claude Code one.

- [ ] **Step 3: Verify the README's commands actually run**

Run every command the README tells a reader to run, and fix the text where reality differs:

```bash
./scripts/run --status
./scripts/run --host antigravity --status
bun test
```

- [ ] **Step 4: Commit**

```bash
git add README.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs: one repo, two hosts"
```

---

### Task 10: The portal side (`llm-web`)

A different repository, a different branch, a different PR. **Deploy this before announcing the plugin:** until it lands, the ingest route rejects `antigravity` with a 400, which the reporter classifies as unfixable and drops.

**Files:**
- Modify: `/Users/jhl/Documents/Dev/JianyueLab/llm-web/src/server/ingest.ts:57`
- Modify: wherever a source is given a human label (find them with the grep in Step 2)
- Modify: the matching test file under `llm-web`

**Interfaces:**
- Produces: `INGEST_SOURCES` including `"antigravity"`.

- [ ] **Step 1: Branch**

```bash
cd /Users/jhl/Documents/Dev/JianyueLab/llm-web
git fetch origin && git checkout -b feat/ingest-antigravity origin/main
```

- [ ] **Step 2: Find every place a source is named**

```bash
grep -rn "grok-build" src/ --include=*.ts --include=*.tsx
```

Expected: `src/server/ingest.ts` plus any display label. Every hit is a place `antigravity` has to be added.

- [ ] **Step 3: Write the failing test**

Add to the existing ingest test file (find it with `ls src/server/*.test.ts` or `grep -rln "INGEST_SOURCES" src/`):

```ts
test("accepts antigravity as a source", () => {
  expect(INGEST_SOURCES).toContain("antigravity");
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `bun test -t "antigravity"`
Expected: FAIL.

- [ ] **Step 5: Add the source**

`src/server/ingest.ts:57`:

```ts
export const INGEST_SOURCES = ["claude-code", "grok-build", "antigravity"] as const;
```

Then update the comment three lines above it, which enumerates the reporters, to mention the Antigravity CLI alongside Claude Code and Grok Build. Add the display label at every other hit from Step 2.

- [ ] **Step 6: Run the tests and the type-check**

```bash
bun test
bun run typecheck
```

Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/server/ingest.ts
git commit -m "feat(ingest): accept usage reported by the Antigravity CLI"
```

- [ ] **Step 8: Check the model catalogue**

`gemini-3.8-flash` is not in `src/server/model-catalog.ts`. Confirm what the first report will do — create an unpriced `model_prices` row — and tell the user, so an admin can price it before the first week of Antigravity usage shows as free. Do not invent a price.

---

### Task 11: End-to-end verification

Nothing is claimed working until this passes. No code changes.

- [ ] **Step 1: Confirm the whole suite is green**

```bash
cd /Users/jhl/Documents/Dev/JianyueLab/claude-plugin
bun test
node --check src/reporter.mjs
```

- [ ] **Step 2: Report one real conversation, with the portal reachable**

With `llm-web` running the Task 10 change (locally or deployed) and the config in place:

```bash
./scripts/run --host antigravity --backfill 7
```

Expected: a line naming how many conversations were scanned and how many events were accepted. Then confirm the portal agrees — the events should appear under `source = 'antigravity'`.

- [ ] **Step 3: Confirm it is idempotent**

```bash
./scripts/run --host antigravity --backfill 7
```

Expected: the same events come back as **duplicates**, not as newly accepted ones, and nothing is spooled.

- [ ] **Step 4: Confirm the hook path costs nothing**

Run a short `agy` turn, then:

```bash
tail -5 ~/.gemini/jyl-usage/log
```

Expected: a report line from the `Stop` hook, and no perceptible pause at the end of the turn.

- [ ] **Step 5: Confirm the Claude Code path is untouched**

```bash
./scripts/run --status
```

Expected: still ready, still tracking the same transcripts, spool not grown.

- [ ] **Step 6: Report the result honestly**

State which of the spec's five open items are now closed, and which remain — in particular, whether Step 2 confirmed the field mapping against portal-side numbers or merely that events were accepted.
