import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultInventoryDeps, renderInventory, repositoryInventory } from '../src/repos.mjs';
import { cleanup, tempDir } from './helpers.js';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

/**
 * Injected deps over a fake tree.
 * repos: { [absPath]: { origin?, submodules?: string[] } } — each is a checked-out repo (has .git).
 * dirs: { [absPath]: string[] } — child directory names.
 * files: { [absPath]: string } — file contents.
 */
function fake({ repos = {}, dirs = {}, files = {} }) {
  const calls = [];
  const topOf = (path) => Object.keys(repos).filter((r) => path === r || path.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
  return {
    calls,
    run(args, cwd) {
      calls.push([args, cwd]);
      expect(args[0]).toBe('-C');
      expect(args[1]).toBe(cwd);
      const rest = args.slice(2).join(' ');
      const top = topOf(cwd);
      if (rest === 'rev-parse --show-toplevel') return top ?? null;
      if (rest === 'config --get remote.origin.url') return repos[top]?.origin ?? null;
      if (rest === "config --file .gitmodules --get-regexp ^submodule\\..*\\.path$") {
        const subs = repos[cwd]?.submodules;
        return subs ? subs.map((s, i) => `submodule.m ${i}.path ${s}`).join('\n') : null;
      }
      throw new Error(`unexpected git ${rest}`);
    },
    readFile: (path) => files[path] ?? null,
    exists(path) {
      if (path.endsWith('/.git')) return path.slice(0, -5) in repos;
      if (path.endsWith('/.gitmodules')) return Boolean(repos[path.slice(0, -12)]?.submodules);
      return false;
    },
    listDirs: (path) => dirs[path] ?? [],
  };
}

const inventory = (cwd, tree, projects = {}) => repositoryInventory(cwd, { projects, ...fake(tree) });

describe('repositoryInventory', () => {
  test('a single repository with its origin', () => {
    expect(inventory('/w/app', { repos: { '/w/app': { origin: 'git@github.com:o/app.git' } } })).toEqual({
      repos: [{ path: '/w/app', origin: 'git@github.com:o/app.git', project_id: null, source: null }],
      warnings: [],
    });
  });

  test('stops adding repositories after the 5 s deadline and warns once', () => {
    let t = -2000;
    const tree = { repos: { '/w': { origin: 'o', submodules: ['a', 'b'] }, '/w/a': { origin: 'oa' }, '/w/b': { origin: 'ob' } } };
    const result = repositoryInventory('/w', { projects: {}, ...fake(tree), now: () => (t += 2000) });
    expect(result.repos.map((r) => r.path)).toEqual(['/w', '/w/a']);
    expect(result.warnings).toEqual(['repository inventory stopped after 5 s']);
  });

  test('a subdirectory of a repository records the top level', () => {
    expect(inventory('/w/app/src/lib', { repos: { '/w/app': { origin: 'o' } } }).repos.map((r) => r.path)).toEqual(['/w/app']);
  });

  test('credentials in a URL origin are stripped from the inventory and its rendering', () => {
    const cases = [
      ['https://user:ghp_secret123@github.com/o/r.git', 'https://github.com/o/r.git'],
      ['https://ghp_secret123@github.com/o/r.git', 'https://github.com/o/r.git'],
      ['https://user:p@ss_ghp_secret123@github.com/o/r.git', 'https://github.com/o/r.git'],
      ['ssh://git@git.example.com:2222/o/r.git', 'ssh://git.example.com:2222/o/r.git'],
      ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ];
    for (const [raw, clean] of cases) {
      const { repos } = inventory('/w/app', { repos: { '/w/app': { origin: raw } } });
      expect(repos[0].origin).toBe(clean);
      const text = `${JSON.stringify(repos)}\n${renderInventory(repos)}`;
      expect(text).not.toContain('ghp_secret123');
      expect(text).toContain(`origin=${clean} `);
    }
  });

  test('exists and listDirs are optional and default to the real filesystem', () => {
    const { run, readFile } = fake({ repos: { '/w/app': { origin: 'o' } } });
    expect(repositoryInventory('/w/app', { projects: {}, run, readFile }).repos.map((r) => r.path)).toEqual(['/w/app']);
    const dir = tempDir('repos-optional');
    try {
      mkdirSync(join(dir, 'child', '.git'), { recursive: true });
      mkdirSync(join(dir, 'plain'));
      const none = fake({});
      expect(repositoryInventory(dir, { projects: {}, run: none.run, readFile: none.readFile }).repos.map((r) => r.path)).toEqual([join(dir, 'child')]);
    } finally {
      cleanup(dir);
    }
  });

  test('a root with .gitmodules records each submodule with its own origin', () => {
    const tree = {
      repos: {
        '/w': { origin: 'root-url', submodules: ['ui', 'apps/web app'] },
        '/w/ui': { origin: 'ui-url' },
        '/w/apps/web app': { origin: 'web-url' },
      },
    };
    expect(inventory('/w', tree).repos).toEqual([
      { path: '/w', origin: 'root-url', project_id: null, source: null },
      { path: '/w/ui', origin: 'ui-url', project_id: null, source: null },
      { path: '/w/apps/web app', origin: 'web-url', project_id: null, source: null },
    ]);
  });

  test('a submodule that is not checked out is skipped', () => {
    const tree = { repos: { '/w': { origin: 'root-url', submodules: ['ui', 'gone'] }, '/w/ui': { origin: 'ui-url' } } };
    expect(inventory('/w', tree).repos.map((r) => r.path)).toEqual(['/w', '/w/ui']);
  });

  test('a directory that is not a repository records its child repositories', () => {
    const tree = {
      repos: { '/d/a': { origin: 'a-url' }, '/d/c': { origin: 'c-url' } },
      dirs: { '/d': ['c', 'b', 'a'] },
    };
    expect(inventory('/d', tree).repos).toEqual([
      { path: '/d/a', origin: 'a-url', project_id: null, source: null },
      { path: '/d/c', origin: 'c-url', project_id: null, source: null },
    ]);
  });

  test('no origin is null', () => {
    expect(inventory('/w/app', { repos: { '/w/app': {} } }).repos[0].origin).toBeNull();
  });

  test('null cwd is an empty inventory', () => {
    expect(inventory(null, {})).toEqual({ repos: [], warnings: [] });
  });

  test('the local config wins over .jyl-memory.json; the longest prefix wins', () => {
    const tree = {
      repos: { '/w': { submodules: ['ui', 'api'] }, '/w/ui': {}, '/w/api': {} },
      files: {
        '/w/ui/.jyl-memory.json': JSON.stringify({ project_id: P2 }),
        '/w/api/.jyl-memory.json': JSON.stringify({ project_id: P2 }),
      },
    };
    const { repos, warnings } = inventory('/w', tree, { '/w': P1, '/w/ui': P2 });
    expect(repos).toEqual([
      { path: '/w', origin: null, project_id: P1, source: 'config' },
      { path: '/w/ui', origin: null, project_id: P2, source: 'config' },
      { path: '/w/api', origin: null, project_id: P1, source: 'config' },
    ]);
    expect(warnings).toEqual([]);
  });

  test('a config key matches whole path segments only', () => {
    const tree = { repos: { '/w/app2': {} }, files: { '/w/app2/.jyl-memory.json': JSON.stringify({ project_id: P2 }) } };
    expect(inventory('/w/app2', tree, { '/w/app': P1 }).repos[0]).toMatchObject({ project_id: P2, source: 'repo_file' });
  });

  test('.jyl-memory.json supplies project_id when the config has none', () => {
    const tree = { repos: { '/w/app': {} }, files: { '/w/app/.jyl-memory.json': JSON.stringify({ project_id: P2 }) } };
    expect(inventory('/w/app', tree).repos[0]).toMatchObject({ project_id: P2, source: 'repo_file' });
  });

  test('a broken or invalid .jyl-memory.json is null with one warning naming the file', () => {
    for (const text of ['{nope', '[]', '"x"', JSON.stringify({ project_id: 'not-a-uuid' }), JSON.stringify({})]) {
      const tree = { repos: { '/w/app': {} }, files: { '/w/app/.jyl-memory.json': text } };
      const { repos, warnings } = inventory('/w/app', tree);
      expect(repos[0]).toMatchObject({ project_id: null, source: null });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('/w/app/.jyl-memory.json');
    }
  });

  test('stops at 50 repositories', () => {
    const names = Array.from({ length: 60 }, (_, i) => `r${String(i).padStart(2, '0')}`);
    const tree = { repos: Object.fromEntries(names.map((n) => [join('/d', n), {}])), dirs: { '/d': names } };
    const { repos } = inventory('/d', tree);
    expect(repos).toHaveLength(50);
    expect(repos.at(-1).path).toBe('/d/r49');
  });

  test('stops at 50 including the root and its submodules', () => {
    const subs = Array.from({ length: 55 }, (_, i) => `s${i}`);
    const tree = { repos: { '/w': { submodules: subs }, ...Object.fromEntries(subs.map((s) => [`/w/${s}`, {}])) } };
    const { repos } = inventory('/w', tree);
    expect(repos).toHaveLength(50);
    expect(repos[0].path).toBe('/w');
  });
});

describe('defaultInventoryDeps', () => {
  test('run returns trimmed git stdout or null; filesystem helpers return null or [] when missing', () => {
    const dir = tempDir('repos');
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'file.txt'), 'text');
      expect(defaultInventoryDeps.run(['--version'], dir)).toMatch(/^git version \S+$/);
      expect(defaultInventoryDeps.run(['no-such-command'], dir)).toBeNull();
      expect(defaultInventoryDeps.readFile(join(dir, 'file.txt'))).toBe('text');
      expect(defaultInventoryDeps.readFile(join(dir, 'missing'))).toBeNull();
      expect(defaultInventoryDeps.exists(join(dir, 'sub'))).toBe(true);
      expect(defaultInventoryDeps.listDirs(dir)).toEqual(['sub']);
      expect(defaultInventoryDeps.listDirs(join(dir, 'missing'))).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });
});

describe('renderInventory', () => {
  test('one line per repository', () => {
    expect(renderInventory([
      { path: '/w', origin: 'git@github.com:o/w.git', project_id: P1, source: 'config' },
      { path: '/w/ui', origin: null, project_id: P2, source: 'repo_file' },
      { path: '/w/api', origin: 'u', project_id: null, source: null },
    ])).toBe([
      `- /w origin=git@github.com:o/w.git project=${P1} (from config)`,
      `- /w/ui origin=none project=${P2} (from repo_file)`,
      '- /w/api origin=u project=none',
    ].join('\n'));
  });

  test('an empty inventory', () => {
    expect(renderInventory([])).toBe('(no git repositories)');
  });
});
