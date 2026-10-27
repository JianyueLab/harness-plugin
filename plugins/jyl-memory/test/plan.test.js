import { describe, expect, test } from 'bun:test';
import { fitTail, isExcluded, planDistill, renderMessages } from '../src/plan.mjs';

const msg = (id, role, content, occurredAt = null) => ({ id, role, content, occurredAt });
const config = { exclude_paths: ['/work/private'], min_user_messages: 2, max_chars: 1000 };
const session = {
  cwd: '/work/alpha',
  messages: [msg('u1', 'user', 'first question'), msg('a1', 'assistant', 'answer one'), msg('u2', 'user', 'second question'), msg('a2', 'assistant', 'answer two')],
};

describe('isExcluded', () => {
  test('matches the directory and its children only', () => {
    expect(isExcluded('/work/private', ['/work/private'])).toBe(true);
    expect(isExcluded('/work/private/sub', ['/work/private'])).toBe(true);
    expect(isExcluded('/work/private-other', ['/work/private'])).toBe(false);
    expect(isExcluded(null, ['/work/private'])).toBe(false);
  });
});

describe('renderMessages', () => {
  test('labels each message with its role and time', () => {
    expect(renderMessages([msg('u1', 'user', 'hi', '2026-10-28T01:00:00.000Z'), msg('a1', 'assistant', 'hello')])).toBe(
      '### user (2026-10-28T01:00:00.000Z)\nhi\n\n### assistant\nhello',
    );
  });
});

describe('fitTail', () => {
  test('keeps the newest whole messages that fit', () => {
    const many = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 'user', 'x'.repeat(100)));
    const { messages, text } = fitTail(many, 400);
    expect(messages.map((m) => m.id)).toEqual(['m7', 'm8', 'm9']);
    expect(text.length).toBeLessThanOrEqual(400);
  });

  test('cuts a single oversized message to its tail', () => {
    const { text } = fitTail([msg('m1', 'user', 'a'.repeat(50) + 'END')], 20);
    expect(text.length).toBe(20);
    expect(text.endsWith('END')).toBe(true);
  });
});

describe('planDistill', () => {
  test('skips excluded directories', () => {
    expect(planDistill({ session: { ...session, cwd: '/work/private/x' }, record: undefined, config })).toEqual({ skip: 'excluded' });
  });

  test('skips when fewer new user messages than the minimum', () => {
    expect(planDistill({ session, record: { sent_message_ids: ['u1', 'a1'] }, config })).toEqual({ skip: 'too_short' });
  });

  test('takes only messages not yet distilled and returns all their ids', () => {
    const plan = planDistill({ session, record: undefined, config });
    expect(plan.messageIds).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(plan.text).toContain('first question');
    expect(plan.text).toContain('answer two');
  });

  test('ids cover messages dropped by the size cap, so they are not distilled later', () => {
    const big = { cwd: '/w', messages: Array.from({ length: 20 }, (_, i) => msg(`m${i}`, 'user', 'y'.repeat(100))) };
    const plan = planDistill({ session: big, record: undefined, config: { ...config, max_chars: 300 } });
    expect(plan.messageIds).toHaveLength(20);
    expect(plan.text.length).toBeLessThanOrEqual(300);
  });
});
