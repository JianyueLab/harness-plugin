import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as codex from '../src/sources/codex.mjs';
import { codexSession } from './fixtures.js';
import { cleanup, jsonl, tempDir, writeJsonl } from './helpers.js';

describe('codex parse', () => {
  const session = codex.parse(jsonl(codexSession()), '/x/rollout-x-1.jsonl');

  test('keeps user input_text and assistant output_text, without injected context', () => {
    expect(session.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ['msg_u1', 'user', 'Review the open PRs'],
      ['msg_a1', 'assistant', 'Found six open PRs.'],
    ]);
  });

  test('takes session fields from session_meta', () => {
    expect(session).toMatchObject({
      platform: 'codex', id: 'x-1', cwd: '/work/gamma', gitBranch: 'main', toolVersion: '0.163.0',
      gitRemote: 'git@github.com:JianyueLab/gamma.git', title: 'Review the open PRs',
    });
  });

  test('subagent and guardian threads are not sessions', () => {
    expect(codex.parse(jsonl(codexSession('x-2', '/w', 'guardian_review')), '/x/r.jsonl')).toBeNull();
    expect(codex.parse(jsonl(codexSession('x-3', '/w', 'subagent')), '/x/r.jsonl')).toBeNull();
  });

  test('a message without payload.id gets a stable 32-hex id', () => {
    const lines = codexSession().map((l) => (l.payload?.id === 'msg_u1' ? { ...l, payload: { ...l.payload, id: undefined } } : l));
    const a = codex.parse(jsonl(lines), '/x/r.jsonl').messages[0].id;
    const b = codex.parse(jsonl(lines), '/x/r.jsonl').messages[0].id;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
  });

  test('keeps the non-injected blocks of a mixed user message', () => {
    const lines = codexSession().map((l) =>
      l.payload?.id === 'msg_u1'
        ? { ...l, payload: { ...l.payload, content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }, { type: 'input_text', text: 'Real question' }] } }
        : l,
    );
    expect(codex.parse(jsonl(lines), '/x/r.jsonl').messages[0].content).toBe('Real question');
  });

  const withUserContent = (content, id = 'msg_u1') =>
    codexSession().map((l) => (l.payload?.id === 'msg_u1' ? { ...l, payload: { ...l.payload, id, content } } : l));
  const input = (text) => ({ type: 'input_text', text });

  test('the fallback id hashes every text block, including ones dropped as injected context', () => {
    const extra = '<turn_aborted attr="1">x</turn_aborted>';
    expect(codex.isInjected(extra)).toBe(true);
    const message = codex.parse(jsonl(withUserContent([input(extra), input('Real question')], null)), '/x/r.jsonl').messages[0];
    const expected = createHash('sha256').update(`2026-10-27T03:00:03.000Z\nuser\n${extra}\n\nReal question`).digest('hex').slice(0, 32);
    expect(message.content).toBe('Real question');
    expect(message.id).toBe(expected);
  });

  test('strips a leading in-app browser context and keeps the rest of the block', () => {
    const ctx = '<in-app-browser-context source="tab">\n<url>https://example.com</url>\n</in-app-browser-context>';
    const parseFirst = (content) => codex.parse(jsonl(withUserContent(content)), '/x/r.jsonl').messages[0];
    expect(parseFirst([input(`${ctx}\n\nWhy is this page slow?`)]).content).toBe('Why is this page slow?');
    expect(parseFirst([input(ctx), input('Next')]).content).toBe('Next');
  });

  test('drops lone image marker blocks', () => {
    const lines = withUserContent([input('<image name="shot.png">'), { type: 'input_image', image_url: 'data:x' }, input('</image>'), input('What is this?')]);
    expect(codex.parse(jsonl(lines), '/x/r.jsonl').messages[0].content).toBe('What is this?');
  });

  test('keeps question replies whole and still drops environment context', () => {
    const reply = '<send_user_message_question_reply>\n[{"answer":"Use B","question":"A or B?"}]</send_user_message_question_reply>';
    const lines = withUserContent([input('<environment_context>\n<cwd>/w</cwd>\n</environment_context>'), input(reply)]);
    expect(codex.isInjected(reply)).toBe(false);
    expect(codex.parse(jsonl(lines), '/x/r.jsonl').messages[0].content).toBe(reply);
  });
});

describe('isInjected', () => {
  test('matches AGENTS.md blocks, whole-tag blocks and image markers only', () => {
    expect(codex.isInjected('# AGENTS.md instructions\n\nx')).toBe(true);
    expect(codex.isInjected(' <user_instructions>\nx\n</user_instructions> ')).toBe(true);
    expect(codex.isInjected('<permissions instructions>\n</permissions instructions>')).toBe(true);
    expect(codex.isInjected('<guardian_tool_descriptions version="2">\nx\n</guardian_tool_descriptions>')).toBe(true);
    expect(codex.isInjected('<image name="[Image #1]">')).toBe(true);
    expect(codex.isInjected('</image>')).toBe(true);
    expect(codex.isInjected('<b>bold</b> and more')).toBe(false);
    expect(codex.isInjected('Please fix <div> layout')).toBe(false);
    expect(codex.isInjected('<b class="x">bold</i>')).toBe(false);
    expect(codex.isInjected('<image name="a"> and text')).toBe(false);
  });

  test('runs in linear time on an unclosed tag', () => {
    const input = `<${'a '.repeat(50_000)}`;
    const start = performance.now();
    codex.isInjected(input);
    codex.userText(`<in-app-browser-context ${'a '.repeat(50_000)}`);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('codex files', () => {
  test('lists sessions/YYYY/MM/DD/rollout-*.jsonl, honouring CODEX_HOME', () => {
    const home = tempDir('codex-files');
    try {
      const root = join(home, 'codex-alt');
      const file = join(root, 'sessions', '2026', '10', '27', 'rollout-2026-10-27T03-00-00-x-1.jsonl');
      writeJsonl(file, codexSession());
      writeJsonl(join(root, 'sessions', '2026', '10', 'stray.jsonl'), codexSession());
      expect(codex.files({ home, env: { CODEX_HOME: root } })).toEqual([file]);
    } finally {
      cleanup(home);
    }
  });
});
