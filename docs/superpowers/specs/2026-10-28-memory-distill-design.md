# 会话记忆提炼插件设计

日期：2026-10-28。
仓库：`JianyueLab/harness-plugin`（marketplace `jianyuelab-claude`）。
状态：待审阅。

## 1. 目标与边界

会话结束后，由宿主 agent 在本机提炼本次会话的记忆，通过 memory MCP 写入 `memory` 服务。
下次会话开始时，agent 先读取相关记忆。
用户安装一次，之后不需要任何操作。

不做：上传会话原文、服务端提取、手动挑选会话、CLI 命令、语义去重、定期整理。

## 2. 已作决定

- 新插件 `jyl-memory`，放在 `harness-plugin/plugins/jyl-memory/`。与 `jyl-usage` 分开：`jyl-usage` 只上报计数，本插件发送记忆内容。
- 支持 Claude Code、Codex、omp。
- 提炼由宿主自己的 CLI 无界面运行：`claude -p`、`codex exec`、`omp -p`。不另配模型 key。
- 写入只用 memory MCP：`jyl_memory_search`、`jyl_memory_get`、`jyl_memory_add`、`jyl_memory_update`。记忆写入个人项目 My memory，`visibility` 为 `private`，`state` 为 `active`。
- 原文不离开本机。发送给模型的只有过滤、脱敏后的正文，模型提供商与会话本身相同。
- 记忆没有原文出处（`sources` 为空）。
- 零依赖 ESM，由 `bun` 或 `node` 运行，与 `jyl-usage` 相同。
- `memory-capture` 仓库与 `jyl-memory` CLI 在本插件上线后停用。

## 3. 组成

```text
plugins/jyl-memory/
  .claude-plugin/plugin.json     Claude Code 清单
  .codex-plugin/plugin.json      Codex 清单（hooks 指向 ./hooks/hooks.json）
  hooks/hooks.json               SessionStart、SessionEnd（Claude Code 与 Codex 同格式，omp 忽略）
  hooks/post/jyl-memory.ts       omp 钩子（before_agent_start、session_shutdown；Claude Code 与 Codex 忽略）
  prompts/distill.md             提炼提示词
  prompts/recall.md              开工时注入的提示
  scripts/run                    启动器：选 bun 或 node，总以 0 退出
  src/hook.mjs                   钩子入口：start 输出提示；end 交给后台 worker 后立即返回
  src/worker.mjs                 后台：读取、截取、运行宿主 CLI、更新状态
  src/plan.mjs                   跳过条件与增量截取
  src/hosts.mjs                  各宿主 CLI 的命令行
  src/config.mjs                 插件配置
  src/sources/                   读取器（来自 memory-capture）
  src/filter.mjs、src/scrub.mjs  正文过滤与脱敏（来自 memory-capture）
  src/state.mjs                  提炼进度与文件锁（来自 memory-capture，状态文件改名）
  test/
```

`.claude-plugin/marketplace.json` 增加 `jyl-memory`，`source` 为 `./plugins/jyl-memory`。
`.agents/plugins/marketplace.json` 增加同一插件，供 Codex 使用；marketplace 名同为 `jianyuelab-claude`。

实测（2026-10-28）：
- omp 从插件目录加载 `hooks/post/*.ts`，`session_start` 与 `session_shutdown` 都触发；omp 不执行 `hooks/hooks.json`。
- Codex 执行插件 `hooks/hooks.json` 中的 `SessionStart` 与 `SessionEnd`；首次需在 `/hooks` 信任；`codex exec` 也触发这些钩子。Codex 为插件钩子同时设置 `PLUGIN_ROOT` 与 `CLAUDE_PLUGIN_ROOT`。`SessionEnd` 超时默认 1 秒、最多 3 秒。
- `omp -p --no-session --tools read` 能调用 memory MCP。
- Codex 与 Claude Code 的 memory MCP 需先登录，登录前后台调用失败。

## 4. 会话开始：读取

- Claude Code、Codex：`SessionStart` 钩子把 `prompts/recall.md` 的内容输出到 stdout，两者都把它作为上下文注入。
- omp：`before_agent_start` 在会话第一次提问时注入同一段内容；子 agent 不注入。
- 提示内容：记忆在 memory MCP；开始任务前，用任务关键词调用 `jyl_memory_search`，并调用 `jyl_project_get_context` 取个人项目的事实与决定；本插件会在会话结束时写入记忆，agent 不需要自己写。
- 不访问网络，不需要 token。

## 5. 会话结束：提炼

1. 钩子收到会话 ID 与记录文件路径（Claude Code、Codex 从 stdin JSON 的 `session_id`、`transcript_path`、`cwd`；omp 由 `ctx.sessionManager.getSessionFile()`）。环境变量 `JYL_MEMORY_DISTILL=1` 存在时立即退出，避免后台提炼会话再次触发自己。钩子把数据交给后台 worker 后立即返回，不读会话文件。
2. 用对应读取器读出正文（只含用户与助手文本，规则同 `memory-capture` 设计第 6、7 节）。
3. 跳过条件：
   - 会话目录在 `exclude_paths` 之内；
   - 自上次提炼以来新增的用户消息少于 `min_user_messages`（默认 3）。
4. 只取上次提炼之后新增的消息。正文总长超过 `max_chars`（默认 200000）时只保留最后 `max_chars` 个字符。
5. worker 把正文写入 `$XDG_STATE_HOME/jyl-memory/pending/<会话键>.txt`（权限 0600）。同一会话已有不到 15 分钟的 pending 文件时跳过，视为上一次仍在运行。
6. worker 启动宿主 CLI，提示词与正文经 stdin 传入，环境带 `JYL_MEMORY_DISTILL=1`，超时 10 分钟。宿主按提示词执行：
   - 读正文；
   - 对候选主题先调用 `jyl_memory_search` 查已有记忆；
   - 已有记忆过时则 `jyl_memory_update`，没有则 `jyl_memory_add`；
   - 每次会话最多写 5 条；没有值得长期记住的内容就不写；
   - 不写密钥、token、密码、个人隐私数据。
7. 宿主 CLI 以 0 退出后，状态记下本次已提炼到的最后一条消息 ID，并删除正文文件。失败时保留进度不变，下次结束时连同新消息一起重试。

宿主 CLI 的调用：

| 宿主 | 命令 | 工具限制 |
|---|---|---|
| Claude Code | `claude -p --no-session-persistence --model <model>` | `--allowedTools` 只含四个 memory 工具 |
| Codex | `codex exec --skip-git-repo-check --ephemeral -s read-only [-m <model>] -` | memory MCP 工具免确认（参数在实施时实测） |
| omp | `omp -p --no-session --no-title --max-time 10m [--model <model>]` | 不开内置工具，只用 memory MCP（实施时实测 `--no-tools` 下 MCP 是否可用） |

`<model>` 默认：Claude Code 为 `haiku`，omp 为 `@smol`，Codex 用其默认模型。可在配置中改。

## 6. 记忆格式

- `kind`：`fact`、`decision`、`preference`、`project` 之一。
- `title`：一句话。
- `content`：事实本身，加上项目或仓库名、日期。不复述对话过程。
- 提示词要求更新优先于新增：同一主题已有记忆时更新它。

## 7. 配置

文件：`~/.config/jyl-memory/plugin.json`，可选。

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关闭插件 |
| `exclude_paths` | `[]` | 这些目录下的会话不提炼 |
| `min_user_messages` | `3` | 新增用户消息少于此数不提炼 |
| `max_chars` | `200000` | 单次提炼正文上限 |
| `mcp_server` | `memory` | 各宿主中 memory MCP 的服务名 |
| `models` | 各宿主低价模型 | `{ "claude-code": …, "codex": …, "omp": … }` |

状态：`$XDG_STATE_HOME/jyl-memory/plugin-state.json` 记录每个会话的最后已提炼消息 ID。日志：同目录 `log`，上限 256 KB。

## 8. 前置条件

- 三个宿主都已配置 memory MCP 并完成登录。Claude Code 当前显示 `Needs authentication`，需在 `/mcp` 登录一次。
- `bun` 或 `node` 在 `PATH` 上。

## 9. 安装

- Claude Code：`/plugin marketplace add JianyueLab/claude-plugin`，`/plugin install jyl-memory@jianyuelab-claude`。
- Codex：`codex plugin marketplace add JianyueLab/harness-plugin`，安装 `jyl-memory`。若 Codex CLI 不加载插件钩子，改为在 `~/.codex/hooks.json` 写入同一钩子，README 给出原文。
- omp：把 `omp/jyl-memory.ts` 复制到 `~/.omp/agent/hooks/post/`。若 omp 能加载 Claude Code 插件钩子，则不需要这一步。

## 10. 停用 memory-capture

本插件在三个宿主验证通过后：
- 归档 GitHub 仓库 `JianyueLab/memory-capture`；
- 删除 `homebrew-internal` 的 `jyl-memory` formula；
- 从工作区移除 `memory-capture` submodule，并更新根 `CLAUDE.md`；
- 卸载本机的 `jyl-memory` 与它安装的 skill。

服务端的 `model_consent` 与提取流程保留，不再被本插件使用。

## 11. 测试

- `bun test`：读取器与脱敏沿用 `memory-capture` 的测试；新增钩子分派、跳过条件、增量截取、状态更新、递归保护的测试。宿主 CLI 用替身。
- 实测：在三个宿主各结束一次会话，确认 memory 中出现新记忆，且同一主题再次出现时被更新而不是新增；确认新会话开始时 agent 先调用 `jyl_memory_search`。
