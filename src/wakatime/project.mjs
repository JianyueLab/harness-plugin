/**
 * Which project a workspace root belongs to, and which branch it is on.
 *
 * Both are cached in the shared state file keyed by root. Forking `git` on
 * every run to learn something that changes a few times a day is not worth it,
 * and a branch shown 60 seconds stale is not worth caring about.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BRANCH_TTL_MS = 60_000;

/** Default git runner. Injected in tests so no test ever forks a real git. */
export function gitBranch(dir) {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
}

/** Walk up looking for .git; return the directory holding it, or null. */
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function detectProject(root, state, nowMs, runGit = gitBranch) {
  const cache = (state.wakatimeProjects ??= {});
  const hit = cache[root];
  if (hit && nowMs - hit.at < BRANCH_TTL_MS) return { project: hit.project, branch: hit.branch };

  const repo = findRepoRoot(root);
  const project = path.basename(repo ?? root);
  let branch = null;
  if (repo) {
    try {
      const out = String(runGit(repo)).trim();
      // A detached HEAD prints "HEAD"; that is not a branch name worth sending.
      if (out && out !== "HEAD") branch = out;
    } catch {
      /* git missing, not a repo yet, timed out: no branch, not an error */
    }
  }
  cache[root] = { project, branch, at: nowMs };
  return { project, branch };
}
