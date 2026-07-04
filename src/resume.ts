import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type AgentResult, type ApproveFn } from "./agent.js";
import { loadPolicy, type Policy } from "./guardrails.js";
import type { RouterMode } from "./router.js";
import type { RunMode } from "./types.js";

interface TraceEvent {
  type: string;
  step?: number;
  tool?: string;
  input?: unknown;
  ok?: boolean;
  detail?: string;
  url?: string;
}

export interface ResumeOptions {
  maxSteps: number;
  keyframeInterval: number;
  headless: boolean;
  traceDir: string;
  approve?: ApproveFn | undefined;
  /** Override the recorded policy file; falls back to the one recorded in the trace. */
  policyPath?: string | undefined;
  onStep?: (line: string) => void;
}

/**
 * Resume an interrupted run from its trace. Rather than replay actions into a
 * possibly-drifted page, we restore the last page URL and hand the model a
 * compact summary of what it already did, then continue live. The trace is the
 * durable checkpoint; the continuation is recorded as its own new run.
 */
export async function resumeRun(runDir: string, opts: ResumeOptions): Promise<AgentResult> {
  const runJsonPath = join(runDir, "run.json");
  const tracePath = join(runDir, "trace.jsonl");
  if (!existsSync(runJsonPath) || !existsSync(tracePath)) {
    throw new Error(`not a run directory (missing run.json / trace.jsonl): ${runDir}`);
  }

  const meta = JSON.parse(readFileSync(runJsonPath, "utf8")) as {
    task: string;
    startUrl?: string;
    model: string;
    mode: RunMode;
    router?: RouterMode;
    localModel?: string;
    ollamaUrl?: string;
    policyPath?: string;
  };
  const events: TraceEvent[] = readFileSync(tracePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEvent);

  const results = new Map<number, { ok: boolean; detail: string }>();
  for (const e of events) {
    if (e.type === "result" && typeof e.step === "number") {
      results.set(e.step, { ok: Boolean(e.ok), detail: String(e.detail) });
    }
  }
  const actions = events.filter((e) => e.type === "action");
  const lastUrl =
    [...events].reverse().find((e) => e.type === "observation" && e.url)?.url ?? meta.startUrl;

  const summary = actions
    .map((a, i) => {
      const r = typeof a.step === "number" ? results.get(a.step) : undefined;
      const outcome = r ? (r.ok ? "ok" : `error: ${r.detail}`) : "outcome unknown";
      return `${i + 1}. ${a.tool} ${JSON.stringify(a.input)} → ${outcome}`;
    })
    .join("\n");

  const priorContext = summary
    ? `You were working on this task in an earlier session and it was interrupted. Actions you already took:\n${summary}\n\nYou are now back on ${lastUrl ?? "the page"}. Continue from the current page state shown below; do not redo work that already succeeded.`
    : undefined;

  // Restore the guardrail policy the original run used (unless overridden), so an
  // interrupted policy-guarded run does not resume unguarded.
  const policyPath = opts.policyPath ?? meta.policyPath;
  const policy: Policy | undefined = policyPath && existsSync(policyPath) ? loadPolicy(policyPath) : undefined;

  return runAgent({
    task: meta.task,
    startUrl: lastUrl,
    model: meta.model,
    mode: meta.mode,
    maxSteps: opts.maxSteps,
    keyframeInterval: opts.keyframeInterval,
    headless: opts.headless,
    priorContext,
    traceDir: opts.traceDir,
    resumedFrom: runDir,
    ...(meta.router ? { router: meta.router } : {}),
    ...(meta.localModel ? { localModel: meta.localModel } : {}),
    ...(meta.ollamaUrl ? { ollamaUrl: meta.ollamaUrl } : {}),
    ...(policy ? { policy } : {}),
    ...(policyPath ? { policyPath } : {}),
    ...(opts.approve ? { approve: opts.approve } : {}),
    ...(opts.onStep ? { onStep: opts.onStep } : {}),
  });
}
