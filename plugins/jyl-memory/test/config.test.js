import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError, DEFAULT_CONFIG, configPath, loadConfig } from '../src/config.mjs';
import { cleanup, tempDir } from './helpers.js';

describe('loadConfig', () => {
  let home;
  const write = (value) => {
    const path = configPath({}, home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  beforeEach(() => { home = tempDir('config'); });
  afterEach(() => cleanup(home));

  test('defaults when the file is missing', () => {
    expect(loadConfig({ env: {}, home })).toEqual({ ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models } });
  });

  test('configPath honours XDG_CONFIG_HOME', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/c' }, '/h')).toBe('/c/jyl-memory/plugin.json');
    expect(configPath({}, '/h')).toBe('/h/.config/jyl-memory/plugin.json');
  });

  test('file values override defaults; ~ in exclude_paths expands; models merge per host', () => {
    write({ enabled: false, exclude_paths: ['~/private', '/abs'], min_user_messages: 5, models: { codex: 'gpt-6-luna' } });
    const config = loadConfig({ env: {}, home });
    expect(config).toMatchObject({ enabled: false, min_user_messages: 5, max_chars: 200000, mcp_server: 'memory' });
    expect(config.exclude_paths).toEqual([join(home, 'private'), '/abs']);
    expect(config.models).toEqual({ 'claude-code': 'haiku', codex: 'gpt-6-luna', omp: '@smol' });
  });

  test('invalid JSON, unknown keys and wrong types are errors', () => {
    for (const bad of ['{nope', { colour: 'red' }, { enabled: 'yes' }, { min_user_messages: 0 }, { max_chars: 10 }, { mcp_server: 'a b' }, { exclude_paths: [1] }, { models: { gemini: 'x' } }]) {
      write(bad);
      expect(() => loadConfig({ env: {}, home })).toThrow(ConfigError);
    }
  });
});
