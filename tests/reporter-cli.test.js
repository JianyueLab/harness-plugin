import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENTRY = path.join(import.meta.dir, "..", "src", "reporter.mjs");

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-cli-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Run the real CLI under node with HOME pointed at a throwaway directory. */
const run = (...args) =>
  spawnSync("node", [ENTRY, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

test("an unknown host exits non-zero and reads no transcript", () => {
  // A Claude Code transcript the old fallback would have picked up.
  const project = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "s.jsonl"), "{}\n");

  for (const command of ["--status", "--backfill"]) {
    const r = run("--host", "nope", command);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown host "nope"');
    expect(r.stderr).toContain("claude-code, antigravity, codex");
    expect(r.stdout).toBe("");
  }
  expect(fs.existsSync(path.join(home, ".claude", "jyl-usage"))).toBe(false);
});

test("--host codex uses the codex adapter", () => {
  const r = run("--host", "codex", "--status");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Codex CLI");
  expect(r.stdout).toContain(path.join(home, ".codex", "jyl-usage"));
});

test("no --host still defaults to claude-code", () => {
  const r = run("--status");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(path.join(home, ".claude", "jyl-usage"));
});
