import { basename, join } from 'node:path';
import { finalizeContent, makeTitle, parseJsonLines } from '../filter.mjs';
import { jsonlInSubdirs } from './files.mjs';

export const platform = 'claude-code';
export const agentName = 'Claude Code';

const COMMAND_TEXT =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)>/;

/** Top-level session files. Subagent transcripts under `<session>/subagents/` are not sessions. */
export function files({ home, env }) {
  return jsonlInSubdirs(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'));
}

function textOf(type, content) {
  if (typeof content === 'string') return type === 'user' ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export function parse(text, file) {
  let id = null;
  let cwd = null;
  let gitBranch = null;
  let toolVersion = null;
  let aiTitle = null;
  const messages = [];
  for (const line of parseJsonLines(text)) {
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string') {
      aiTitle = line.aiTitle;
      continue;
    }
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    if (line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true) continue;
    if (typeof line.sessionId === 'string') id ??= line.sessionId;
    if (typeof line.cwd === 'string') cwd ??= line.cwd;
    if (typeof line.gitBranch === 'string' && line.gitBranch !== '') gitBranch = line.gitBranch;
    if (typeof line.version === 'string') toolVersion = line.version;
    if (typeof line.uuid !== 'string') continue;
    const raw = textOf(line.type, line.message?.content);
    if (raw === null) continue;
    if (line.type === 'user' && COMMAND_TEXT.test(raw)) continue;
    const content = finalizeContent(raw);
    if (content === '') continue;
    messages.push({ id: line.uuid, role: line.type, content, occurredAt: typeof line.timestamp === 'string' ? line.timestamp : null });
  }
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    platform,
    id: id ?? basename(file, '.jsonl'),
    cwd,
    gitRemote: null,
    gitBranch,
    toolVersion,
    title: makeTitle(aiTitle) ?? makeTitle(firstUser?.content),
    startedAt: messages[0]?.occurredAt ?? null,
    messages,
  };
}
