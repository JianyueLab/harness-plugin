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
  .codex-plugin/plugin.json      Codex 清单
  hooks/hooks.json               SessionStart、SessionEnd（Claude Code 与 Codex 同格式）
  omp/jyl-memory.ts              omp 钩子（session_start、session_shutdown）
  prompts/distill.md             提炼提示词
  prompts/recall.md              开工时注入的提示
  scripts/run                    启动器：选 bun 或 node，总以 0 退出
  src/hook.mjs                   入口：解析钩子数据，分派 start / end
  src/sources/                   读取器（来自 memory-capture，Claude Code / Codex / omp）
  src/filter.mjs、src/scrub.mjs  正文过滤与脱敏（来自 memory-capture）
  src/state.mjs                  每个会话的提炼进度与文件锁
  src/distill.mjs                组装输入，后台启动宿主 CLI
  test/
```

`.claude-plugin/marketplace.json` 增加 `jyl-memory`，`source` 为 `./plugins/jyl-memory`。
`.agents/plugins/marketplace.json` 增加同一插件，供 Codex 使用。

## 4. 会话开始：读取

- Claude Code、Codex：`SessionStart` 钩子输出 `prompts/recall.md` 的内容，作为上下文注入。
- omp：`session_start` 钩子注入同一段内容。
- 提示内容：记忆在 memory MCP；开始任务前，用任务关键词调用 `jyl_memory_search`，并调用 `jyl_project_get_context` 取个人项目的事实与决定；本插件会在会话结束时写入记忆，agent 不需要自己写。
- 不访问网络，不需要 token。

## 5. 会话结束：提炼

1. 钩子收到会话 ID 与记录文件路径。环境变量 `JYL_MEMORY_DISTILL=1` 存在时立即退出，避免后台提炼会话再次触发自己。
2. 用对应读取器读出正文（只含用户与助手文本，规则同 `memory-capture` 设计第 6、7 节）。
3. 跳过条件：
   - 会话目录在 `exclude_paths` 之内；
   - 自上次提炼以来新增的用户消息少于 `min_user_messages`（默认 3）。
4. 只取上次提炼之后新增的消息。正文总长超过 `max_chars`（默认 200000）时只保留最后 `max_chars` 个字符。
5. 把正文写入 `$XDG_STATE_HOME/jyl-memory/pending/<会话键>.txt`（权限 0600），以脱离进程的方式启动宿主 CLI，然后立即返回。宿主 CLI 的环境带 `JYL_MEMORY_DISTILL=1`。
6. 宿主 CLI 收到 `prompts/distill.md` 与正文文件路径，按提示词执行：
   - 读正文；
   - 对候选主题先调用 `jyl_memory_search` 查已有记忆；
   - 已有记忆过时则 `jyl_memory_update`，没有则 `jyl_memory_add`；
   - 每次会话最多写 5 条；没有值得长期记住的内容就不写；
   - 不写密钥、token、密码、个人隐私数据。
7. 宿主 CLI 以 0 退出后，状态记下本次已提炼到的最后一条消息 ID，并删除正文文件。失败时保留进度不变，下次结束时连同新消息一起重试。

宿主 CLI 的调用：

| 宿主 | 命令 | 工具限制 |
|---|---|---|
| Claude Code | `claude -p --model <model>` | `--allowedTools` 只含 Read 与四个 memory 工具 |
| Codex | `codex exec --model <model> -s read-only` | memory MCP 免确认；只读沙箱 |
| omp | `omp -p --model <model>` | 只开 read 与 memory MCP |

`<model>` 默认取各宿主的低价模型，可在配置中改。具体命令行参数在实施前逐个实测确定。

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
