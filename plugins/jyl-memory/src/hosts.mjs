import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEMORY_TOOLS = ['jyl_project_list', 'jyl_memory_search', 'jyl_memory_get', 'jyl_memory_add', 'jyl_memory_update'];

export const OMP_CONFIG = fileURLToPath(new URL('../config/omp-distill.yml', import.meta.url));

const CODEX_DISABLED = ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'image_generation', 'apps', 'plugins', 'hooks'];

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const MCP_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*[.\]]/;

/** Names of the MCP servers declared as tables in Codex's config.toml; [] when the file is missing. */
export function codexMcpServers(env, home) {
  let text;
  try {
    text = readFileSync(join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = MCP_HEADER.exec(line);
    if (!match) continue;
    if (match[1] !== undefined) names.add(match[1]);
    else if (match[2] !== undefined) names.add(match[2].replace(/\\(["\\])/g, '$1'));
    else names.add(match[3]);
  }
  return [...names];
}

const tomlKey = (name) => (BARE_KEY.test(name) ? name : `"${name.replace(/[\\"]/g, '\\$&')}"`);

export function hostCommand(host, { model, mcpServer, otherMcpServers = [] }) {
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
      for (const name of otherMcpServers) {
        if (name !== mcpServer) args.push('-c', `mcp_servers.${tomlKey(name)}.enabled=false`);
      }
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
