# jyl-memory 记忆提炼插件 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `harness-plugin/plugins/jyl-memory/` 插件：会话开始时提示 agent 读取记忆；会话结束时在后台用宿主 CLI 提炼本次新增的正文，经 memory MCP 写入记忆。

**Architecture:** 钩子（Claude Code / Codex 用 `hooks/hooks.json`，omp 用 `hooks/post/jyl-memory.ts`）只做两件事：`start` 输出提示词；`end` 把会话路径交给脱离的 worker 后立即返回。worker 用复制自 memory-capture 的读取器与脱敏读出正文，按本地进度只取新增消息，经 stdin 交给 `claude -p` / `codex exec` / `omp -p`，宿主用 memory MCP 写记忆，成功后记下进度。

**Tech Stack:** 零依赖 ESM（`.mjs`），运行于 `bun` 或 `node` ≥ 22；测试 `bun test`；omp 钩子为 TypeScript（由 omp 加载）。

**Spec:** `docs/superpowers/specs/2026-10-28-memory-distill-design.md`

## Global Constraints

- 插件目录：`plugins/jyl-memory/`。不修改 `jyl-usage` 的任何文件（根目录 `hooks/`、`src/`、`scripts/`、`.claude-plugin/plugin.json`）。
- 零依赖；源码 `.mjs`；测试 `plugins/jyl-memory/test/*.test.js`；`plugins/jyl-memory/package.json` 含 `"type": "module"`。
- 测试不访问网络，不读取真实主目录，不调用真实的 `claude`、`codex`、`omp`；临时目录在 `plugins/jyl-memory/.temp/`（已被根 `.gitignore` 的 `.temp/` 忽略），测试结束删除。
- 测试中的密钥样例在运行时拼接，源码中不出现完整的密钥形状字符串。
- 防递归环境变量：`JYL_MEMORY_DISTILL=1`。钩子在它存在时什么都不做；worker 只给宿主 CLI 设置它。
- 钩子进程总以 0 退出，`end` 不读会话文件，立即返回（Codex `SessionEnd` 最多 3 秒）。
- 默认值：`min_user_messages` 3；`max_chars` 200000；`mcp_server` `memory`；模型 `claude-code: haiku`、`codex: null`（用默认）、`omp: @smol`；pending 新鲜期 15 分钟；宿主超时 10 分钟；日志上限 256 KB。
- 状态目录 `$XDG_STATE_HOME/jyl-memory`（默认 `~/.local/state/jyl-memory`）；进度文件 `plugin-state.json`；正文 `pending/<键>.txt`（0600）；日志 `plugin.log`。配置 `$XDG_CONFIG_HOME/jyl-memory/plugin.json`（默认 `~/.config/jyl-memory/plugin.json`）。
- 记忆只经 MCP 工具 `jyl_project_list`、`jyl_memory_search`、`jyl_memory_get`、`jyl_memory_add`、`jyl_memory_update` 写入；宿主不开放任何内置工具。
- 版本：预发布 `27.0.x`，正式 `27.1.0`。
- 文档与提交信息陈述事实，不解释理由。
- 推送、创建 PR、在用户机器上安装插件、登录 MCP 之前先征得用户同意。

## 文件结构

| 文件 | 职责 |
|---|---|
| `plugins/jyl-memory/.claude-plugin/plugin.json` | Claude Code 清单 |
| `plugins/jyl-memory/.codex-plugin/plugin.json` | Codex 清单 |
| `plugins/jyl-memory/hooks/hooks.json` | Claude Code / Codex 钩子 |
| `plugins/jyl-memory/hooks/post/jyl-memory.ts` | omp 钩子 |
| `plugins/jyl-memory/scripts/run` | 启动器 |
| `plugins/jyl-memory/prompts/recall.md` | 开工提示 |
| `plugins/jyl-memory/prompts/distill.md` | 提炼提示词 |
| `plugins/jyl-memory/src/scrub.mjs`、`filter.mjs`、`sources/{files,claude-code,omp,codex}.mjs` | 复制自 memory-capture |
| `plugins/jyl-memory/src/state.mjs` | 复制自 memory-capture，删去 `statePath`、`isListed` |
| `plugins/jyl-memory/src/config.mjs` | 配置 |
| `plugins/jyl-memory/src/plan.mjs` | 跳过条件与截取 |
| `plugins/jyl-memory/src/hosts.mjs` | 宿主命令行与提示词组装 |
| `plugins/jyl-memory/src/worker.mjs` | 后台提炼 |
| `plugins/jyl-memory/src/hook.mjs` | 钩子入口 |
| `.claude-plugin/marketplace.json` | 增加 `jyl-memory` 条目 |
| `.agents/plugins/marketplace.json` | Codex marketplace（新建） |

---

### Task 1: 插件骨架与复用代码

**Files:**
- Create: `plugins/jyl-memory/package.json`、`plugins/jyl-memory/.claude-plugin/plugin.json`、`plugins/jyl-memory/.codex-plugin/plugin.json`
- Create（复制）: `plugins/jyl-memory/src/{scrub,filter,state}.mjs`、`plugins/jyl-memory/src/sources/{files,claude-code,omp,codex}.mjs`、`plugins/jyl-memory/test/{helpers,fixtures,scrub.test,filter.test,claude-code.test,omp.test,codex.test,state.test}.js`

**Interfaces:**
- Produces: `scrub`、`parseJsonLines`、`finalizeContent`、`makeTitle`；读取器 `{ platform, agentName, files, parse }`；`loadState`、`saveState`、`withLock`、`unsentMessages`、`StateError`、`LOCK_STALE_MS`；测试工具 `tempDir`、`cleanup`、`jsonl`、`writeJsonl`、`sink`；样本 `claudeSession`、`ompSession`、`codexSession`。

- [ ] **Step 1: 复制 memory-capture 的模块与测试**

memory-capture 是工作区里的 `../memory-capture`，取 `main`（`731bc8c`）：

```bash
cd plugins && mkdir -p jyl-memory/src/sources jyl-memory/test && cd jyl-memory
MC=../../../memory-capture
for f in src/scrub.mjs src/filter.mjs src/state.mjs src/sources/files.mjs src/sources/claude-code.mjs src/sources/omp.mjs src/sources/codex.mjs \
         test/helpers.js test/fixtures.js test/scrub.test.js test/filter.test.js test/claude-code.test.js test/omp.test.js test/codex.test.js test/state.test.js; do
  git -C "$MC" show "main:$f" > "$f"
done
```

- [ ] **Step 2: 删去用不到的导出**

`src/state.mjs`：删除 `statePath` 函数，以及 `isListed` 函数与它上方的注释。之后 `join` 仍被 `withLock` 使用，`dirname` 仍被 `saveState` 使用，保留这两个导入。

`test/state.test.js`：
- 删除测试 `statePath honours XDG_STATE_HOME`；
- 把 `describe('pending', …)` 整块替换为：

```js
describe('unsentMessages', () => {
  test('a session without a record has every message pending', () => {
    expect(unsentMessages(session, undefined).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  test('messages already recorded are excluded', () => {
    expect(unsentMessages(session, { sent_message_ids: ['m1', 'm2'] }).map((m) => m.id)).toEqual(['m3']);
  });
});
```

- 导入行去掉 `isListed`、`statePath`。

- [ ] **Step 3: 写清单**

`plugins/jyl-memory/package.json`：

```json
{
  "name": "jyl-memory-plugin",
  "version": "27.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": { "test": "bun test" }
}
```

`plugins/jyl-memory/.claude-plugin/plugin.json`：

```json
{
  "name": "jyl-memory",
  "description": "Recalls JianyueLab memory at session start and distils each session into it when the session ends.",
  "version": "27.0.0"
}
```

`plugins/jyl-memory/.codex-plugin/plugin.json`：

```json
{
  "name": "jyl-memory",
  "version": "27.0.0",
  "description": "Recalls JianyueLab memory at session start and distils each session into it when the session ends.",
  "hooks": "./hooks/hooks.json"
}
```

- [ ] **Step 4: 运行测试**

Run: `cd plugins/jyl-memory && bun test`
Expected: 全部通过（读取器、脱敏、过滤、状态）；无网络、无真实主目录访问。

- [ ] **Step 5: 提交**

```bash
git add plugins/jyl-memory
git commit -m "Add jyl-memory plugin skeleton with session readers and scrubbing"
```

---

### Task 2: 配置

**Files:**
- Create: `plugins/jyl-memory/src/config.mjs`、`plugins/jyl-memory/test/config.test.js`

**Interfaces:**
- Produces: `DEFAULT_CONFIG`、`ConfigError`、`configPath(env, home)`、`loadConfig({ env, home })` → `{ enabled, exclude_paths: string[] (绝对路径), min_user_messages, max_chars, mcp_server, models: { 'claude-code', codex, omp } }`

- [ ] **Step 1: 写失败的测试**

`test/config.test.js`：

```js
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError, DEFAULT_CONFIG, configPath, loadConfig } from '../src/config.mjs';
import { cleanup, tempDir } from './helpers.js';

describe('loadConfig', () => {
  let home;
  const write = (value) => {
    const path = configPath({}, home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  beforeEach(() => { home = tempDir('config'); });
  afterEach(() => cleanup(home));

  test('defaults when the file is missing', () => {
    expect(loadConfig({ env: {}, home })).toEqual({ ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models } });
  });

  test('configPath honours XDG_CONFIG_HOME', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/c' }, '/h')).toBe('/c/jyl-memory/plugin.json');
    expect(configPath({}, '/h')).toBe('/h/.config/jyl-memory/plugin.json');
  });

  test('file values override defaults; ~ in exclude_paths expands; models merge per host', () => {
    write({ enabled: false, exclude_paths: ['~/private', '/abs'], min_user_messages: 5, models: { codex: 'gpt-6-luna' } });
    const config = loadConfig({ env: {}, home });
    expect(config).toMatchObject({ enabled: false, min_user_messages: 5, max_chars: 200000, mcp_server: 'memory' });
    expect(config.exclude_paths).toEqual([join(home, 'private'), '/abs']);
    expect(config.models).toEqual({ 'claude-code': 'haiku', codex: 'gpt-6-luna', omp: '@smol' });
  });

  test('invalid JSON, unknown keys and wrong types are errors', () => {
    for (const bad of ['{nope', { colour: 'red' }, { enabled: 'yes' }, { min_user_messages: 0 }, { max_chars: 10 }, { mcp_server: 'a b' }, { exclude_paths: [1] }, { models: { gemini: 'x' } }]) {
      write(bad);
      expect(() => loadConfig({ env: {}, home })).toThrow(ConfigError);
    }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd plugins/jyl-memory && bun test test/config.test.js`
Expected: FAIL，找不到 `../src/config.mjs`。

- [ ] **Step 3: 写实现**

`src/config.mjs`：

```js
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  exclude_paths: Object.freeze([]),
  min_user_messages: 3,
  max_chars: 200_000,
  mcp_server: 'memory',
  models: Object.freeze({ 'claude-code': 'haiku', codex: null, omp: '@smol' }),
});

const HOSTS = ['claude-code', 'codex', 'omp'];

export class ConfigError extends Error {}

export function configPath(env, home) {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'jyl-memory', 'plugin.json');
}

function expandHome(path, home) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return resolve(path);
}

const isInt = (value, min) => Number.isInteger(value) && value >= min;

export function loadConfig({ env, home }) {
  const path = configPath(env, home);
  const config = { ...DEFAULT_CONFIG, exclude_paths: [], models: { ...DEFAULT_CONFIG.models } };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return config;
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConfigError(`config is not valid JSON: ${path}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`config must be a JSON object: ${path}`);
  for (const [key, value] of Object.entries(data)) {
    switch (key) {
      case 'enabled':
        if (typeof value !== 'boolean') throw new ConfigError('enabled must be true or false');
        config.enabled = value;
        break;
      case 'exclude_paths':
        if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p !== '')) throw new ConfigError('exclude_paths must be a list of paths');
        config.exclude_paths = value.map((p) => expandHome(p, home));
        break;
      case 'min_user_messages':
        if (!isInt(value, 1)) throw new ConfigError('min_user_messages must be an integer of at least 1');
        config.min_user_messages = value;
        break;
      case 'max_chars':
        if (!isInt(value, 1000)) throw new ConfigError('max_chars must be an integer of at least 1000');
        config.max_chars = value;
        break;
      case 'mcp_server':
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ConfigError('mcp_server must be a server name');
        config.mcp_server = value;
        break;
      case 'models':
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('models must be an object');
        for (const [host, model] of Object.entries(value)) {
          if (!HOSTS.includes(host)) throw new ConfigError(`models has an unknown host: ${host}`);
          if (model !== null && (typeof model !== 'string' || model === '')) throw new ConfigError(`models.${host} must be a model name or null`);
          config.models[host] = model;
        }
        break;
      default:
        throw new ConfigError(`unknown config key: ${key}`);
    }
  }
  return config;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd plugins/jyl-memory && bun test test/config.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add plugins/jyl-memory/src/config.mjs plugins/jyl-memory/test/config.test.js
git commit -m "Add jyl-memory plugin config"
```

---

### Task 3: 跳过条件与增量截取

**Files:**
- Create: `plugins/jyl-memory/src/plan.mjs`、`plugins/jyl-memory/test/plan.test.js`

**Interfaces:**
- Consumes: `unsentMessages`（Task 1）
- Produces:
  - `isExcluded(cwd: string|null, excludePaths: string[]): boolean`
  - `renderMessages(messages): string`
  - `fitTail(messages, maxChars): { messages, text }`
  - `planDistill({ session, record, config }): { skip: 'excluded'|'too_short' } | { messageIds: string[], text: string }`

- [ ] **Step 1: 写失败的测试**

`test/plan.test.js`：

```js
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd plugins/jyl-memory && bun test test/plan.test.js`
Expected: FAIL，找不到 `../src/plan.mjs`。

- [ ] **Step 3: 写实现**

`src/plan.mjs`：

```js
import { resolve, sep } from 'node:path';
import { unsentMessages } from './state.mjs';

export function isExcluded(cwd, excludePaths) {
  if (!cwd) return false;
  const dir = resolve(cwd);
  return excludePaths.some((path) => {
    const root = resolve(path);
    return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

export function renderMessages(messages) {
  return messages.map((m) => `### ${m.role}${m.occurredAt ? ` (${m.occurredAt})` : ''}\n${m.content}`).join('\n\n');
}

/** The newest whole messages whose rendering fits in maxChars; one oversized message is cut to its tail. */
export function fitTail(messages, maxChars) {
  const kept = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const block = renderMessages([messages[i]]).length + 2;
    if (kept.length > 0 && size + block > maxChars) break;
    kept.unshift(messages[i]);
    size += block;
  }
  let text = renderMessages(kept);
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return { messages: kept, text };
}

export function planDistill({ session, record, config }) {
  if (isExcluded(session.cwd, config.exclude_paths)) return { skip: 'excluded' };
  const pending = unsentMessages(session, record);
  if (pending.filter((m) => m.role === 'user').length < config.min_user_messages) return { skip: 'too_short' };
  const { text } = fitTail(pending, config.max_chars);
  return { messageIds: pending.map((m) => m.id), text };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd plugins/jyl-memory && bun test test/plan.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add plugins/jyl-memory/src/plan.mjs plugins/jyl-memory/test/plan.test.js
git commit -m "Add distill planning: exclusions, minimum length, tail cap"
```

---

### Task 4: 宿主命令行与提示词

**Files:**
- Create: `plugins/jyl-memory/src/hosts.mjs`、`plugins/jyl-memory/prompts/distill.md`、`plugins/jyl-memory/prompts/recall.md`、`plugins/jyl-memory/test/hosts.test.js`

**Interfaces:**
- Produces:
  - `MEMORY_TOOLS`（5 个工具名）
  - `hostCommand(host, { model, mcpServer }): { cmd, args }`
  - `buildPrompt(promptText, { mcpServer, sessionText, cwd }): string`

- [ ] **Step 1: 写提示词**

`prompts/recall.md`：

```markdown
Long-term memory for this user is in the `memory` MCP server (tools named `jyl_*`).

Before you start a task:
1. Call `jyl_project_list` once to get the user's project ids.
2. Call `jyl_memory_search` with 2–4 keywords from the task (project, repository, feature or system names) over those project ids.
3. When the task continues earlier work, also call `jyl_project_get_context` for the relevant project.

Use what you find, and say so when a memory looks outdated. Do not write memories yourself: the session is distilled into memory automatically when it ends.
```

`prompts/distill.md`：

```markdown
You maintain a user's long-term memory. The text inside <session> is one coding-agent session: user and assistant messages only, with secrets already redacted. Record what is worth knowing in future sessions.

Use only the `{{MCP_SERVER}}` MCP tools: jyl_project_list, jyl_memory_search, jyl_memory_get, jyl_memory_add, jyl_memory_update.

1. Pick candidates: decisions and their reasons, facts learned about projects, systems or infrastructure, user preferences, and the state of unfinished work with its next step. Skip routine tool chatter, transient errors, anything only true inside this session, and anything obvious from the code itself.
2. Call jyl_project_list once. For each candidate, call jyl_memory_search with its key terms over the user's projects.
   - Same subject already recorded and this session changes or extends it: jyl_memory_get it, then jyl_memory_update with its expected_revision.
   - Already recorded as is: do nothing.
   - Not recorded: jyl_memory_add with kind fact, decision, preference or project; a one-sentence title; content stating the fact itself with project or repository names and the date from the session timestamps. Do not narrate the conversation. Write in the session's language. Leave project_id unset.
3. At most 5 adds or updates. If nothing is worth keeping, write nothing.
4. Never record secrets, tokens, passwords, keys, or personal data about other people.

Reply with "done" when finished.
```

- [ ] **Step 2: 写失败的测试**

`test/hosts.test.js`：

```js
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
```

- [ ] **Step 3: 运行，确认失败**

Run: `cd plugins/jyl-memory && bun test test/hosts.test.js`
Expected: FAIL，找不到 `../src/hosts.mjs`。

- [ ] **Step 4: 写实现**

`src/hosts.mjs`：

```js
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
```

- [ ] **Step 5: 运行，确认通过**

Run: `cd plugins/jyl-memory && bun test test/hosts.test.js`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add plugins/jyl-memory/src/hosts.mjs plugins/jyl-memory/prompts plugins/jyl-memory/test/hosts.test.js
git commit -m "Add host command lines and distill/recall prompts"
```

---

### Task 5: 后台 worker

**Files:**
- Create: `plugins/jyl-memory/src/worker.mjs`、`plugins/jyl-memory/test/worker.test.js`

**Interfaces:**
- Consumes: `loadConfig`（Task 2）、`planDistill`（Task 3）、`hostCommand`、`buildPrompt`（Task 4）、`loadState`、`saveState`、`withLock`（Task 1）、三个读取器（Task 1）
- Produces:
  - `PENDING_FRESH_MS = 900000`、`HOST_TIMEOUT_MS = 600000`、`LOG_MAX_BYTES = 262144`
  - `stateDir(env, home): string`
  - `distill(payload, deps): Promise<'disabled'|'unreadable'|'not_user_session'|'excluded'|'too_short'|'running'|'failed'|'distilled'>`
    - `payload`：`{ host, transcript_path, session_id, cwd }`
    - `deps`：`{ env, home, now, runHost(cmd, args, input, { env, cwd }) => Promise<number>, promptText }`
  - `runHost(cmd, args, input, { env, cwd, timeoutMs? }): Promise<number>`

- [ ] **Step 1: 写失败的测试**

`test/worker.test.js`：

```js
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PENDING_FRESH_MS, distill, runHost, stateDir } from '../src/worker.mjs';
import { claudeSession, codexSession, ompSession } from './fixtures.js';
import { cleanup, tempDir, writeJsonl } from './helpers.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');

describe('distill', () => {
  let home;
  let calls;
  let exitCode;
  const deps = () => ({
    env: {},
    home,
    now: () => NOW,
    promptText: 'Use {{MCP_SERVER}}.',
    runHost: async (cmd, args, input, options) => {
      calls.push({ cmd, args, input, options });
      return exitCode;
    },
  });
  const statePath = () => join(stateDir({}, home), 'plugin-state.json');
  const transcript = (name, lines) => {
    const path = join(home, 'transcripts', name);
    writeJsonl(path, lines);
    return path;
  };

  beforeEach(() => {
    home = tempDir('worker');
    calls = [];
    exitCode = 0;
  });
  afterEach(() => cleanup(home));

  test('claude-code session: runs claude with the prompt on stdin and records progress', async () => {
    const lines = [...claudeSession('c-1'), { type: 'user', sessionId: 'c-1', cwd: '/work/alpha', uuid: 'u9', timestamp: '2026-10-27T01:01:00.000Z', message: { role: 'user', content: 'And the rollback?' } }, { type: 'user', sessionId: 'c-1', cwd: '/work/alpha', uuid: 'u10', timestamp: '2026-10-27T01:02:00.000Z', message: { role: 'user', content: 'Thanks.' } }];
    const path = transcript('c-1.jsonl', lines);
    expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-1', cwd: '/work/alpha' }, deps())).toBe('distilled');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].input.startsWith('Use memory.\n\n<session cwd="/work/alpha">')).toBe(true);
    expect(calls[0].input).toContain('How do we deploy?');
    expect(calls[0].options.env.JYL_MEMORY_DISTILL).toBe('1');
    expect(calls[0].options.cwd).toBe(stateDir({}, home));
    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(state.sessions['claude-code:c-1'].sent_message_ids).toEqual(['u1', 'a3', 'u9', 'u10']);
    expect(existsSync(join(stateDir({}, home), 'pending', 'claude-code_c-1.txt'))).toBe(false);
  });

  test('a second run with no new messages is too short and does not call the host', async () => {
    const lines = [...ompSession('o-1'), { type: 'message', id: 'e8', parentId: 'e7', timestamp: '2026-10-27T02:00:08.000Z', message: { role: 'user', content: 'third' } }, { type: 'message', id: 'e9', parentId: 'e8', timestamp: '2026-10-27T02:00:09.000Z', message: { role: 'user', content: 'fourth' } }];
    const path = transcript('o-1.jsonl', lines);
    expect(await distill({ host: 'omp', transcript_path: path, session_id: 'o-1', cwd: null }, deps())).toBe('distilled');
    expect(await distill({ host: 'omp', transcript_path: path, session_id: 'o-1', cwd: null }, deps())).toBe('too_short');
    expect(calls).toHaveLength(1);
  });

  test('a failed host run keeps progress unchanged and removes the pending file', async () => {
    exitCode = 1;
    const lines = [...codexSession('x-1'), { timestamp: '2026-10-27T03:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u2', content: [{ type: 'input_text', text: 'two' }] } }, { timestamp: '2026-10-27T03:00:10.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u3', content: [{ type: 'input_text', text: 'three' }] } }];
    const path = transcript('rollout-x-1.jsonl', lines);
    expect(await distill({ host: 'codex', transcript_path: path, session_id: 'x-1', cwd: null }, deps())).toBe('failed');
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(join(stateDir({}, home), 'pending', 'codex_x-1.txt'))).toBe(false);
  });

  test('a fresh pending file means another run is in progress', async () => {
    const lines = [...claudeSession('c-2'), { type: 'user', sessionId: 'c-2', cwd: '/w', uuid: 'u9', message: { role: 'user', content: 'more' } }, { type: 'user', sessionId: 'c-2', cwd: '/w', uuid: 'u10', message: { role: 'user', content: 'again' } }];
    const path = transcript('c-2.jsonl', lines);
    const pending = join(stateDir({}, home), 'pending', 'claude-code_c-2.txt');
    mkdirSync(join(stateDir({}, home), 'pending'), { recursive: true });
    writeFileSync(pending, 'x');
    utimesSync(pending, new Date(NOW - 60_000), new Date(NOW - 60_000));
    expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-2', cwd: '/w' }, deps())).toBe('running');
    utimesSync(pending, new Date(NOW - PENDING_FRESH_MS - 1000), new Date(NOW - PENDING_FRESH_MS - 1000));
    expect(await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-2', cwd: '/w' }, deps())).toBe('distilled');
  });

  test('disabled config, unreadable transcript and non-user Codex threads do nothing', async () => {
    mkdirSync(join(home, '.config', 'jyl-memory'), { recursive: true });
    writeFileSync(join(home, '.config', 'jyl-memory', 'plugin.json'), JSON.stringify({ enabled: false }));
    expect(await distill({ host: 'claude-code', transcript_path: '/nope', session_id: 'z', cwd: null }, deps())).toBe('disabled');
    writeFileSync(join(home, '.config', 'jyl-memory', 'plugin.json'), '{}');
    expect(await distill({ host: 'claude-code', transcript_path: join(home, 'missing.jsonl'), session_id: 'z', cwd: null }, deps())).toBe('unreadable');
    const guardian = transcript('rollout-g.jsonl', codexSession('g', '/w', 'guardian_review'));
    expect(await distill({ host: 'codex', transcript_path: guardian, session_id: 'g', cwd: null }, deps())).toBe('not_user_session');
    expect(calls).toHaveLength(0);
  });

  test('every outcome is logged with the session key', async () => {
    const path = transcript('c-3.jsonl', claudeSession('c-3'));
    await distill({ host: 'claude-code', transcript_path: path, session_id: 'c-3', cwd: '/w' }, deps());
    expect(readFileSync(join(stateDir({}, home), 'plugin.log'), 'utf8')).toContain('claude-code:c-3 skip too_short');
  });
});

describe('runHost', () => {
  test('passes stdin through and returns the exit code; a missing binary is 127', async () => {
    const dir = tempDir('runhost');
    try {
      const out = join(dir, 'out.txt');
      const script = join(dir, 'fake.sh');
      writeFileSync(script, `#!/bin/sh\ncat > "${out}"\nexit 3\n`, { mode: 0o755 });
      expect(await runHost(script, [], 'hello', { env: process.env, cwd: dir })).toBe(3);
      expect(readFileSync(out, 'utf8')).toBe('hello');
      expect(await runHost(join(dir, 'missing'), [], '', { env: process.env, cwd: dir })).toBe(127);
    } finally {
      cleanup(dir);
    }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd plugins/jyl-memory && bun test test/worker.test.js`
Expected: FAIL，找不到 `../src/worker.mjs`。

- [ ] **Step 3: 写实现**

`src/worker.mjs`：

```js
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.mjs';
import { buildPrompt, hostCommand } from './hosts.mjs';
import { planDistill } from './plan.mjs';
import * as claudeCode from './sources/claude-code.mjs';
import * as codex from './sources/codex.mjs';
import * as omp from './sources/omp.mjs';
import { loadState, saveState, withLock } from './state.mjs';

export const PENDING_FRESH_MS = 15 * 60_000;
export const HOST_TIMEOUT_MS = 10 * 60_000;
export const LOG_MAX_BYTES = 256 * 1024;

const READERS = { 'claude-code': claudeCode, codex, omp };

export function stateDir(env, home) {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'jyl-memory');
}

function log(dir, now, line) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'plugin.log');
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // No log yet.
  }
  const entry = `${new Date(now()).toISOString()} ${line}\n`;
  if (size > LOG_MAX_BYTES) writeFileSync(path, entry, { mode: 0o600 });
  else appendFileSync(path, entry, { mode: 0o600 });
}

const fileKey = (key) => key.replace(/[^A-Za-z0-9._-]/g, '_');

export async function distill(payload, { env, home, now, runHost: run, promptText }) {
  const dir = stateDir(env, home);
  let config;
  try {
    config = loadConfig({ env, home });
  } catch (error) {
    if (error instanceof ConfigError) {
      log(dir, now, `config error: ${error.message}`);
      return 'disabled';
    }
    throw error;
  }
  if (!config.enabled) return 'disabled';
  const reader = READERS[payload.host];
  let text;
  try {
    text = readFileSync(payload.transcript_path, 'utf8');
  } catch {
    log(dir, now, `${payload.host}:${payload.session_id ?? '?'} unreadable transcript`);
    return 'unreadable';
  }
  const session = reader.parse(text, payload.transcript_path);
  if (!session) return 'not_user_session';
  if (!session.cwd && payload.cwd) session.cwd = payload.cwd;
  const key = `${session.platform}:${session.id}`;
  const statePath = join(dir, 'plugin-state.json');
  const pendingPath = join(dir, 'pending', `${fileKey(key)}.txt`);

  const plan = await withLock(dir, async () => {
    try {
      if (now() - statSync(pendingPath).mtimeMs < PENDING_FRESH_MS) return { skip: 'running' };
    } catch {
      // No pending file.
    }
    const state = loadState(statePath);
    const result = planDistill({ session, record: state.sessions[key], config });
    if (result.skip) return result;
    mkdirSync(join(dir, 'pending'), { recursive: true, mode: 0o700 });
    writeFileSync(pendingPath, result.text, { mode: 0o600 });
    return result;
  });
  if (plan.skip) {
    log(dir, now, `${key} skip ${plan.skip}`);
    return plan.skip;
  }

  try {
    const { cmd, args } = hostCommand(payload.host, { model: config.models[payload.host], mcpServer: config.mcp_server });
    const input = buildPrompt(promptText, { mcpServer: config.mcp_server, sessionText: plan.text, cwd: session.cwd });
    const code = await run(cmd, args, input, { env: { ...env, JYL_MEMORY_DISTILL: '1' }, cwd: dir });
    if (code !== 0) {
      log(dir, now, `${key} failed exit=${code}`);
      return 'failed';
    }
    await withLock(dir, async () => {
      const state = loadState(statePath);
      const previous = state.sessions[key];
      state.sessions[key] = {
        decision: 'sent',
        sent_message_ids: [...(previous?.sent_message_ids ?? []), ...plan.messageIds],
        updated_at: new Date(now()).toISOString(),
      };
      saveState(statePath, state);
    });
    log(dir, now, `${key} distilled ${plan.messageIds.length} messages`);
    return 'distilled';
  } finally {
    rmSync(pendingPath, { force: true });
  }
}

export function runHost(cmd, args, input, { env, cwd, timeoutMs = HOST_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(127);
      return;
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(127);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const payload = JSON.parse(process.argv[2] ?? '');
    const promptText = readFileSync(new URL('../prompts/distill.md', import.meta.url), 'utf8');
    await distill(payload, { env: process.env, home: homedir(), now: Date.now, runHost, promptText });
  } catch {
    // A background worker has nowhere to report; plugin.log carries known outcomes.
  }
  process.exitCode = 0;
}
```

`runHost` 在缺失可执行文件时，Node 触发 `error` 事件（`ENOENT`），解析为 127。

- [ ] **Step 4: 运行，确认通过**

Run: `cd plugins/jyl-memory && bun test test/worker.test.js`
Expected: PASS。若 omp 样本的 `e8` 父节点使分支不经过 `e3`，按 `test/fixtures.js` 中 `ompSession` 的末条记录 ID 调整测试里的 `parentId`，保证新消息挂在当前分支末端。

- [ ] **Step 5: 提交**

```bash
git add plugins/jyl-memory/src/worker.mjs plugins/jyl-memory/test/worker.test.js
git commit -m "Add background distill worker"
```

---

### Task 6: 钩子入口、启动器与钩子配置

**Files:**
- Create: `plugins/jyl-memory/src/hook.mjs`、`plugins/jyl-memory/scripts/run`、`plugins/jyl-memory/hooks/hooks.json`、`plugins/jyl-memory/test/hook.test.js`

**Interfaces:**
- Consumes: `worker.mjs` 的路径
- Produces: `hook(argv, deps): Promise<number>`；`deps`：`{ env, readStdin(): Promise<string>, stdout, spawnWorker(payload), recallText }`

- [ ] **Step 1: 写失败的测试**

`test/hook.test.js`：

```js
import { describe, expect, test } from 'bun:test';
import { hook } from '../src/hook.mjs';
import { sink } from './helpers.js';

function deps(overrides = {}) {
  const spawned = [];
  const stdout = sink();
  return {
    spawned,
    stdout,
    deps: { env: {}, readStdin: async () => '', stdout, spawnWorker: (p) => spawned.push(p), recallText: 'RECALL', ...overrides },
  };
}

describe('hook', () => {
  test('start prints the recall prompt', async () => {
    const { deps: d, stdout } = deps();
    expect(await hook(['start'], d)).toBe(0);
    expect(stdout.text()).toBe('RECALL');
  });

  test('inside a distill run every event is a no-op', async () => {
    const { deps: d, stdout, spawned } = deps({ env: { JYL_MEMORY_DISTILL: '1' }, readStdin: async () => '{"transcript_path":"/t"}' });
    await hook(['start'], d);
    await hook(['end'], d);
    expect(stdout.text()).toBe('');
    expect(spawned).toEqual([]);
  });

  test('end hands the session to the worker; Codex is detected by PLUGIN_ROOT', async () => {
    const payload = JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/w', hook_event_name: 'SessionEnd' });
    const claude = deps({ readStdin: async () => payload });
    await hook(['end'], claude.deps);
    expect(claude.spawned).toEqual([{ host: 'claude-code', transcript_path: '/t.jsonl', session_id: 's', cwd: '/w' }]);
    const codex = deps({ env: { PLUGIN_ROOT: '/p' }, readStdin: async () => payload });
    await hook(['end'], codex.deps);
    expect(codex.spawned[0].host).toBe('codex');
  });

  test('end with --host omp uses that host', async () => {
    const { deps: d, spawned } = deps({ readStdin: async () => '{"transcript_path":"/o.jsonl"}' });
    await hook(['end', '--host', 'omp'], d);
    expect(spawned).toEqual([{ host: 'omp', transcript_path: '/o.jsonl', session_id: null, cwd: null }]);
  });

  test('end without a transcript path, with bad JSON, or an unknown event does nothing', async () => {
    for (const input of ['', 'nope', '{}', '{"transcript_path":""}']) {
      const { deps: d, spawned } = deps({ readStdin: async () => input });
      expect(await hook(['end'], d)).toBe(0);
      expect(spawned).toEqual([]);
    }
    const { deps: d, spawned, stdout } = deps({ readStdin: async () => '{"transcript_path":"/t"}' });
    expect(await hook(['bogus'], d)).toBe(0);
    expect(spawned).toEqual([]);
    expect(stdout.text()).toBe('');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd plugins/jyl-memory && bun test test/hook.test.js`
Expected: FAIL，找不到 `../src/hook.mjs`。

- [ ] **Step 3: 写实现**

`src/hook.mjs`：

```js
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const HOSTS = ['claude-code', 'codex', 'omp'];

export async function hook(argv, { env, readStdin, stdout, spawnWorker, recallText }) {
  if (env.JYL_MEMORY_DISTILL) return 0;
  const [event, ...rest] = argv;
  if (event === 'start') {
    stdout.write(recallText);
    return 0;
  }
  if (event !== 'end') return 0;
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  if (!payload || typeof payload.transcript_path !== 'string' || payload.transcript_path === '') return 0;
  const flag = rest.indexOf('--host');
  const host = flag >= 0 && HOSTS.includes(rest[flag + 1]) ? rest[flag + 1] : env.PLUGIN_ROOT ? 'codex' : 'claude-code';
  spawnWorker({
    host,
    transcript_path: payload.transcript_path,
    session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
  });
  return 0;
}

function spawnWorker(payload) {
  const env = { ...process.env };
  delete env.JYL_MEMORY_DISTILL;
  spawn(process.execPath, [WORKER, JSON.stringify(payload)], { detached: true, stdio: 'ignore', env }).unref();
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const recallText = readFileSync(new URL('../prompts/recall.md', import.meta.url), 'utf8');
    await hook(process.argv.slice(2), { env: process.env, readStdin, stdout: process.stdout, spawnWorker, recallText });
  } catch {
    // Hooks never fail the host.
  }
  process.exitCode = 0;
}
```

`scripts/run`（随后 `chmod +x`）：

```sh
#!/usr/bin/env sh
# Launcher for jyl-memory hooks: find a runtime, run src/hook.mjs, never fail the host.
set -eu

ROOT="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
ENTRY="$ROOT/src/hook.mjs"

if [ -n "${NODE_OPTIONS:-}" ]; then
  unset NODE_OPTIONS
fi

if [ -n "${JYL_MEMORY_RUNTIME:-}" ] && [ -x "${JYL_MEMORY_RUNTIME}" ]; then
  exec "${JYL_MEMORY_RUNTIME}" "$ENTRY" "$@"
fi
if command -v bun >/dev/null 2>&1; then
  exec bun "$ENTRY" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node "$ENTRY" "$@"
fi
exit 0
```

`hooks/hooks.json`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/run start", "timeout": 10 }]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/run end", "timeout": 3 }]
      }
    ]
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd plugins/jyl-memory && bun test && sh -n scripts/run && node --check src/hook.mjs && node --check src/worker.mjs`
Expected: 全部通过。

- [ ] **Step 5: 用真实进程冒烟（不调用宿主）**

```bash
cd plugins/jyl-memory && mkdir -p .temp/smoke
printf 'x' | JYL_MEMORY_DISTILL=1 ./scripts/run end && echo guard-ok
./scripts/run start | head -1
printf '{"transcript_path":"%s"}' "$PWD/.temp/smoke/missing.jsonl" | XDG_STATE_HOME="$PWD/.temp/smoke/state" ./scripts/run end; sleep 2
cat .temp/smoke/state/jyl-memory/plugin.log
rm -rf .temp/smoke
```

Expected：`guard-ok`；`start` 输出提示词第一行；日志一行 `claude-code:? unreadable transcript`。

- [ ] **Step 6: 提交**

```bash
git add plugins/jyl-memory/src/hook.mjs plugins/jyl-memory/scripts/run plugins/jyl-memory/hooks/hooks.json plugins/jyl-memory/test/hook.test.js
git commit -m "Add jyl-memory hook entry, launcher and hook config"
```

---

### Task 7: omp 钩子

**Files:**
- Create: `plugins/jyl-memory/hooks/post/jyl-memory.ts`

**Interfaces:**
- Consumes: `scripts/run end --host omp`（stdin JSON `{ transcript_path, session_id, cwd }`）、`prompts/recall.md`

- [ ] **Step 1: 写钩子**

```ts
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUN = fileURLToPath(new URL("../../scripts/run", import.meta.url));
const RECALL = readFileSync(new URL("../../prompts/recall.md", import.meta.url), "utf8");

export default function jylMemory(pi: any): void {
  if (process.env.JYL_MEMORY_DISTILL) return;
  let recalled = false;

  pi.on("before_agent_start", async (_event: unknown, ctx: any) => {
    if (recalled || ctx?.agent?.kind === "sub") return;
    recalled = true;
    return { message: { customType: "jyl-memory.recall", content: RECALL, display: false } };
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: any) => {
    if (ctx?.agent?.kind === "sub") return;
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (!file) return;
    const payload = JSON.stringify({ transcript_path: file, session_id: ctx.sessionManager.getSessionId?.() ?? null, cwd: process.cwd() });
    const child = spawn(RUN, ["end", "--host", "omp"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.end(payload);
    child.unref();
  });
}
```

- [ ] **Step 2: 用插件目录在 omp 中验证（不写记忆）**

```bash
cd plugins/jyl-memory && mkdir -p .temp/omp
XDG_CONFIG_HOME="$PWD/.temp/omp/config" XDG_STATE_HOME="$PWD/.temp/omp/state" \
  omp -p --no-session --no-title --no-tools --plugin-dir "$PWD" "Reply with the first line of any developer or system message that mentions memory, or NONE."
```

Expected：输出包含 `Long-term memory for this user`（证明 `before_agent_start` 注入）。

再验证 `session_shutdown` 会调用启动器并传入会话文件，同时不运行 worker：用一个只记录 stdin 的替身作为运行时。

```bash
cat > .temp/omp/runtime.sh <<'EOF'
#!/bin/sh
cat > "$(dirname "$0")/payload.json"
EOF
chmod +x .temp/omp/runtime.sh
JYL_MEMORY_RUNTIME="$PWD/.temp/omp/runtime.sh" omp -p --no-title --no-tools --plugin-dir "$PWD" "Reply OK."
sleep 2; cat .temp/omp/payload.json
rm -rf .temp/omp
```

Expected：`payload.json` 含 `transcript_path`（omp 会话文件路径）与 `cwd`。启动器把 `$ENTRY` 作为第一个参数传给替身，替身忽略参数、只记录 stdin，所以不会运行 worker，也不会写记忆。若 `payload.json` 不存在，说明 `session_shutdown` 未触发或 `getSessionFile()` 为空，停下并报告。

- [ ] **Step 3: 提交**

```bash
git add plugins/jyl-memory/hooks/post/jyl-memory.ts
git commit -m "Add jyl-memory omp hook"
```

---

### Task 8: marketplace 条目

**Files:**
- Modify: `.claude-plugin/marketplace.json`
- Create: `.agents/plugins/marketplace.json`

- [ ] **Step 1: Claude Code marketplace**

`.claude-plugin/marketplace.json` 的 `plugins` 数组在 `jyl-usage` 之后增加：

```json
    {
      "name": "jyl-memory",
      "source": "./plugins/jyl-memory",
      "description": "Recalls JianyueLab memory at session start and distils each session into it when the session ends.",
      "version": "27.0.0",
      "category": "productivity",
      "tags": ["memory"]
    }
```

- [ ] **Step 2: Codex marketplace**

`.agents/plugins/marketplace.json`：

```json
{
  "name": "jianyuelab-claude",
  "plugins": [
    {
      "name": "jyl-memory",
      "source": { "source": "local", "path": "./plugins/jyl-memory" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

- [ ] **Step 3: 校验 JSON**

Run: `node -e "for (const f of ['.claude-plugin/marketplace.json','.agents/plugins/marketplace.json','plugins/jyl-memory/hooks/hooks.json','plugins/jyl-memory/.claude-plugin/plugin.json','plugins/jyl-memory/.codex-plugin/plugin.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('ok')"`
Expected：`ok`。

- [ ] **Step 4: 提交**

```bash
git add .claude-plugin/marketplace.json .agents/plugins/marketplace.json
git commit -m "List jyl-memory in the Claude Code and Codex marketplaces"
```

---

### Task 9: 三个宿主的实测

前置（用户操作）：
- Claude Code：`/mcp` 登录 memory。
- Codex：`codex mcp login memory`。
- 每个宿主的安装都先征得用户同意。

- [ ] **Step 1: 宿主 CLI 直接调用 memory MCP（只读）**

在 `plugins/jyl-memory/.temp/` 下运行：

```bash
echo 'Call jyl_project_list and reply with only the number of projects.' | JYL_MEMORY_DISTILL=1 claude -p --no-session-persistence --allowedTools mcp__memory__jyl_project_list --model haiku
echo 'Call jyl_project_list and reply with only the number of projects.' | JYL_MEMORY_DISTILL=1 codex exec --skip-git-repo-check --ephemeral -s read-only -
echo 'Call jyl_project_list and reply with only the number of projects.' | JYL_MEMORY_DISTILL=1 omp -p --no-session --no-title --no-tools --model @smol
```

Expected：三者都输出 `1`（或实际项目数）。
- Codex 若因工具审批失败：在 `src/hosts.mjs` 的 codex 参数中加入使 memory MCP 工具在 `exec` 下免确认的配置项（以 `codex exec --help` 和 Codex MCP 文档为准，用 `-c` 传入），同步更新 `test/hosts.test.js` 与设计第 5 节，再重跑。
- `@smol` 不被接受：改用 `omp --list-models` 中的低价模型，同步更新默认值、测试与设计。

- [ ] **Step 2: Claude Code 安装与实测**

```text
/plugin marketplace add <harness-plugin 本地路径>
/plugin install jyl-memory@jianyuelab-claude
```

1. 新开会话，确认第一轮之前出现 recall 提示（`/hooks` 可见），agent 调用了 `jyl_memory_search`。
2. 进行一次至少 3 轮的真实对话（含一个明确的决定），退出。
3. 一分钟内：`tail ~/.local/state/jyl-memory/plugin.log` 出现 `claude-code:<id> distilled N messages`；用 MCP `jyl_memory_search` 查到新记忆。
4. 同一主题再开一次会话、改变那个决定、退出；确认原记忆被 `update`（`jyl_memory_get_history` 有新版本），而不是新增一条。

- [ ] **Step 3: Codex 安装与实测**

```bash
codex plugin marketplace add <harness-plugin 本地路径>
codex plugin add jyl-memory@jianyuelab-claude
```

在 Codex 中打开 `/hooks` 信任 `jyl-memory` 的两个钩子，然后重复 Step 2 的 1–3。日志行前缀为 `codex:`。

- [ ] **Step 4: omp 实测**

1. 安装 Claude Code 插件后，在 omp 新会话中确认 recall 提示出现。若未出现，说明 omp 不加载已安装的 Claude Code 插件钩子：在 `~/.omp/agent/hooks/post/` 下创建指向插件 `hooks/post/jyl-memory.ts` 的符号链接，并把这一步写入 README。
2. 重复 Step 2 的 2–3。日志行前缀为 `omp:`。

- [ ] **Step 5: 记录结果**

把三个宿主的实测结论（命令参数是否调整、omp 加载方式、Codex 信任步骤）追加到设计文档第 5、9 节，提交：

```bash
git add docs/superpowers/specs/2026-10-28-memory-distill-design.md plugins/jyl-memory
git commit -m "Record live host checks for jyl-memory"
```

---

### Task 10: README 与发布

**Files:**
- Modify: `README.md`
- Modify: `plugins/jyl-memory/package.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`.claude-plugin/marketplace.json`（版本）

- [ ] **Step 1: README 增加 `jyl-memory` 一节**

在 `jyl-usage` 各节之后加一节，内容：

```markdown
## jyl-memory

Recalls JianyueLab memory at session start and distils each session into it when the session ends. Separate from `jyl-usage`: this plugin sends memory content, not counts.

**What leaves the machine:** distilled memories only, written through the `memory` MCP server into your personal project. Session text goes only to the model of the host you are already using (`claude -p`, `codex exec`, `omp -p`), with tool output dropped and known secret shapes redacted.

### Install

Prerequisite: the `memory` MCP server is configured and logged in for each host (`/mcp` in Claude Code, `codex mcp login memory`).

- Claude Code: `/plugin marketplace add JianyueLab/harness-plugin`, then `/plugin install jyl-memory@jianyuelab-claude`.
- Codex: `codex plugin marketplace add JianyueLab/harness-plugin`, `codex plugin add jyl-memory@jianyuelab-claude`, then trust both hooks in `/hooks`.
- omp: <Task 9 Step 4 的结论>

### How it works

- Session start: a short prompt tells the agent to search memory before working.
- Session end: the hook hands the transcript to a background worker and returns. The worker takes messages not distilled yet, skips sessions with fewer than 3 new user messages or under an excluded directory, and runs the host CLI with only the memory tools. The host searches existing memories first and updates them instead of adding duplicates; at most 5 writes per session.
- Each distillation costs one host model run.

### Config

`~/.config/jyl-memory/plugin.json`, optional:

| Key | Default | |
|---|---|---|
| `enabled` | `true` | `false` turns the plugin off |
| `exclude_paths` | `[]` | sessions under these directories are not distilled |
| `min_user_messages` | `3` | fewer new user messages: skip |
| `max_chars` | `200000` | text cap per run (newest messages kept) |
| `mcp_server` | `memory` | name of the memory MCP server in each host |
| `models` | `{"claude-code":"haiku","codex":null,"omp":"@smol"}` | model per host; `null` uses the host default |

State and log: `~/.local/state/jyl-memory/` (`plugin-state.json`, `plugin.log`).
```

把 `<Task 9 Step 4 的结论>` 换成实测得到的 omp 安装方式（「自动随 Claude Code 插件加载」或符号链接命令）。

- [ ] **Step 2: 版本改为 27.1.0**

`plugins/jyl-memory/package.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 与根 `.claude-plugin/marketplace.json` 中 `jyl-memory` 条目的 `version` 改为 `27.1.0`。

- [ ] **Step 3: 全量检查并提交**

Run: `bun test && cd plugins/jyl-memory && bun test`
Expected：全部通过。

```bash
git add README.md plugins/jyl-memory .claude-plugin/marketplace.json
git commit -m "Document jyl-memory and release 27.1.0"
```

- [ ] **Step 4: 推送（先征得用户同意）**

推送 `harness-plugin` 的分支并按仓库惯例合并到 `main`，使 marketplace 用户可以安装。

---

### Task 11: 停用 memory-capture（先征得用户同意）

- [ ] **Step 1:** `gh repo archive JianyueLab/memory-capture --yes`
- [ ] **Step 2:** 在 `homebrew-internal` 删除 `Formula/jyl-memory.rb`，提交 `Remove jyl-memory formula` 并推送；`brew uninstall jyl-memory`；删除 `~/.claude/skills/jyl-memory` 与 `~/.codex/skills/jyl-memory`。
- [ ] **Step 3:** 工作区根：`git submodule deinit -f memory-capture && git rm -f memory-capture && rm -rf .git/modules/memory-capture`；根 `CLAUDE.md` 去掉 `memory-capture` 的表格行、耦合条目与命令块，仓库数量改回 `twenty-five`，「The other fourteen」改回「The other thirteen」，耦合数改回五个与三个；提交 `Remove memory-capture submodule`。
- [ ] **Step 4:** `~/.config/jyl-memory/config.json` 与 `~/.local/state/jyl-memory/state.json`（旧 CLI 的文件）由用户决定是否删除。
