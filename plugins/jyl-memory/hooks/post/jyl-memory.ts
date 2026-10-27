import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUN = fileURLToPath(new URL("../../scripts/run", import.meta.url));
const RECALL = readFileSync(new URL("../../prompts/recall.md", import.meta.url), "utf8");

function distill(file: string, sessionId: string | null): void {
  const payload = JSON.stringify({ transcript_path: file, session_id: sessionId, cwd: process.cwd() });
  const child = spawn(RUN, ["end", "--host", "omp"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, JYL_MEMORY_PAYLOAD: payload },
  });
  child.on("error", () => {});
  child.unref();
}

export default function jylMemory(pi: any): void {
  if (process.env.JYL_MEMORY_DISTILL) return;

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (ctx?.agent?.kind === "sub") return;
    const base = event?.systemPrompt;
    if (Array.isArray(base)) {
      if (base.some((b: unknown) => typeof b === "string" && b.includes(RECALL))) return;
      return { systemPrompt: [...base, RECALL] };
    }
    if (typeof base === "string") {
      if (base.includes(RECALL)) return;
      return { systemPrompt: `${base}\n\n${RECALL}` };
    }
  });

  pi.on("session_switch", async (event: any, ctx: any) => {
    if (ctx?.agent?.kind !== "sub" && event?.previousSessionFile) distill(event.previousSessionFile, null);
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: any) => {
    if (ctx?.agent?.kind === "sub") return;
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (!file) return;
    distill(file, ctx.sessionManager.getSessionId?.() ?? null);
  });
}
