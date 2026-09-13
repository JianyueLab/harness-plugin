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
  // Cache reads have their own field; only input + cache *creation* count as
  // fresh input. Verified writable against the live API in Task 8 — the
  // earlier "WakaTime has no field for this" reason was wrong.
  expect(run.ai_input_tokens).toBe(12043 + 0);
  expect(run.ai_cached_input_tokens).toBe(11800);

  // A run that edits five files must not report its tokens five times.
  expect(file.ai_input_tokens).toBeUndefined();
  expect(file.ai_cached_input_tokens).toBeUndefined();
  expect(file.ai_session).toBeUndefined();
});

// The fixture has cache_creation_input_tokens = 0, so it cannot tell the two
// input counters apart from the cached one: summing all three, or moving
// creation into the cached field, both still produce 12043 / 11800 there. Three
// distinct non-zero values is the only shape that pins which counter goes
// where, and it is exactly the case the old "sum all three" behaviour got
// wrong.
test("cache creation counts as fresh input; only cache reads are cached", () => {
  const beats = heartbeatsFrom(
    {
      ...payload,
      usage: {
        input_tokens: 100,
        output_tokens: 7,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 300,
      },
    },
    opts,
  );
  const run = beats.find((b) => b.type === "app");
  expect(run.ai_input_tokens).toBe(120);
  expect(run.ai_cached_input_tokens).toBe(300);
  expect(run.ai_output_tokens).toBe(7);
  // Nothing is lost or double-counted: the two fields still total what the
  // single folded field used to report.
  expect(run.ai_input_tokens + run.ai_cached_input_tokens).toBe(100 + 20 + 300);
});

test("a missing usage object leaves both input fields at zero, not NaN", () => {
  const run = heartbeatsFrom({ ...payload, usage: undefined }, opts).find((b) => b.type === "app");
  expect(run.ai_input_tokens).toBe(0);
  expect(run.ai_cached_input_tokens).toBe(0);
  expect(run.ai_output_tokens).toBe(0);
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

// Final review M-5: the obfuscated entity keeps the extension, and nothing
// asserted it -- mutating `obfuscate` to always return "HIDDEN" left all 187
// tests green while both README ("`agent.go` becomes `HIDDEN.go`") and spec
// ("keep the extension so language stats survive") quietly became false.
// hide_file_names users would lose every language attribution and see no error.
test("hide_file_names keeps the extension, and the language still comes from the real path", () => {
  const beats = heartbeatsFrom(
    {
      ...payload,
      tools: [
        { name: "read_file", path: "/abs/agent/agent.go", at: 1, elapsed_ms: 1, is_error: false },
        { name: "read_file", path: "/abs/agent/Makefile", at: 2, elapsed_ms: 1, is_error: false },
      ],
    },
    { ...opts, hideFileNames: true },
  );
  const files = beats.filter((b) => b.type === "file");

  expect(files[0].entity).toBe("HIDDEN.go");
  expect(files[0].language).toBe("Go"); // language is read off the real path, before hiding
  // Nothing to keep: a name with no extension obfuscates to the bare placeholder
  // rather than to something like "HIDDEN.agent/Makefile".
  expect(files[1].entity).toBe("HIDDEN");
});

test("an unknown extension omits language rather than guessing", () => {
  const odd = { ...payload, tools: [{ name: "read_file", path: "/a/b/thing.zzz", at: 1, elapsed_ms: 1, is_error: false }] };
  const file = heartbeatsFrom(odd, opts).find((b) => b.type === "file");
  expect("language" in file).toBe(false);
});

test("a null element in tools does not throw and does not block real entries", () => {
  // "tools": [null, {...}] is valid JSON. A run that hits this must not lose
  // every heartbeat in the batch just because one entry was malformed.
  const withNull = {
    ...payload,
    tools: [null, { name: "read_file", path: "/abs/agent/agent.go", at: 1, elapsed_ms: 1, is_error: false }],
  };
  const beats = heartbeatsFrom(withNull, opts);
  const files = beats.filter((b) => b.type === "file");
  expect(files).toHaveLength(1);
  expect(files[0].entity).toBe("/abs/agent/agent.go");
});

test("the same file inside 120s is sent once; a write always goes", () => {
  const state = {};
  // `t` is the beat's own moment in ms; the helper stores it as `time` in
  // seconds, matching harness's payload, since throttle() now judges each
  // beat by its own `time` rather than the batch's `nowMs`.
  const read = (t) => ({ entity: "/a.go", type: "file", time: t / 1000, is_write: false });
  const write = (t) => ({ entity: "/a.go", type: "file", time: t / 1000, is_write: true });

  expect(throttle([read(0)], state, 0)).toHaveLength(1);
  expect(throttle([read(30_000)], state, 30_000)).toHaveLength(0);       // inside the window
  expect(throttle([write(40_000)], state, 40_000)).toHaveLength(1);      // writes are never throttled
  // The write above refreshed seen["/a.go"] to 40_000 (from its own `time`),
  // so the window is measured from there: 40_000 + THROTTLE_MS + 1_000 is
  // just past it.
  expect(throttle([read(40_000 + THROTTLE_MS + 1_000)], state, 40_000 + THROTTLE_MS + 1_000)).toHaveLength(1); // window expired
});

test("throttle judges each beat by its own time, not the batch's nowMs", () => {
  const state = {};
  const apartMs = THROTTLE_MS + 1_000; // > 120s apart
  const beats = [
    { entity: "/a.go", type: "file", time: 0, is_write: false },
    { entity: "/a.go", type: "file", time: apartMs / 1000, is_write: false },
  ];
  // Both beats arrive in one throttle() call — one nowMs for the whole batch —
  // but their own `time`s are more than 120s apart. Judging every beat in a
  // call against a single shared clock reading would throw the second one
  // away; per-beat time must not.
  expect(throttle(beats, state, apartMs)).toHaveLength(2);
});

test("two app heartbeats close together both survive; the 120s rule is file-only", () => {
  const state = {};
  // Two runs finishing under two minutes apart is the ordinary case, not an
  // edge case. Each app beat carries that run's own token counts, so the
  // second one must not be dropped just because it shares the app's static
  // entity ("harness") and lands inside what would be the file-throttle
  // window -- the 120s rule does not apply to `app` beats at all.
  const beats = [
    { entity: "harness", type: "app", time: 0, is_write: false },
    { entity: "harness", type: "app", time: 60, is_write: false }, // 60s later
  ];
  expect(throttle(beats, state, 60_000)).toHaveLength(2);
});

test("a beat with no time falls back to the batch's nowMs", () => {
  const state = {};
  const beats = [{ entity: "/a.go", type: "file", time: undefined, is_write: false }];
  expect(throttle(beats, state, 5_000)).toHaveLength(1);
  expect(state.wakatimeSeen["/a.go"]).toBe(5_000);
});

test("entities unseen for over a day are pruned from state", () => {
  const state = {};
  const dayMs = 25 * 3600 * 1000;
  throttle([{ entity: "/old.go", type: "file", time: 0, is_write: false }], state, 0);
  expect(Object.keys(state.wakatimeSeen)).toContain("/old.go");

  // "/new.go"'s own `time` lines up with the batch's `nowMs` here (both 25h
  // in) so it reads as freshly seen, not as stale as "/old.go" — otherwise
  // the very call that adds it would immediately prune it right back out.
  throttle([{ entity: "/new.go", type: "file", time: dayMs / 1000, is_write: false }], state, dayMs);
  expect(Object.keys(state.wakatimeSeen)).not.toContain("/old.go");
  expect(Object.keys(state.wakatimeSeen)).toContain("/new.go");
});
