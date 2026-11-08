import { loadConfig } from './config.mjs';
import { renderInventory, repositoryInventory } from './repos.mjs';

const EMPTY = '(no git repositories)';

/**
 * The recall prompt with {{REPOSITORIES}} replaced by the repository inventory of `cwd`.
 * An unreadable config means no configured projects. Never throws; on error the inventory is empty.
 */
export function renderRecall(template, cwd, { env, home, inventoryDeps }) {
  let inventory = EMPTY;
  try {
    let projects = {};
    try {
      projects = loadConfig({ env, home }).projects;
    } catch {
      // Config errors are reported by the worker; recall still renders.
    }
    inventory = renderInventory(repositoryInventory(cwd, { ...inventoryDeps, projects }).repos);
  } catch {
    inventory = EMPTY;
  }
  return template.replaceAll('{{REPOSITORIES}}', () => inventory);
}
