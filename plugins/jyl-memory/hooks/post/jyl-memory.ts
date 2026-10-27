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
