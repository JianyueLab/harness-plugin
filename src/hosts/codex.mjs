/**
 * Codex CLI → llm-web。
 *
 * 一个"单元"是一份 rollout 文件(`~/.codex/sessions/<Y>/<M>/<D>/rollout-*-<uuid>.jsonl`),
 * 游标是字节偏移 —— 与 Claude Code 那个 host 同类,因为两者都是追加写的 JSONL。
 *
 * **只有计数离开这台机器。** 模型名、时间戳、token 数、合成的 requestId ——
 * 绝不包括 cwd、workspace_roots、对话内容,哪怕 rollout 文件里都有。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventsFrom } from "./codex/parse.mjs";

const CODEX_DIR = path.join(os.homedir(), ".codex");

/** 可变,好让测试指向夹具目录。 */
export const roots = { sessions: path.join(CODEX_DIR, "sessions") };

const walkJsonl = (dir, out = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
};

/** 游标的初始状态。文件变短时也回到这里。 */
const fresh = () => ({ offset: 0, seen: 0, lastTotal: null, model: null, sessionId: null, provider: null });

export const host = {
  id: "codex",
  source: "codex",
  client: "codex-usage-reporter/27.1.1",
  title: "jyl-usage — Codex CLI → llm-web usage reporter",
  unitLabel: "session",
  stateDir: path.join(CODEX_DIR, "jyl-usage"),

  // Stop 的载荷给 session_id 但不给文件路径;而 session_meta.payload.id 与文件名
  // 尾部的 uuid 逐字相同(实测 30 份),所以按后缀匹配即可。
  unitsFromHook(hook) {
    const id = typeof hook.session_id === "string" ? hook.session_id : null;
    if (!id) return [];
    return walkJsonl(roots.sessions).filter((f) => path.basename(f, ".jsonl").endsWith(`-${id}`));
  },

  recentUnits(days) {
    const cutoff = Date.now() - days * 86_400_000;
    return walkJsonl(roots.sessions).filter((f) => {
      try {
        return fs.statSync(f).mtimeMs >= cutoff;
      } catch {
        return false; // vanished mid-walk
      }
    });
  },

  probe(unit, entry) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return null;
    }
    const offset = entry.offset ?? 0;
    // 文件变短说明被替换过,整份都要重读。
    const pending = stat.size < offset ? stat.size : stat.size - offset;
    return { mtimeMs: stat.mtimeMs, pending };
  },

  read(unit, entry, _log, maxEvents = Infinity) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return { events: [], entry: null };
    }

    // 变短 = 轮转或被替换。**三个游标一起回零**:只重置 offset 的话,重读的首条会
    // 与旧的 lastTotal 做差、得到负数,白白撞上回退分支。
    let cur = stat.size < (entry.offset ?? 0) ? fresh() : { ...fresh(), ...entry };
    if (cur.offset === stat.size) return { events: [], entry: { ...cur, mtimeMs: stat.mtimeMs } };

    const fd = fs.openSync(unit, "r");
    let text;
    try {
      const length = stat.size - cur.offset;
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, cur.offset);
      text = buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }

    // 只消费完整行:Codex 可能正写到一半,越过半行就会丢掉它所属的那次调用。
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return { events: [], entry: { ...cur, mtimeMs: stat.mtimeMs } };
    const complete = text.slice(0, lastNewline + 1);
    const completeBytes = Buffer.byteLength(complete, "utf8");

    const events = [];
    let consumed = 0;
    for (const line of complete.split("\n")) {
      if (events.length >= maxEvents) break;
      // The trailing split element has no newline of its own.
      if (consumed >= completeBytes) break;
      consumed += Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // A corrupt complete line does not hide later usage.
      }
      const result = eventsFrom([parsed], cur);
      events.push(...result.events);
      cur = { ...cur, ...result.state };
    }
    return { events, entry: { ...cur, offset: cur.offset + consumed, mtimeMs: stat.mtimeMs } };
  },

  // 走没走 llm-web 网关是**每个会话**的属性(信号是 session_meta.model_provider),
  // 而 skipReason 是全局开关、只拿得到 reporter 自己的配置。所以那个判断在
  // parse.mjs 里按文件做,这里恒为 null —— 不是漏了。
  skipReason: () => null,

  describePending: (count, totalPending) => `${count} session(s), ${totalPending} byte(s)`,

  statusNotes: () => [
    "",
    "  NOTE: codex --ephemeral writes no session file, so usage from those",
    "        runs cannot be reported at all.",
  ],
};
