import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MEMORY_TOOLS, buildPrompt, hostCommand } from '../src/hosts.mjs';

describe('hostCommand', () => {
  test('claude-code: print mode, no session file, only the memory tools', () => {
    expect(hostCommand('claude-code', { model: 'haiku', mcpServer: 'memory' })).toEqual({
      cmd: 'claude',
      args: ['-p', '--no-session-persistence', '--allowedTools', MEMORY_TOOLS.map((t) => `mcp__memory__${t}`).join(','), '--model', 'haiku'],
    });
  });

  test('codex: exec, read-only, prompt from stdin; model only when set', () => {
    expect(hostCommand('codex', { model: null, mcpServer: 'memory' })).toEqual({
      cmd: 'codex',
      args: ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-'],
    });
    expect(hostCommand('codex', { model: 'gpt-6-luna', mcpServer: 'memory' }).args).toEqual(
      ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-m', 'gpt-6-luna', '-'],
    );
  });

  test('omp: print mode, no session, no built-in tools, bounded time', () => {
    expect(hostCommand('omp', { model: '@smol', mcpServer: 'memory' })).toEqual({
      cmd: 'omp',
      args: ['-p', '--no-session', '--no-title', '--no-tools', '--max-time', '10m', '--model', '@smol'],
    });
  });

  test('unknown host is an error', () => {
    expect(() => hostCommand('gemini', { model: null, mcpServer: 'memory' })).toThrow();
  });
});

describe('buildPrompt', () => {
  test('fills the server name and wraps the session text', () => {
    const prompt = buildPrompt('Use {{MCP_SERVER}} tools.', { mcpServer: 'mem2', sessionText: '### user\nhi', cwd: '/w' });
    expect(prompt).toBe('Use mem2 tools.\n\n<session cwd="/w">\n### user\nhi\n</session>\n');
  });

  test('the shipped distill prompt names every tool it may use', () => {
    const text = readFileSync(new URL('../prompts/distill.md', import.meta.url), 'utf8');
    for (const tool of MEMORY_TOOLS) expect(text).toContain(tool);
  });
});
