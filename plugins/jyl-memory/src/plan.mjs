import { resolve, sep } from 'node:path';
import { unsentMessages } from './state.mjs';

export function isExcluded(cwd, excludePaths) {
  if (!cwd) return false;
  const dir = resolve(cwd);
  return excludePaths.some((path) => {
    const root = resolve(path);
    return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

export function renderMessages(messages) {
  return messages.map((m) => `### ${m.role}${m.occurredAt ? ` (${m.occurredAt})` : ''}\n${m.content}`).join('\n\n');
}

/** The newest whole messages whose rendering fits in maxChars; one oversized message is cut to its tail. */
export function fitTail(messages, maxChars) {
  const kept = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const block = renderMessages([messages[i]]).length + 2;
    if (kept.length > 0 && size + block > maxChars) break;
    kept.unshift(messages[i]);
    size += block;
  }
  let text = renderMessages(kept);
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return { messages: kept, text };
}

export function planDistill({ session, record, config }) {
  if (isExcluded(session.cwd, config.exclude_paths)) return { skip: 'excluded' };
  const pending = unsentMessages(session, record);
  if (pending.filter((m) => m.role === 'user').length < config.min_user_messages) return { skip: 'too_short' };
  const { text } = fitTail(pending, config.max_chars);
  return { messageIds: pending.map((m) => m.id), text };
}
