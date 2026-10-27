import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  exclude_paths: Object.freeze([]),
  min_user_messages: 3,
  max_chars: 200_000,
  mcp_server: 'memory',
  models: Object.freeze({ 'claude-code': 'haiku', codex: null, omp: '@smol' }),
});

const HOSTS = ['claude-code', 'codex', 'omp'];

export class ConfigError extends Error {}

export function configPath(env, home) {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'jyl-memory', 'plugin.json');
}

function expandHome(path, home) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return resolve(path);
}

const isInt = (value, min) => Number.isInteger(value) && value >= min;

export function loadConfig({ env, home }) {
  const path = configPath(env, home);
  const config = { ...DEFAULT_CONFIG, exclude_paths: [], models: { ...DEFAULT_CONFIG.models } };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return config;
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConfigError(`config is not valid JSON: ${path}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`config must be a JSON object: ${path}`);
  for (const [key, value] of Object.entries(data)) {
    switch (key) {
      case 'enabled':
        if (typeof value !== 'boolean') throw new ConfigError('enabled must be true or false');
        config.enabled = value;
        break;
      case 'exclude_paths':
        if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p !== '')) throw new ConfigError('exclude_paths must be a list of paths');
        config.exclude_paths = value.map((p) => expandHome(p, home));
        break;
      case 'min_user_messages':
        if (!isInt(value, 1)) throw new ConfigError('min_user_messages must be an integer of at least 1');
        config.min_user_messages = value;
        break;
      case 'max_chars':
        if (!isInt(value, 1000)) throw new ConfigError('max_chars must be an integer of at least 1000');
        config.max_chars = value;
        break;
      case 'mcp_server':
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ConfigError('mcp_server must be a server name');
        config.mcp_server = value;
        break;
      case 'models':
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('models must be an object');
        for (const [host, model] of Object.entries(value)) {
          if (!HOSTS.includes(host)) throw new ConfigError(`models has an unknown host: ${host}`);
          if (model !== null && (typeof model !== 'string' || model === '')) throw new ConfigError(`models.${host} must be a model name or null`);
          config.models[host] = model;
        }
        break;
      default:
        throw new ConfigError(`unknown config key: ${key}`);
    }
  }
  return config;
}
