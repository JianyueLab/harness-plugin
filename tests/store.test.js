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
  expect(store.loadState()).toEqual({ version: 2 });
  store.saveState({ version: 2, wakatimeAuthFailures: 3 });
  expect(store.loadState().wakatimeAuthFailures).toBe(3);
});

test("existing WakaTime state is retained", () => {
  const store = fresh("existing");
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(
    path.join(store.dir, "state.json"),
    JSON.stringify({ version: 2, files: {}, wakatimeSeen: { "/a.go": 123 }, wakatimeLastSend: { accepted: 1 } }),
  );

  expect(store.loadState().wakatimeSeen).toEqual({ "/a.go": 123 });
  expect(store.loadState().wakatimeLastSend).toEqual({ accepted: 1 });
});

test("the spool round-trips and clears", () => {
  const store = fresh("spool");
  store.writeSpool([{ requestId: "a" }, { requestId: "b" }]);
  expect(store.readSpool().map((e) => e.requestId)).toEqual(["a", "b"]);
  store.writeSpool([]);
  expect(store.readSpool()).toEqual([]);
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

test("a stale lock can be reclaimed, and a replaced lock is never removed by the old owner", async () => {
  const store = fresh("stale-lock");
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(store.lockFile, "dead-pid");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(store.lockFile, old, old);

  expect(await store.withLock(async () => {})).toBe(true);
  expect(fs.existsSync(store.lockFile)).toBe(false);

  await store.withLock(async () => {
    fs.unlinkSync(store.lockFile);
    fs.writeFileSync(store.lockFile, "new-owner");
  });
  expect(fs.readFileSync(store.lockFile, "utf8")).toBe("new-owner");
  fs.unlinkSync(store.lockFile);
});

test("two stores in different directories do not share anything", () => {
  const a = fresh("hostA");
  const b = fresh("hostB");
  a.writeSpool([{ entity: "/only-a.go" }]);
  expect(b.readSpool()).toEqual([]);
});
