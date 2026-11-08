import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { UUID } from './config.mjs';

export const MAX_REPOS = 50;
export const REPO_FILE = '.jyl-memory.json';

/** Production deps for repositoryInventory: real git (2 s per call) and the real filesystem. */
export const defaultInventoryDeps = Object.freeze({
  run(args, cwd) {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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

const git = (run, path, ...args) => run(['-C', path, ...args], path);

/** Repository paths for a session directory, in inventory order, at most MAX_REPOS. */
function repoPaths(cwd, { run, exists, listDirs }) {
  const top = git(run, cwd, 'rev-parse', '--show-toplevel');
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
    const listing = git(run, root, 'config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$') ?? '';
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

/**
 * The git repositories of a session: cwd's repository and its checked-out submodules,
 * or, when cwd is not inside a repository, its direct child repositories.
 * Deps: run(args, cwd) runs git and returns trimmed stdout or null; readFile(path) returns text or null;
 * exists(path); listDirs(path) returns child directory names.
 */
export function repositoryInventory(cwd, { projects, run, readFile, exists, listDirs }) {
  const warnings = [];
  if (!cwd) return { repos: [], warnings };
  const repos = repoPaths(resolve(cwd), { run, exists, listDirs }).map((path) => {
    const origin = git(run, path, 'config', '--get', 'remote.origin.url') || null;
    const fromConfig = configProject(path, projects);
    if (fromConfig) return { path, origin, project_id: fromConfig, source: 'config' };
    const fromFile = repoFileProject(path, readFile, warnings);
    return { path, origin, project_id: fromFile, source: fromFile ? 'repo_file' : null };
  });
  return { repos, warnings };
}

export function renderInventory(repos) {
  if (repos.length === 0) return '(no git repositories)';
  return repos
    .map((r) => `- ${r.path} origin=${r.origin ?? 'none'} project=${r.project_id ?? 'none'}${r.source ? ` (from ${r.source})` : ''}`)
    .join('\n');
}
