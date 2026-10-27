const at = (prefix, s) => `${prefix}:${String(s).padStart(2, '0')}.000Z`;

export function claudeSession(sessionId = 'c-1', cwd = '/work/alpha') {
  const t = (s) => at('2026-10-27T01:00', s);
  const base = { sessionId, cwd, gitBranch: 'main', version: '2.1.0', isSidechain: false, userType: 'external' };
  return [
    { type: 'user', ...base, uuid: 'u1', parentUuid: null, timestamp: t(0), message: { role: 'user', content: 'How do we deploy?\n<system-reminder>internal</system-reminder>' } },
    { type: 'assistant', ...base, uuid: 'a1', parentUuid: 'u1', timestamp: t(5), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] } },
    { type: 'assistant', ...base, uuid: 'a2', parentUuid: 'a1', timestamp: t(6), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', ...base, uuid: 'u2', parentUuid: 'a2', timestamp: t(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file-list' }] } },
    { type: 'assistant', ...base, uuid: 'a3', parentUuid: 'u2', timestamp: t(8), message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'We deploy with kubectl.' }] } },
    { type: 'user', ...base, uuid: 'u3', parentUuid: 'a3', isMeta: true, timestamp: t(9), message: { role: 'user', content: 'Caveat: generated' } },
    { type: 'user', ...base, uuid: 'u4', parentUuid: 'a3', timestamp: t(10), message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', ...base, uuid: 'u5', isSidechain: true, timestamp: t(11), message: { role: 'user', content: 'subagent prompt' } },
    { type: 'attachment', sessionId, uuid: 'x1', timestamp: t(12) },
    { type: 'ai-title', aiTitle: 'Deploy question', sessionId },
  ];
}

export function ompSession(id = 'o-1', cwd = '/work/beta') {
  const t = (s) => at('2026-10-27T02:00', s);
  const text = (value) => [{ type: 'text', text: value }];
  return [
    { type: 'title', v: 1, title: '📡 Beta work', source: 'auto', pad: '    ' },
    { type: 'session', id, version: 3, cwd, timestamp: t(0) },
    { type: 'model_change', id: 'e0', parentId: null, timestamp: t(0), model: 'm' },
    { type: 'message', id: 'e1', parentId: 'e0', timestamp: t(1), message: { role: 'user', content: text('Old branch question') } },
    { type: 'message', id: 'e2', parentId: 'e1', timestamp: t(2), message: { role: 'assistant', content: text('Old branch answer') } },
    { type: 'message', id: 'e3', parentId: 'e0', timestamp: t(3), message: { role: 'user', content: text('New branch question') } },
    { type: 'message', id: 'e4', parentId: 'e3', timestamp: t(4), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }, { type: 'text', text: 'New branch answer' }] } },
    { type: 'message', id: 'e5', parentId: 'e4', timestamp: t(5), message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: text('tool output') } },
    { type: 'message', id: 'e6', parentId: 'e5', timestamp: t(6), message: { role: 'developer', content: text('developer note') } },
    { type: 'custom_message', id: 'e7', parentId: 'e6', timestamp: t(7), customType: 'x', content: 'injected' },
  ];
}

export function codexSession(id = 'x-1', cwd = '/work/gamma', threadSource = 'user') {
  const t = (s) => at('2026-10-27T03:00', s);
  const item = (s, payload) => ({ timestamp: t(s), type: 'response_item', payload });
  return [
    {
      timestamp: t(0),
      type: 'session_meta',
      payload: {
        id, timestamp: t(0), cwd, cli_version: '0.163.0', originator: 'codex-tui', thread_source: threadSource,
        source: threadSource === 'user' ? 'vscode' : { subagent: { other: 'guardian' } },
        git: { branch: 'main', repository_url: 'git@github.com:JianyueLab/gamma.git' },
      },
    },
    item(1, { type: 'message', role: 'developer', id: 'msg_d', content: [{ type: 'input_text', text: '<permissions instructions>\n</permissions instructions>' }] }),
    item(2, { type: 'message', role: 'user', id: 'msg_u0', content: [
      { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>' },
      { type: 'input_text', text: '<environment_context>\n  <cwd>/work/gamma</cwd>\n</environment_context>' },
    ] }),
    item(3, { type: 'message', role: 'user', id: 'msg_u1', content: [{ type: 'input_text', text: 'Review the open PRs' }] }),
    item(4, { type: 'reasoning', id: 'r1', summary: [] }),
    item(5, { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }),
    item(6, { type: 'agent_message', id: 'am1', author: '/root/sub', recipient: '/root', content: [{ type: 'input_text', text: 'sub report' }] }),
    item(7, { type: 'message', role: 'assistant', id: 'msg_a1', content: [{ type: 'output_text', text: 'Found six open PRs.' }] }),
    { timestamp: t(8), type: 'event_msg', payload: { type: 'task_complete' } },
  ];
}
