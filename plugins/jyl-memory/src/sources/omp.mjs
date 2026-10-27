import { basename, join } from 'node:path';
import { finalizeContent, makeTitle, parseJsonLines } from '../filter.mjs';
import { jsonlInSubdirs } from './files.mjs';

export const platform = 'omp';
export const agentName = 'omp';

export function files({ home, env }) {
  return jsonlInSubdirs(join(env.PI_CODING_AGENT_DIR || join(home, '.omp', 'agent'), 'sessions'));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Root-to-leaf entries of the branch ending at the last physical entry (how omp rebuilds its leaf). */
function activeBranch(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path = [];
  const seen = new Set();
  let entry = entries.at(-1);
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    path.push(entry);
    entry = typeof entry.parentId === 'string' ? byId.get(entry.parentId) : undefined;
  }
  return path.reverse();
}

export function parse(text, file) {
  let slotTitle = null;
  let header = null;
  const entries = [];
  for (const line of parseJsonLines(text)) {
    if (line.type === 'title') {
      if (typeof line.title === 'string') slotTitle = line.title;
      continue;
    }
    if (line.type === 'session') {
      header ??= line;
      continue;
    }
    if (typeof line.id === 'string') entries.push(line);
  }
  const messages = [];
  for (const entry of activeBranch(entries)) {
    if (entry.type !== 'message') continue;
    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const raw = textOf(entry.message.content);
    if (raw === null) continue;
    const content = finalizeContent(raw);
    if (content === '') continue;
    messages.push({ id: entry.id, role, content, occurredAt: typeof entry.timestamp === 'string' ? entry.timestamp : null });
  }
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    platform,
    id: typeof header?.id === 'string' ? header.id : basename(file, '.jsonl'),
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    gitRemote: null,
    gitBranch: null,
    toolVersion: null,
    title: makeTitle(slotTitle) ?? makeTitle(header?.title) ?? makeTitle(firstUser?.content),
    startedAt: messages[0]?.occurredAt ?? (typeof header?.timestamp === 'string' ? header.timestamp : null),
    messages,
  };
}
