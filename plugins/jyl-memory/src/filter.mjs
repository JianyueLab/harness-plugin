import { scrub } from './scrub.mjs';

export const MAX_CODE_POINTS = 100_000;
export const TITLE_CODE_POINTS = 120;
const TRUNCATED = '\n[TRUNCATED]';
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Objects from JSONL text. Blank, malformed and non-object lines and an unterminated last line are skipped. */
export function parseJsonLines(text) {
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop();
  const out = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
    } catch {
      // Malformed line: skipped.
    }
  }
  return out;
}

/** `text` cut to `max` code points, the last ones replaced by the truncation marker. */
export function truncateCodePoints(text, max) {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max - Array.from(TRUNCATED).length).join('') + TRUNCATED;
}

/** A message body as uploaded. An empty string means the message is dropped. */
export function finalizeContent(text) {
  const cleaned = text.replace(SYSTEM_REMINDER, '').replaceAll('\u0000', '').toWellFormed().trim();
  if (cleaned === '') return '';
  return truncateCodePoints(scrub(cleaned), MAX_CODE_POINTS);
}

/** A one-line, scrubbed title of at most TITLE_CODE_POINTS; null when empty. */
export function makeTitle(text) {
  if (typeof text !== 'string') return null;
  const line = scrub(text.replaceAll('\u0000', '').toWellFormed()).replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  const points = Array.from(line);
  return points.length <= TITLE_CODE_POINTS ? line : points.slice(0, TITLE_CODE_POINTS - 1).join('') + '…';
}
