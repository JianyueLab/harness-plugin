import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRecall } from '../src/recall.mjs';
import { cleanup, tempDir } from './helpers.js';

const P1 = '11111111-1111-4111-8111-111111111111';

/** Inventory deps for a single repo at /w with origin and no repo file. */
const oneRepo = {
  run(args) {
    const rest = args.slice(2).join(' ');
    if (rest === 'rev-parse --show-toplevel') return '/w';
    if (rest === 'config --get remote.origin.url') return 'git@github.com:o/w.git';
    return null;
  },
  readFile: () => null,
  exists: () => false,
  listDirs: () => [],
};

describe('renderRecall', () => {
  test('replaces {{REPOSITORIES}} with the inventory, using config projects', () => {
    const home = tempDir('recall');
    try {
      mkdirSync(join(home, '.config', 'jyl-memory'), { recursive: true });
      writeFileSync(join(home, '.config', 'jyl-memory', 'plugin.json'), JSON.stringify({ projects: { '/w': P1 } }));
      const out = renderRecall('A\n{{REPOSITORIES}}\nB', '/w', { env: {}, home, inventoryDeps: oneRepo });
      expect(out).toBe(`A\n- /w origin=git@github.com:o/w.git project=${P1} (from config)\nB`);
    } finally {
      cleanup(home);
    }
  });

  test('an invalid config falls back to no projects', () => {
    const home = tempDir('recall');
    try {
      mkdirSync(join(home, '.config', 'jyl-memory'), { recursive: true });
      writeFileSync(join(home, '.config', 'jyl-memory', 'plugin.json'), 'nope');
      const out = renderRecall('{{REPOSITORIES}}', '/w', { env: {}, home, inventoryDeps: oneRepo });
      expect(out).toBe('- /w origin=git@github.com:o/w.git project=none');
    } finally {
      cleanup(home);
    }
  });

  test('no cwd or a failing inventory renders no repositories and never throws', () => {
    const home = tempDir('recall');
    try {
      expect(renderRecall('{{REPOSITORIES}}', null, { env: {}, home, inventoryDeps: oneRepo })).toBe('(no git repositories)');
      const broken = { ...oneRepo, run: () => { throw new Error('boom'); } };
      expect(renderRecall('x {{REPOSITORIES}}', '/w', { env: {}, home, inventoryDeps: broken })).toBe('x (no git repositories)');
    } finally {
      cleanup(home);
    }
  });

  test('the recall prompt has the placeholder and the project rules', () => {
    const text = readFileSync(new URL('../prompts/recall.md', import.meta.url), 'utf8');
    expect(text).toContain('{{REPOSITORIES}}');
    expect(text).toContain('jyl_project_find');
    expect(text).toContain('`links`');
    expect(text).toContain('Do not write memories yourself: the session is distilled into memory automatically when it ends.');
  });
});
