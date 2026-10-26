import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const scratch = path.resolve(import.meta.dir, "../../.temp/audit-fixes-2026-10-26/GatewayReporter");
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, "choosing-race-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("HP-006: disappearing choosing entry cannot admit two stale-lock reclaimers", async () => {
  const lock = path.join(root, "lock");
  fs.writeFileSync(lock, "dead-pid");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  const start = () => {
    const child = spawn("node", [path.join(import.meta.dir, "helpers/lock-choosing-race.worker.mjs"), root], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = Promise.withResolvers();
    child.once("error", done.reject);
    child.once("close", (code) => done.resolve({ code, stdout, stderr }));
    return { child, done: done.promise };
  };
  const first = start(), second = start();
  try {
    const ordered = [first.child.pid, second.child.pid].sort((a, b) => `${a}-` < `${b}-` ? -1 : 1);
    // B has priority when both publish ticket1; A must observe B after its
    // captured .choosing pathname disappears, rather than dropping B entirely.
    const [BPid, APid] = ordered;
    fs.writeFileSync(path.join(root, "roles.json"), JSON.stringify({ [APid]: "A", [BPid]: "B", APid, BPid }));
    const results = await Promise.all([first.done, second.done]);
    for (const result of results) {
      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(JSON.parse(result.stdout).ran).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, "A-before-publish"), "utf8")).toBe("1");
    expect(fs.readFileSync(path.join(root, "B-before-publish"), "utf8")).toBe("1");
    expect(fs.existsSync(path.join(root, "A-snapshot-choosing"))).toBe(true);
    let holders = 0, maximum = 0;
    for (const line of fs.readFileSync(path.join(root, "holders.jsonl"), "utf8").trim().split("\n")) {
      const event = JSON.parse(line);
      holders += event.enter ? 1 : -1;
      maximum = Math.max(maximum, holders);
    }
    expect(maximum).toBe(1);
    expect(holders).toBe(0);
  } finally {
    first.child.kill();
    second.child.kill();
  }
}, 15_000);
