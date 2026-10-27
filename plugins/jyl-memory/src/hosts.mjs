import { fileURLToPath } from 'node:url';

export const MEMORY_TOOLS = ['jyl_project_list', 'jyl_memory_search', 'jyl_memory_get', 'jyl_memory_add', 'jyl_memory_update'];

export const OMP_CONFIG = fileURLToPath(new URL('../config/omp-distill.yml', import.meta.url));

const CODEX_DISABLED = ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'image_generation'];

export function hostCommand(host, { model, mcpServer }) {
  switch (host) {
    case 'claude-code': {
      const args = [
        '-p', '--no-session-persistence',
        '--tools', '',
        '--permission-mode', 'dontAsk',
        '--allowedTools', MEMORY_TOOLS.map((t) => `mcp__${mcpServer}__${t}`).join(','),
      ];
      if (model) args.push('--model', model);
      return { cmd: 'claude', args };
    }
    case 'codex': {
      const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only'];
      for (const feature of CODEX_DISABLED) args.push('--disable', feature);
      if (model) args.push('-m', model);
      args.push('-');
      return { cmd: 'codex', args };
    }
    case 'omp': {
      const args = ['-p', '--no-session', '--no-title', '--no-tools', '--max-time', '10m', '--approval-mode', 'always-ask'];
      if (mcpServer === 'memory') args.push('--config', OMP_CONFIG);
      if (model) args.push('--model', model);
      return { cmd: 'omp', args };
    }
    default:
      throw new Error(`unknown host: ${host}`);
  }
}

export function buildPrompt(promptText, { mcpServer, sessionText, cwd }) {
  const body = sessionText.replaceAll('</session', '<\\/session');
  return `${promptText.replaceAll('{{MCP_SERVER}}', mcpServer)}\n\n<session cwd="${cwd ?? ''}">\n${body}\n</session>\n`;
}
