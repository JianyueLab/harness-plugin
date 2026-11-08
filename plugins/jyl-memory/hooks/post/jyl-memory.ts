import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderRecall } from "../../src/recall.mjs";
import { defaultInventoryDeps } from "../../src/repos.mjs";

const RUN = fileURLToPath(new URL("../../scripts/run", import.meta.url));
const TEMPLATE = readFileSync(new URL("../../prompts/recall.md", import.meta.url), "utf8");

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

export default function jylMemory(pi: any, { render = renderRecall, inventoryDeps = defaultInventoryDeps } = {}): void {
  if (process.env.JYL_MEMORY_DISTILL) return;

  let recall: string | null = null;
  /** The recall prompt for this process's cwd, rendered once. */
  const recallText = (): string => (recall ??= render(TEMPLATE, process.cwd(), { env: process.env, home: homedir(), inventoryDeps }));

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (ctx?.agent?.kind === "sub") return;
    const base = event?.systemPrompt;
    if (!Array.isArray(base) && typeof base !== "string") return;
    const RECALL = recallText();
    if (Array.isArray(base)) {
      if (base.some((b: unknown) => typeof b === "string" && b.includes(RECALL))) return;
      return { systemPrompt: [...base, RECALL] };
    }
    if (typeof base === "string") {
      if (base.includes(RECALL)) return;
      return { systemPrompt: `${base}\n\n${RECALL}` };
    }
  });

  const distillPrevious = async (event: any, ctx: any) => {
    if (ctx?.agent?.kind !== "sub" && event?.previousSessionFile) distill(event.previousSessionFile, null);
  };
  pi.on("session_switch", distillPrevious);
  pi.on("session_branch", distillPrevious);

  pi.on("session_shutdown", async (_event: unknown, ctx: any) => {
    if (ctx?.agent?.kind === "sub") return;
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (!file) return;
    distill(file, ctx.sessionManager.getSessionId?.() ?? null);
  });
}
