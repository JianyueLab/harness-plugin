import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { finalizeContent, makeTitle, parseJsonLines } from '../filter.mjs';
import { filesAtDepth } from './files.mjs';

export const platform = 'codex';
export const agentName = 'Codex';

const OPEN_TAG = /^<([^<>]*)>/;
const CLOSE_TAG = /<\/([a-z_][a-z0-9_ ]*)>$/;
const IMAGE_MARKER = /^(?:<image(?:\s[^>]*)?>|<\/image>)$/;
const BROWSER_CONTEXT = /^\s*<in-app-browser-context(?:\s[^>]*)?>[\s\S]*?<\/in-app-browser-context>/;

export function files({ home, env }) {
  return filesAtDepth(join(env.CODEX_HOME || join(home, '.codex'), 'sessions'), 3, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
}

/** Whole-tag blocks that hold the user's own text. */
const KEPT_TAGS = new Set(['send_user_message_question_reply']);

/** `<name attrs…>…</name>` spanning the whole text, except tags in `KEPT_TAGS`. */
function isWholeTag(text) {
  const open = OPEN_TAG.exec(text);
  const close = open && CLOSE_TAG.exec(text);
  if (!close || close.index < open[0].length) return false;
  const name = close[1];
  if (KEPT_TAGS.has(name)) return false;
  return open[1] === name || (open[1].startsWith(name) && /\s/.test(open[1][name.length]));
}

/**
 * Context Codex injects as user input: the AGENTS.md block, whole `<tag …>…</tag>` blocks and lone
 * `<image …>` / `</image>` markers.
 */
export function isInjected(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('# AGENTS.md instructions') || isWholeTag(trimmed) || IMAGE_MARKER.test(trimmed);
}

/** The user's own text in a user block: a leading `<in-app-browser-context>` element is removed. Null when nothing remains. */
export function userText(text) {
  if (isInjected(text)) return null;
  const rest = text.replace(BROWSER_CONTEXT, '');
  if (rest === text) return text;
  return rest.trim() === '' || isInjected(rest) ? null : rest.trim();
}

function isUserThread(meta) {
  if (typeof meta.thread_source === 'string') return meta.thread_source === 'user';
  return !(meta.source && typeof meta.source === 'object' && 'subagent' in meta.source);
}

const str = (value) => (typeof value === 'string' && value !== '' ? value : null);

export function parse(text, file) {
  let meta = null;
  const messages = [];
  for (const line of parseJsonLines(text)) {
    if (line.type === 'session_meta') {
      meta ??= line.payload && typeof line.payload === 'object' ? line.payload : null;
      continue;
    }
    if (line.type !== 'response_item') continue;
    const item = line.payload;
    if (item?.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const want = item.role === 'user' ? 'input_text' : 'output_text';
    const blocks = Array.isArray(item.content)
      ? item.content.filter((b) => b && b.type === want && typeof b.text === 'string').map((b) => b.text)
      : [];
    const kept = item.role === 'user' ? blocks.map(userText).filter((b) => b !== null) : blocks;
    if (kept.length === 0) continue;
    const content = finalizeContent(kept.join('\n\n'));
    if (content === '') continue;
    const occurredAt = str(line.timestamp);
    const id = str(item.id) ?? createHash('sha256').update(`${occurredAt ?? ''}\n${item.role}\n${blocks.join('\n\n')}`).digest('hex').slice(0, 32);
    messages.push({ id, role: item.role, content, occurredAt });
  }
  if (!meta || !isUserThread(meta)) return null;
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    platform,
    id: str(meta.id) ?? basename(file, '.jsonl'),
    cwd: str(meta.cwd),
    gitRemote: str(meta.git?.repository_url),
    gitBranch: str(meta.git?.branch),
    toolVersion: str(meta.cli_version),
    title: makeTitle(firstUser?.content),
    startedAt: messages[0]?.occurredAt ?? str(meta.timestamp),
    messages,
  };
}
