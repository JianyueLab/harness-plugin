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
