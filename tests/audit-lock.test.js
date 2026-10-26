import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const scratch = path.resolve(import.meta.dir, "../../.temp/audit-fixes-2026-10-26/GatewayReporter");
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, "lock-regression-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const storeUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/core/store.mjs")).href;

test("HP-006: descheduled stale observer cannot unlink a replacement owner's lock", async () => {
  const lock = path.join(root, "lock");
  const log = path.join(root, "holders.jsonl");
  const marker = path.join(root, "observed");
  fs.writeFileSync(lock, "dead-pid");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  const worker = path.join(root, "worker.mjs");
  fs.writeFileSync(worker, `import fs from "node:fs";
import { createStore } from ${JSON.stringify(storeUrl)};
const [dir, mode, marker, log] = process.argv.slice(2);
const realStat = fs.statSync;
let delayed = false;
fs.statSync = function(file, ...args) {
  const value = realStat.call(this, file, ...args);
  if (!delayed && String(file) === dir + "/lock" && Date.now() - value.mtimeMs > 60000 && mode === "slow") {
    delayed = true;
    fs.writeFileSync(marker, "observed");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  }
  return value;
};
await createStore(dir).withLock(async () => {
  fs.appendFileSync(log, JSON.stringify({ enter: process.pid }) + "\\n");
  await new Promise(r => setTimeout(r, mode === "slow" ? 200 : 1000));
  fs.appendFileSync(log, JSON.stringify({ exit: process.pid }) + "\\n");
});
`);
  const launch = (mode) => {
    const child = spawn("node", [worker, root, mode, marker, log], { stdio: ["ignore", "pipe", "pipe"] });
    return new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))); });
  };
  const a = launch("slow");
  // The replacement algorithm need not inspect the legacy stale lock at all.
  // Give the old implementation time to pause at its stat->unlink window.
  const until = Date.now() + 750;
  while (!fs.existsSync(marker) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  const b = launch("fast");
  await Promise.all([a, b]);
  let holders = 0, maximum = 0;
  for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
    const event = JSON.parse(line);
    holders += event.enter ? 1 : -1;
    maximum = Math.max(maximum, holders);
  }
  expect(maximum).toBe(1);
  expect(holders).toBe(0);
}, 10_000);
