import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { UUID } from './config.mjs';

export const MAX_REPOS = 50;
export const INVENTORY_DEADLINE_MS = 5000;
export const REPO_FILE = '.jyl-memory.json';

export const GIT_TIMEOUT_MS = 2000;

/** Production deps for repositoryInventory: real git (timeout per call, default 2 s) and the real filesystem. */
export const defaultInventoryDeps = Object.freeze({
  run(args, cwd, timeout = GIT_TIMEOUT_MS) {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: existsSync,
  listDirs(path) {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  },
});

const git = (run, timeout, path, ...args) => run(['-C', path, ...args], path, timeout);

/** Git timeout for the time left before the deadline: at most GIT_TIMEOUT_MS, at least 1 ms. */
const gitTimeout = (elapsed) => Math.max(1, Math.min(GIT_TIMEOUT_MS, Math.floor(INVENTORY_DEADLINE_MS - elapsed)));

/** Repository paths for a session directory, in inventory order, at most MAX_REPOS. */
function repoPaths(cwd, { run, exists, listDirs, timeout }) {
  const top = git(run, timeout, cwd, 'rev-parse', '--show-toplevel');
  if (!top) {
    return listDirs(cwd)
      .sort()
      .map((name) => join(cwd, name))
      .filter((path) => exists(join(path, '.git')))
      .slice(0, MAX_REPOS);
  }
  const root = resolve(top);
  const paths = [root];
  if (exists(join(root, '.gitmodules'))) {
    const listing = git(run, timeout, root, 'config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$') ?? '';
    for (const line of listing.split('\n')) {
      const value = /^submodule\..*?\.path\s(.+)$/.exec(line)?.[1];
      if (!value) continue;
      const path = resolve(root, value);
      if (exists(join(path, '.git'))) paths.push(path);
    }
  }
  return paths.slice(0, MAX_REPOS);
}

function configProject(path, projects) {
  let best = null;
  for (const dir of Object.keys(projects)) {
    const inside = path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
    if (inside && (best === null || dir.length > best.length)) best = dir;
  }
  return best === null ? null : projects[best];
}

function repoFileProject(path, readFile, warnings) {
  const file = join(path, REPO_FILE);
  const text = readFile(file);
  if (text === null) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.project_id === 'string' && UUID.test(data.project_id)) return data.project_id;
  warnings.push(`ignored ${file}: expected {"project_id": "<UUID>"}`);
  return null;
}

/** A remote URL without userinfo: `https://user:token@host/…` → `https://host/…`. scp-style remotes are unchanged. */
const stripUserinfo = (url) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');

/**
 * The git repositories of a session: cwd's repository and its checked-out submodules,
 * or, when cwd is not inside a repository, its direct child repositories.
 * Deps: run(args, cwd, timeout) runs git within timeout ms and returns trimmed stdout or null; readFile(path) returns text or null;
 * optional exists(path) and listDirs(path) (child directory names) default to defaultInventoryDeps; optional now() defaults to Date.now.
 * Stops adding repositories once INVENTORY_DEADLINE_MS has passed and adds a warning; each git call gets the time left.
 */
export function repositoryInventory(cwd, { projects, run, readFile, exists = defaultInventoryDeps.exists, listDirs = defaultInventoryDeps.listDirs, now = Date.now }) {
  const warnings = [];
  if (!cwd) return { repos: [], warnings };
  const start = now();
  const repos = [];
  for (const path of repoPaths(resolve(cwd), { run, exists, listDirs, timeout: gitTimeout(0) })) {
    const elapsed = now() - start;
    if (elapsed > INVENTORY_DEADLINE_MS) {
      warnings.push('repository inventory stopped after 5 s');
      break;
    }
    const url = git(run, gitTimeout(elapsed), path, 'config', '--get', 'remote.origin.url');
    const origin = url ? stripUserinfo(url) : null;
    const fromConfig = configProject(path, projects);
    if (fromConfig) {
      repos.push({ path, origin, project_id: fromConfig, source: 'config' });
      continue;
    }
    const fromFile = repoFileProject(path, readFile, warnings);
    repos.push({ path, origin, project_id: fromFile, source: fromFile ? 'repo_file' : null });
  }
  return { repos, warnings };
}

/** Text without control characters (U+0000–U+001F, U+007F), so a value cannot start a new prompt line. */
const oneLine = (text) => text.replace(/[\u0000-\u001f\u007f]/g, '');

export function renderInventory(repos) {
  if (repos.length === 0) return '(no git repositories)';
  return repos
    .map((r) => `- ${oneLine(r.path)} origin=${r.origin == null ? 'none' : oneLine(r.origin)} project=${r.project_id ?? 'none'}${r.source ? ` (from ${r.source})` : ''}`)
    .join('\n');
}
