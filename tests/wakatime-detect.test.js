import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { languageFor } from "../src/wakatime/language.mjs";
import { detectProject } from "../src/wakatime/project.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-waka-detect-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("known extensions map, unknown ones do not", () => {
  expect(languageFor("/a/b/main.go")).toBe("Go");
  expect(languageFor("/a/b/x.ts")).toBe("TypeScript");
  expect(languageFor("/a/b/x.tsx")).toBe("TypeScript");
  expect(languageFor("/a/b/page.astro")).toBe("Astro");
  expect(languageFor("/a/b/x.mjs")).toBe("JavaScript");
  // Unknown: omit the field and let WakaTime's server guess from the entity.
  expect(languageFor("/a/b/thing.zzz")).toBeNull();
  expect(languageFor("/a/b/Makefile")).toBeNull();
});

test("project comes from the directory holding .git, branch from git", () => {
  const repo = path.join(root, "myrepo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });

  const state = {};
  const got = detectProject(path.join(repo, "src", "deep"), state, 1_000, () => "feature/x\n");
  expect(got.project).toBe("myrepo");
  expect(got.branch).toBe("feature/x");
});

test("no .git falls back to the basename and reports no branch", () => {
  const plain = path.join(root, "plainthing");
  fs.mkdirSync(plain, { recursive: true });

  // TMPDIR may itself be inside a Git checkout. Model a filesystem with no
  // .git entries for this case only; real ancestor discovery is covered below.
  const existsSync = fs.existsSync;
  const exists = spyOn(fs, "existsSync").mockImplementation((file) =>
    path.basename(file) === ".git" ? false : existsSync(file));
  let gitCalls = 0;
  try {
    const got = detectProject(plain, {}, 1_000, () => {
      gitCalls++;
      throw new Error("git must not be consulted when there is no .git");
    });
    expect(got.project).toBe("plainthing");
    expect(got.branch).toBeNull();
    expect(gitCalls).toBe(0);
  } finally {
    exists.mockRestore();
  }
});

test("a plain directory inside a repo inherits the ancestor project and branch", () => {
  const repo = path.join(root, "ancestor-repo");
  const plain = path.join(repo, "plainthing");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(plain, { recursive: true });

  let gitDir;
  const got = detectProject(plain, {}, 1_000, (dir) => {
    gitDir = dir;
    return "ancestor-branch\n";
  });
  expect(got.project).toBe("ancestor-repo");
  expect(got.branch).toBe("ancestor-branch");
  expect(gitDir).toBe(repo);
});

test.each(["directory", "file"])("the nearest nested repo wins with a .git %s", (kind) => {
  const outer = path.join(root, `outer-${kind}`);
  const inner = path.join(outer, "inner-repo");
  const workspace = path.join(inner, "src", "deep");
  fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  if (kind === "directory") fs.mkdirSync(path.join(inner, ".git"));
  else fs.writeFileSync(path.join(inner, ".git"), "gitdir: ../metadata\n");

  let gitDir;
  const got = detectProject(workspace, {}, 1_000, (dir) => {
    gitDir = dir;
    return "inner-branch\n";
  });
  expect(got.project).toBe("inner-repo");
  expect(got.branch).toBe("inner-branch");
  expect(gitDir).toBe(inner);
});

test("git failure is survivable", () => {
  const repo = path.join(root, "brokengit");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const got = detectProject(repo, {}, 1_000, () => {
    throw new Error("git not on PATH");
  });
  expect(got.project).toBe("brokengit");
  expect(got.branch).toBeNull();
});

// Final review M-6: `git rev-parse --abbrev-ref HEAD` prints the literal
// string "HEAD" on a detached HEAD, and project.mjs filters it out. Nothing
// asserted that: removing the filter left all 187 tests green while every
// bisect, rebase or `git checkout <sha>` session would report a branch
// literally named "HEAD" to WakaTime, polluting the branch breakdown.
test("a detached HEAD reports no branch, not a branch named HEAD", () => {
  const repo = path.join(root, "detached");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  const got = detectProject(repo, {}, 1_000, () => "HEAD\n");
  expect(got.project).toBe("detached");
  expect(got.branch).toBeNull();
});

test("the branch is cached for 60s, then re-read", () => {
  const repo = path.join(root, "cached");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

  let calls = 0;
  const git = () => { calls++; return "main\n"; };
  const state = {};

  detectProject(repo, state, 1_000, git);
  detectProject(repo, state, 30_000, git);
  expect(calls).toBe(1);            // inside the window: no second fork

  detectProject(repo, state, 100_000, git);
  expect(calls).toBe(2);            // window expired: re-read
});
