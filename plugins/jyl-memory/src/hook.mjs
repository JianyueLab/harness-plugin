import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { renderRecall } from './recall.mjs';
import { defaultInventoryDeps } from './repos.mjs';

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const HOSTS = ['claude-code', 'codex', 'omp'];
const START_STDIN_MS = 1000;

export async function hook(argv, { env, readStdin, stdout, spawnWorker, recallTemplate, recallDeps }) {
  if (env.JYL_MEMORY_DISTILL) return 0;
  const [event, ...rest] = argv;
  if (event === 'start') {
    let cwd = null;
    try {
      const payload = JSON.parse(await readStdin(START_STDIN_MS));
      if (payload && typeof payload.cwd === 'string' && payload.cwd !== '') cwd = payload.cwd;
    } catch {
      // No usable payload: render without repositories.
    }
    stdout.write(renderRecall(recallTemplate, cwd, recallDeps));
    return 0;
  }
  if (event !== 'end') return 0;
  let payload;
  try {
    payload = JSON.parse(env.JYL_MEMORY_PAYLOAD || (await readStdin()));
  } catch {
    return 0;
  }
  if (!payload || typeof payload.transcript_path !== 'string' || payload.transcript_path === '') return 0;
  const flag = rest.indexOf('--host');
  const host = flag >= 0 && HOSTS.includes(rest[flag + 1]) ? rest[flag + 1] : env.PLUGIN_ROOT ? 'codex' : 'claude-code';
  spawnWorker({
    host,
    transcript_path: payload.transcript_path,
    session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
  });
  return 0;
}

function spawnWorker(payload) {
  const env = { ...process.env };
  delete env.JYL_MEMORY_DISTILL;
  delete env.JYL_MEMORY_PAYLOAD;
  spawn(process.execPath, [WORKER, JSON.stringify(payload)], { detached: true, stdio: 'ignore', env })
    .on('error', () => {})
    .unref();
}

/** All of stdin; with `limitMs`, whatever arrived by then. */
function readStdin(limitMs) {
  return new Promise((resolve) => {
    let text = '';
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
      process.stdin.destroy();
      resolve(text);
    };
    if (limitMs) timer = setTimeout(done, limitMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (text += chunk));
    process.stdin.once('end', done);
    process.stdin.once('error', done);
  });
}

if (import.meta.main ?? process.argv[1]?.endsWith('/src/hook.mjs')) {
  try {
    const recallTemplate = readFileSync(new URL('../prompts/recall.md', import.meta.url), 'utf8');
    const recallDeps = { env: process.env, home: homedir(), inventoryDeps: defaultInventoryDeps };
    await hook(process.argv.slice(2), { env: process.env, readStdin, stdout: process.stdout, spawnWorker, recallTemplate, recallDeps });
  } catch {
    // Hooks never fail the host.
  }
  process.exitCode = 0;
}
