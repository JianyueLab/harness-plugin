import { describe, expect, test } from 'bun:test';
import { finalizeContent, makeTitle, parseJsonLines, truncateCodePoints } from '../src/filter.mjs';

describe('parseJsonLines', () => {
  test('skips blank, malformed, non-object lines and an unterminated last line', () => {
    const text = '{"a":1}\n\nnot json\n[1,2]\n"str"\n{"b":2}\n{"c":';
    expect(parseJsonLines(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('finalizeContent', () => {
  test('removes system-reminder blocks and trims', () => {
    expect(finalizeContent('  hi <system-reminder>x\ny</system-reminder> there ')).toBe('hi  there');
  });

  test('returns empty when only a reminder remains', () => {
    expect(finalizeContent('<system-reminder>only</system-reminder>')).toBe('');
  });

  test('drops NUL and repairs lone surrogates', () => {
    expect(finalizeContent('a\u0000b\uD800c')).toBe('ab\uFFFDc');
  });

  test('scrubs before truncating', () => {
    expect(finalizeContent(`password: ${'hunter'}22`)).toBe('password: [REDACTED:env_secret]');
  });

  test('caps at 100000 code points ending in the marker', () => {
    const out = finalizeContent('😀'.repeat(100_001));
    expect(Array.from(out).length).toBe(100_000);
    expect(out.endsWith('\n[TRUNCATED]')).toBe(true);
  });
});

describe('truncateCodePoints', () => {
  test('leaves text at the limit unchanged', () => {
    expect(truncateCodePoints('abc', 3)).toBe('abc');
  });
});

describe('makeTitle', () => {
  test('collapses whitespace to one line', () => {
    expect(makeTitle('  Fix\n\nthe   build ')).toBe('Fix the build');
  });

  test('caps at 120 code points with an ellipsis', () => {
    const title = makeTitle('字'.repeat(200));
    expect(Array.from(title).length).toBe(120);
    expect(title.endsWith('…')).toBe(true);
  });

  test('null for empty or non-string input', () => {
    expect(makeTitle('   ')).toBeNull();
    expect(makeTitle(null)).toBeNull();
  });
});
