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
