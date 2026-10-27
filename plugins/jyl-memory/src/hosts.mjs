export const MEMORY_TOOLS = ['jyl_project_list', 'jyl_memory_search', 'jyl_memory_get', 'jyl_memory_add', 'jyl_memory_update'];

export function hostCommand(host, { model, mcpServer }) {
  switch (host) {
    case 'claude-code': {
      const args = ['-p', '--no-session-persistence', '--allowedTools', MEMORY_TOOLS.map((t) => `mcp__${mcpServer}__${t}`).join(',')];
      if (model) args.push('--model', model);
      return { cmd: 'claude', args };
    }
    case 'codex': {
      const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only'];
      if (model) args.push('-m', model);
      args.push('-');
      return { cmd: 'codex', args };
    }
    case 'omp': {
      const args = ['-p', '--no-session', '--no-title', '--no-tools', '--max-time', '10m'];
      if (model) args.push('--model', model);
      return { cmd: 'omp', args };
    }
    default:
      throw new Error(`unknown host: ${host}`);
  }
}

export function buildPrompt(promptText, { mcpServer, sessionText, cwd }) {
  return `${promptText.replaceAll('{{MCP_SERVER}}', mcpServer)}\n\n<session cwd="${cwd ?? ''}">\n${sessionText}\n</session>\n`;
}
