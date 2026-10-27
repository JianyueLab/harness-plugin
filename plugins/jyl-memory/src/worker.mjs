import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.mjs';
import { buildPrompt, codexMcpServers, hostCommand } from './hosts.mjs';
import { planDistill } from './plan.mjs';
import * as claudeCode from './sources/claude-code.mjs';
import * as codex from './sources/codex.mjs';
import * as omp from './sources/omp.mjs';
import { loadState, saveState, withLock } from './state.mjs';

export const PENDING_FRESH_MS = 15 * 60_000;
export const HOST_TIMEOUT_MS = 10 * 60_000;
export const LOG_MAX_BYTES = 256 * 1024;
export const KILL_GRACE_MS = 10_000;
export const STDOUT_KEEP_BYTES = 64 * 1024;

const READERS = { 'claude-code': claudeCode, codex, omp };

export function stateDir(env, home) {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'jyl-memory');
}

function log(dir, now, line) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'plugin.log');
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // No log yet.
  }
  const entry = `${new Date(now()).toISOString()} ${line}\n`;
  if (size > LOG_MAX_BYTES) writeFileSync(path, entry, { mode: 0o600 });
  else appendFileSync(path, entry, { mode: 0o600 });
}

const fileKey = (key) => key.replace(/[^A-Za-z0-9._-]/g, '_');

export async function distill(payload, { env, home, now, runHost: run, promptText }) {
  const dir = stateDir(env, home);
  let config;
  try {
    config = loadConfig({ env, home });
  } catch (error) {
    if (error instanceof ConfigError) {
      log(dir, now, `config error: ${error.message}`);
      return 'disabled';
    }
    throw error;
  }
  if (!config.enabled) return 'disabled';
  const reader = READERS[payload.host];
  let text;
  try {
    text = readFileSync(payload.transcript_path, 'utf8');
  } catch {
    log(dir, now, `${payload.host}:${payload.session_id ?? '?'} unreadable transcript`);
    return 'unreadable';
  }
  const session = reader.parse(text, payload.transcript_path);
  if (!session) return 'not_user_session';
  if (!session.cwd && payload.cwd) session.cwd = payload.cwd;
  const key = `${session.platform}:${session.id}`;
  const statePath = join(dir, 'plugin-state.json');
  const pendingPath = join(dir, 'pending', `${fileKey(key)}.txt`);

  const plan = await withLock(dir, async () => {
    try {
      if (now() - statSync(pendingPath).mtimeMs < PENDING_FRESH_MS) return { skip: 'running' };
    } catch {
      // No pending file.
    }
    const state = loadState(statePath);
    const result = planDistill({ session, record: state.sessions[key], config });
    if (result.skip) return result;
    mkdirSync(join(dir, 'pending'), { recursive: true, mode: 0o700 });
    writeFileSync(pendingPath, result.text, { mode: 0o600 });
    return result;
  });
  if (plan.skip) {
    log(dir, now, `${key} skip ${plan.skip}`);
    return plan.skip;
  }

  try {
    const otherMcpServers = payload.host === 'codex' ? codexMcpServers(env, home) : [];
    const { cmd, args } = hostCommand(payload.host, { model: config.models[payload.host], mcpServer: config.mcp_server, otherMcpServers });
    const input = buildPrompt(promptText, { mcpServer: config.mcp_server, sessionText: plan.text, cwd: session.cwd });
    const { code, stdout } = await run(cmd, args, input, { env: { ...env, JYL_MEMORY_DISTILL: '1' }, cwd: dir });
    if (code !== 0) {
      log(dir, now, `${key} failed exit=${code}`);
      return 'failed';
    }
    if (!reportedDone(stdout)) {
      log(dir, now, `${key} failed no-done`);
      return 'failed';
    }
    await withLock(dir, async () => {
      const state = loadState(statePath);
      const previous = state.sessions[key];
      state.sessions[key] = {
        decision: 'sent',
        sent_message_ids: [...(previous?.sent_message_ids ?? []), ...plan.messageIds],
        updated_at: new Date(now()).toISOString(),
      };
      saveState(statePath, state);
    });
    log(dir, now, `${key} distilled ${plan.messageIds.length} messages`);
    return 'distilled';
  } finally {
    rmSync(pendingPath, { force: true });
  }
}

function reportedDone(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1)?.toLowerCase() === 'done';
}

/** Runs the host CLI; resolves { code, stdout } with the last STDOUT_KEEP_BYTES of stdout. */
export function runHost(cmd, args, input, { env, cwd, timeoutMs = HOST_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: 127, stdout: '' });
      return;
    }
    let kept = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > STDOUT_KEEP_BYTES) kept = kept.subarray(kept.length - STDOUT_KEEP_BYTES);
    });
    let timedOut = false;
    let grace;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      grace = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, timeoutMs);
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(grace);
    };
    child.on('error', () => {
      clear();
      resolve({ code: 127, stdout: '' });
    });
    child.on('close', (code) => {
      clear();
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout: kept.toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Worker entry: distills the payload in argv[0]; logs any error to plugin.log. */
export async function main(argv, { env, home, now, runHost: run, loadPrompt }) {
  try {
    const payload = JSON.parse(argv[0] ?? '');
    await distill(payload, { env, home, now, runHost: run, promptText: loadPrompt() });
  } catch (error) {
    try {
      const text = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`.replace(/\s+/g, ' ');
      log(stateDir(env, home), now, `worker error: ${text}`);
    } catch {
      // Logging never fails the worker.
    }
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith('/src/worker.mjs')) {
  const loadPrompt = () => readFileSync(new URL('../prompts/distill.md', import.meta.url), 'utf8');
  await main(process.argv.slice(2), { env: process.env, home: homedir(), now: Date.now, runHost, loadPrompt });
  process.exitCode = 0;
}
