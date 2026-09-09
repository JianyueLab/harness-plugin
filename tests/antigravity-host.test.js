import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { host, roots, timestampsFor } from "../src/hosts/antigravity.mjs";
import { bytes, msg, str, vint } from "./helpers/pb.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-agy-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const conversations = path.join(root, "conversations");
const brain = path.join(root, "brain");
fs.mkdirSync(conversations, { recursive: true });
fs.mkdirSync(brain, { recursive: true });

roots.conversations = conversations;
roots.brain = brain;

function blob(idx) {
  const usage = msg(vint(1, 1318), vint(2, 100), vint(3, 30), vint(5, 200), vint(9, 10), vint(10, 20));
  return msg(bytes(1, msg(
    bytes(4, usage),
    str(19, "gemini-3.8-flash"),
    bytes(20, msg(str(1, "request_id"), str(2, `conv-${idx}`))),
  )));
}

/**
 * A row the field mapping cannot read: field 12 is outside the known set, so
 * the unknown-field guard rejects it — exactly the drift this reporter exists
 * to catch, not to hide.
 */
function badBlob(idx) {
  const usage = msg(vint(1, 1318), vint(2, 100), vint(3, 30), vint(5, 200), vint(9, 10), vint(10, 20), vint(12, 999));
  return msg(bytes(1, msg(
    bytes(4, usage),
    str(19, "gemini-3.8-flash"),
    bytes(20, msg(str(1, "request_id"), str(2, `conv-${idx}`))),
  )));
}

function conversation(id, indices, steps = [], blobFn = blob) {
  const file = path.join(conversations, `${id}.db`);
  const db = new Database(file, { create: true });
  db.run("CREATE TABLE `gen_metadata` (`idx` integer, `data` blob, `size` integer NOT NULL DEFAULT 0, PRIMARY KEY (`idx`))");
  const insert = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
  for (const idx of indices) { const b = blobFn(idx); insert.run(idx, b, b.length); }
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
  // Days in the past, not "moments ago" — a fixture created just before the
  // assertion would let a regression to `new Date().toISOString()` pass too.
  const past = Date.now() - 5 * 86_400_000;
  fs.utimesSync(file, past / 1000, past / 1000);
  const stat = fs.statSync(file);

  const event = host.read(file, {}).events[0];

  expect(Date.parse(event.ts)).toBeCloseTo(stat.mtimeMs, -3);
  expect(Date.now() - Date.parse(event.ts)).toBeGreaterThan(4 * 86_400_000);
});

test("probe reports pending work only when the database has moved", () => {
  const file = conversation("c4", [1], [{ step_index: 1, created_at: "2026-09-08T03:00:00Z" }]);
  const stat = fs.statSync(file);
  expect(host.probe(file, { idx: 1, mtimeMs: stat.mtimeMs }).pending).toBe(0);
  expect(host.probe(file, { idx: 1, mtimeMs: stat.mtimeMs - 1000 }).pending).toBeGreaterThan(0);
  expect(host.probe(path.join(conversations, "gone.db"), {})).toBeNull();
});

test("describePending phrases pending conversations honestly, not as bytes", () => {
  expect(host.describePending(3, 3)).toBe("3 conversation(s) with new generations");
  expect(host.describePending(0, 0)).toBe("0 conversation(s) with new generations");
});

test("a hook payload names its conversation database", () => {
  expect(host.unitsFromHook({ conversationId: "c1" })[0]).toMatch(/conversations\/c1\.db$/);
  expect(host.unitsFromHook({})).toEqual([]);
});

test("timestampsFor indexes the transcript by step", () => {
  conversation("c5", [], [{ step_index: 2, created_at: "2026-09-08T09:00:00Z" }]);
  expect(timestampsFor(path.join(conversations, "c5.db")).get(2)).toBe("2026-09-08T09:00:00Z");
});

// --- guard failures must be counted and logged, never silent ---------------
//
// The whole safety argument for an inferred field mapping is that a future
// `agy` renumbering its fields produces *visible* under-reporting, not
// invisible wrong numbers. That visibility has to survive contact with a real
// conversation whose rows all fail a guard, not just exist in a comment.

test("counts and logs rows the field mapping cannot read, without leaking anything but numbers", () => {
  const file = conversation("c6", [1, 2, 3], [], badBlob);
  const logged = [];

  const { events, entry } = host.read(file, {}, (line) => logged.push(line));

  expect(events).toHaveLength(0);
  expect(entry.skipped).toBe(3);
  expect(logged).toEqual([
    "agy: skipped 3 of 3 generation(s) in one conversation; the field mapping may have drifted",
  ]);
  // Only counts leave the machine: no conversation id, no path, no blob content.
  expect(logged[0]).not.toContain("c6");
  expect(logged[0]).not.toContain(file);
});

test("logs nothing, and counts nothing skipped, when every row extracts cleanly", () => {
  const file = conversation("c7", [1, 2], [
    { step_index: 1, created_at: "2026-09-08T03:00:00Z" },
    { step_index: 2, created_at: "2026-09-08T03:01:00Z" },
  ]);
  const logged = [];

  const { events, entry } = host.read(file, {}, (line) => logged.push(line));

  expect(events).toHaveLength(2);
  expect(entry.skipped).toBe(0);
  expect(logged).toHaveLength(0);
});

test("the skip count is cumulative across reads, so a slow drip of bad rows still adds up", () => {
  const file = conversation("c8", [1], [], badBlob);
  const first = host.read(file, {}, () => {});
  expect(first.entry.skipped).toBe(1);

  // A second bad row lands later, at idx 2.
  const db = new Database(file);
  const b = badBlob(2);
  db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)").run(2, b, b.length);
  db.close();

  const second = host.read(file, first.entry, () => {});
  expect(second.entry.skipped).toBe(2);
});
