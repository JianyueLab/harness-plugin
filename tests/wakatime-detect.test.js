import { afterAll, expect, test } from "bun:test";
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

  const got = detectProject(plain, {}, 1_000, () => {
    throw new Error("git must not be consulted when there is no .git");
  });
  expect(got.project).toBe("plainthing");
  expect(got.branch).toBeNull();
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
