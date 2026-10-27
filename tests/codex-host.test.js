import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { host, roots } from "../src/hosts/codex.mjs";
import { rollout, meta, turnCtx, tokenCount, usage } from "./helpers/rollout.js";

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-codex-"));
  roots.sessions = path.join(dir, "sessions");     // 绝不碰真实 home
  fs.mkdirSync(path.join(roots.sessions, "2026", "09", "14"), { recursive: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (id, lines) => {
  const file = path.join(roots.sessions, "2026", "09", "14", `rollout-2026-09-14T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, rollout(lines));
  return file;
};

test("unitsFromHook globs the rollout file by session_id", () => {
  const file = write("aaaa-1111", [meta("aaaa-1111")]);
  expect(host.unitsFromHook({ session_id: "aaaa-1111" })).toEqual([file]);
});

test("unitsFromHook returns nothing when the payload has no session_id", () => {
  expect(host.unitsFromHook({})).toEqual([]);
});

test("read advances the byte offset and only consumes whole lines", () => {
  const file = write("bbbb", [meta("bbbb"), turnCtx("gpt-5.5"), tokenCount(usage(100, 0, 20), usage(100, 0, 20))]);
  const first = host.read(file, {});
  expect(first.events).toHaveLength(1);
  expect(first.entry.offset).toBe(fs.statSync(file).size);

  fs.appendFileSync(file, JSON.stringify(tokenCount(usage(300, 0, 60), usage(200, 0, 40))) + "\n");
  const second = host.read(file, first.entry);
  expect(second.events).toHaveLength(1);
  expect(second.events[0].inputTokens).toBe(200);
});

test("a bounded read keeps Codex ordinal and cumulative baseline for the next pass", () => {
  const file = write("bounded", [
    meta("bounded"), turnCtx("gpt-5.5"),
    tokenCount(usage(100, 0, 20), usage(100, 0, 20)),
    tokenCount(usage(300, 0, 60), usage(200, 0, 40)),
  ]);
  const first = host.read(file, {}, undefined, 1);
  expect(first.events.map((event) => event.requestId)).toEqual(["codex:bounded:0"]);
  expect(host.probe(file, first.entry).pending).toBeGreaterThan(0);
  const second = host.read(file, first.entry, undefined, 1);
  expect(second.events[0]).toMatchObject({ requestId: "codex:bounded:1", inputTokens: 200, outputTokens: 40 });
  expect(host.probe(file, second.entry).pending).toBe(0);
});

test("a partial trailing line is not consumed", () => {
  const file = write("cccc", [meta("cccc"), turnCtx("gpt-5.5")]);
  const whole = fs.statSync(file).size;                            // 完整行的字节数
  fs.appendFileSync(file, '{"timestamp":"2026-09-14T00:00:0');     // 半行
  const { entry } = host.read(file, {});
  expect(entry.offset).toBe(whole);                                // 不要硬编半行长度
});

test("a file that shrank resets offset, ordinal AND the diff baseline together", () => {
  // 只重置 offset 会让重读的首条与旧基准做差 → 负差分 → 白记一行日志
  const file = write("dddd", [meta("dddd"), turnCtx("gpt-5.5"), tokenCount(usage(500, 0, 100), usage(500, 0, 100))]);
  const first = host.read(file, {});
  expect(first.events[0].inputTokens).toBe(500);

  write("dddd", [meta("dddd"), turnCtx("gpt-5.5"), tokenCount(usage(70, 0, 14), usage(70, 0, 14))]);
  const second = host.read(file, first.entry);
  expect(second.events).toHaveLength(1);
  expect(second.events[0].inputTokens).toBe(70);
  expect(second.events[0].requestId).toBe("codex:dddd:0");
});

test("a second read whose new lines carry no session_meta still reports", () => {
  // session_meta/turn_context 只在文件开头。不把 model/sessionId/provider 存进 entry,
  // 第一次读正常、之后每次都把事件全丢掉,而 --status 只显示"没有新用量"。
  const file = write("ffff", [meta("ffff"), turnCtx("gpt-5.5"), tokenCount(usage(100, 0, 20), usage(100, 0, 20))]);
  const first = host.read(file, {});
  fs.appendFileSync(file, JSON.stringify(tokenCount(usage(300, 0, 60), usage(200, 0, 40))) + "\n");
  const second = host.read(file, first.entry);
  expect(second.events).toHaveLength(1);
  expect(second.events[0].model).toBe("gpt-5.5");
  expect(second.events[0].requestId).toBe("codex:ffff:1");
});

test("probe reports nothing pending when the file has not grown", () => {
  const file = write("eeee", [meta("eeee")]);
  const entry = { mtimeMs: fs.statSync(file).mtimeMs, offset: fs.statSync(file).size };
  expect(host.probe(file, entry).pending).toBe(0);
});

test("probe returns null for a file that is gone", () => {
  expect(host.probe(path.join(roots.sessions, "nope.jsonl"), {})).toBeNull();
});

test("skipReason is always null — the portal check is per session, in read()", () => {
  expect(host.skipReason({ baseUrl: "https://llm.jianyuelab.net" })).toBeNull();
});

test("the host object satisfies the contract", () => {
  for (const key of ["id", "source", "client", "title", "unitLabel", "stateDir",
                     "unitsFromHook", "recentUnits", "probe", "read", "skipReason", "statusNotes"]) {
    expect(host[key]).toBeDefined();
  }
});
