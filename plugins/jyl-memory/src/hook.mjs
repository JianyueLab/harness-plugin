import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const HOSTS = ['claude-code', 'codex', 'omp'];

export async function hook(argv, { env, readStdin, stdout, spawnWorker, recallText }) {
  if (env.JYL_MEMORY_DISTILL) return 0;
  const [event, ...rest] = argv;
  if (event === 'start') {
    stdout.write(recallText);
    return 0;
  }
  if (event !== 'end') return 0;
  let payload;
  try {
    payload = JSON.parse(await readStdin());
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
  spawn(process.execPath, [WORKER, JSON.stringify(payload)], { detached: true, stdio: 'ignore', env }).unref();
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const recallText = readFileSync(new URL('../prompts/recall.md', import.meta.url), 'utf8');
    await hook(process.argv.slice(2), { env: process.env, readStdin, stdout: process.stdout, spawnWorker, recallText });
  } catch {
    // Hooks never fail the host.
  }
  process.exitCode = 0;
}
