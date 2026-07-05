#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError } from "commander";
import { BrowserSession } from "./browser.js";
import { formatFull } from "./observe.js";
import { runAgent, type AgentResult, type ApproveFn } from "./agent.js";
import { generateReport } from "./view.js";
import { resumeRun } from "./resume.js";
import { loadPolicy } from "./guardrails.js";
import { startStdioServer } from "./mcp.js";
import { runEval, summarize, TASKS } from "./eval.js";
import type { RouterMode } from "./router.js";
import type { RunMode } from "./types.js";

// Load a local .env if present (Node >= 20.6). No dependency needed.
try {
  (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {
  // No .env file — rely on the ambient environment.
}

function requireKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY is not set. Put it in a .env file or your environment.");
    process.exit(1);
  }
}

function parsePositiveInt(value: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("expected a positive integer");
  return n;
}

function parseMode(value: string): RunMode {
  if (value !== "full" && value !== "diff") throw new InvalidArgumentError("mode must be 'full' or 'diff'");
  return value;
}

function parseRouter(value: string): RouterMode {
  if (value !== "cloud" && value !== "local" && value !== "hybrid") {
    throw new InvalidArgumentError("router must be 'cloud', 'local', or 'hybrid'");
  }
  return value;
}

type ApproveMode = "auto" | "prompt" | "deny";
function parseApproveMode(value: string): ApproveMode {
  if (value !== "auto" && value !== "prompt" && value !== "deny") {
    throw new InvalidArgumentError("approve must be 'auto', 'prompt', or 'deny'");
  }
  return value;
}

/** Build the human-in-the-loop gate for policy actions that require approval. */
function makeApprover(mode: ApproveMode): ApproveFn {
  if (mode === "auto") return async () => true;
  if (mode === "deny") return async () => false;
  return async (req) => {
    if (!process.stdin.isTTY) {
      console.error(`  (no TTY — auto-denying ${req.tool}: ${req.reason})`);
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`  approve ${req.tool} ${JSON.stringify(req.input)} — ${req.reason}? [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };
}

/** done → 0, failed → 2, max_steps (or anything unfinished) → 1. */
function exitCodeFor(status: AgentResult["status"]): number {
  return status === "done" ? 0 : status === "failed" ? 2 : 1;
}

function reportSummary(result: AgentResult): void {
  console.error("");
  console.error(`● status: ${result.status}   steps: ${result.steps}`);
  console.error(
    `● tokens: in ${result.usage.inputTokens} / out ${result.usage.outputTokens}   ≈ $${result.costUsd.toFixed(4)}`,
  );
  if (result.routing) {
    const r = result.routing;
    console.error(`● routing: ${r.mode} — ${r.localSteps} local / ${r.cloudSteps} cloud steps (cost above is cloud only)`);
  }
  if (result.runDir) {
    const report = generateReport(result.runDir);
    console.error(`● trace: ${result.runDir}`);
    console.error(`● report: ${report}`);
  }
  console.error("");
}

const program = new Command();
program
  .name("stickshaker")
  .description("A systems-grade browser-agent runtime.")
  .version("0.1.0");

program
  .command("run")
  .description("Run the browser agent on a task.")
  .argument("<task>", "the task, in natural language")
  .option("--url <url>", "starting URL")
  .option("--model <model>", "Claude model id", "claude-opus-4-8")
  .option("--mode <mode>", "observation mode: diff (incremental) or full (baseline)", parseMode, "diff")
  .option("--max-steps <n>", "maximum agent steps", parsePositiveInt, 25)
  .option("--keyframe-interval <n>", "diff mode: force a full snapshot every N steps", parsePositiveInt, 5)
  .option("--router <mode>", "model routing: cloud | local | hybrid", parseRouter, "cloud")
  .option("--local-model <name>", "Ollama model for local/hybrid routing", "llama3.2")
  .option("--ollama-url <url>", "Ollama base URL", "http://localhost:11434")
  .option("--policy <file>", "guardrail policy YAML file")
  .option("--approve <mode>", "how to handle actions needing approval: auto | prompt | deny", parseApproveMode, "prompt")
  .option("--trace-dir <dir>", "directory for run traces", ".stickshaker/traces")
  .option("--no-trace", "disable trace recording")
  .option("--headed", "show the browser window instead of running headless", false)
  .action(async (task: string, opts: {
    url?: string;
    model: string;
    mode: RunMode;
    maxSteps: number;
    keyframeInterval: number;
    router: RouterMode;
    localModel: string;
    ollamaUrl: string;
    policy?: string;
    approve: ApproveMode;
    traceDir: string;
    trace: boolean;
    headed: boolean;
  }) => {
    if (opts.router !== "local") requireKey();
    console.error(`▶ task: ${task}   [mode: ${opts.mode}, router: ${opts.router}, model: ${opts.model}${opts.policy ? ", policy: " + opts.policy : ""}]`);
    const result = await runAgent({
      task,
      startUrl: opts.url,
      model: opts.model,
      mode: opts.mode,
      maxSteps: opts.maxSteps,
      keyframeInterval: opts.keyframeInterval,
      router: opts.router,
      localModel: opts.localModel,
      ollamaUrl: opts.ollamaUrl,
      headless: !opts.headed,
      traceDir: opts.trace ? opts.traceDir : undefined,
      ...(opts.policy ? { policy: loadPolicy(opts.policy), policyPath: opts.policy } : {}),
      approve: makeApprover(opts.approve),
      onStep: (line) => console.error("  " + line),
    });
    reportSummary(result);
    console.log(result.message);
    process.exit(exitCodeFor(result.status));
  });

program
  .command("resume")
  .description("Resume an interrupted run from its trace directory.")
  .argument("<run-dir>", "a run directory produced by a previous run")
  .option("--max-steps <n>", "maximum additional steps", parsePositiveInt, 25)
  .option("--keyframe-interval <n>", "diff mode: force a full snapshot every N steps", parsePositiveInt, 5)
  .option("--trace-dir <dir>", "directory for the resumed run's trace", ".stickshaker/traces")
  .option("--policy <file>", "override the guardrail policy (default: the one recorded in the trace)")
  .option("--approve <mode>", "how to handle actions needing approval: auto | prompt | deny", parseApproveMode, "prompt")
  .option("--headed", "show the browser window", false)
  .action(async (runDir: string, opts: { maxSteps: number; keyframeInterval: number; traceDir: string; policy?: string; approve: ApproveMode; headed: boolean }) => {
    requireKey();
    console.error(`▶ resuming: ${runDir}`);
    const result = await resumeRun(runDir, {
      maxSteps: opts.maxSteps,
      keyframeInterval: opts.keyframeInterval,
      headless: !opts.headed,
      traceDir: opts.traceDir,
      approve: makeApprover(opts.approve),
      ...(opts.policy ? { policyPath: opts.policy } : {}),
      onStep: (line) => console.error("  " + line),
    });
    reportSummary(result);
    console.log(result.message);
    process.exit(exitCodeFor(result.status));
  });

program
  .command("view")
  .description("Generate a self-contained HTML report from a run's trace. No API key needed.")
  .argument("<run-dir>", "a run directory produced by a previous run")
  .action((runDir: string) => {
    const report = generateReport(runDir);
    console.log(report);
  });

program
  .command("mcp")
  .description("Start the Stickshaker MCP server on stdio (for Claude Desktop / Claude Code).")
  .option("--policy <file>", "guardrail policy YAML file applied to all tool actions")
  .option("--trace-dir <dir>", "directory for browse_task traces", ".stickshaker/traces")
  .option("--ollama-url <url>", "Ollama base URL for recall embeddings", "http://localhost:11434")
  .option("--embed-model <name>", "Ollama embedding model for recall", "nomic-embed-text")
  .action(async (opts: { policy?: string; traceDir: string; ollamaUrl: string; embedModel: string }) => {
    await startStdioServer({
      ...(opts.policy ? { policy: loadPolicy(opts.policy), policyPath: opts.policy } : {}),
      traceDir: opts.traceDir,
      ollamaUrl: opts.ollamaUrl,
      embedModel: opts.embedModel,
    });
    // Stays alive on stdin; the transport keeps the event loop running.
  });

program
  .command("bench")
  .description("Run a task in both full-snapshot and diff mode and compare input-token cost.")
  .argument("<task>", "the task, in natural language")
  .requiredOption("--url <url>", "starting URL")
  .option("--model <model>", "Claude model id", "claude-opus-4-8")
  .option("--max-steps <n>", "maximum agent steps", parsePositiveInt, 20)
  .option("--keyframe-interval <n>", "diff mode: force a full snapshot every N steps", parsePositiveInt, 5)
  .action(async (task: string, opts: { url: string; model: string; maxSteps: number; keyframeInterval: number }) => {
    requireKey();
    const results: AgentResult[] = [];
    for (const mode of ["full", "diff"] as const) {
      console.error(`\n▶ [${mode}] ${task}`);
      results.push(
        await runAgent({
          task,
          startUrl: opts.url,
          model: opts.model,
          mode,
          maxSteps: opts.maxSteps,
          keyframeInterval: opts.keyframeInterval,
          headless: true,
          onStep: (line) => console.error("  " + line),
        }),
      );
    }
    const [full, diff] = results as [AgentResult, AgentResult];

    const deltaSteps = (r: AgentResult) => r.telemetry.filter((t) => t.kind === "diff").length;
    const row = (r: AgentResult) =>
      `${r.mode.padEnd(5)} ${String(r.steps).padStart(5)} ${String(deltaSteps(r)).padStart(7)} ${String(r.usage.inputTokens).padStart(11)} ${String(r.usage.outputTokens).padStart(11)} ${("$" + r.costUsd.toFixed(4)).padStart(9)}  ${r.status}`;

    console.log("");
    console.log(`model: ${opts.model}   task: ${task}`);
    console.log("mode   steps  deltas   input-tok   output-tok      cost  status");
    console.log(row(full));
    console.log(row(diff));
    if (full.usage.inputTokens > 0) {
      const reduction = (1 - diff.usage.inputTokens / full.usage.inputTokens) * 100;
      const costReduction = full.costUsd > 0 ? (1 - diff.costUsd / full.costUsd) * 100 : 0;
      console.log("");
      console.log(`diff vs full: ${reduction.toFixed(1)}% fewer input tokens, ${costReduction.toFixed(1)}% lower cost.`);
    }
    if (deltaSteps(diff) === 0) {
      console.log("");
      console.log("⚠ diff mode sent 0 deltas: every step was a keyframe (first step, or a");
      console.log("  navigation each turn), so both modes sent identical observations. Diff");
      console.log("  mode only helps on multi-step tasks that stay on the same page. Also note");
      console.log("  each mode is run once, so short tasks are dominated by model nondeterminism.");
    }
  });

program
  .command("eval")
  .description("Run the self-hosted fixture suite; report success rate, injection block rate, tokens, cost, p95 latency.")
  .option("--router <mode>", "model routing: cloud | local | hybrid", parseRouter, "cloud")
  .option("--mode <mode>", "observation mode: diff | full", parseMode, "diff")
  .option("--model <model>", "Claude model id", "claude-opus-4-8")
  .option("--local-model <name>", "Ollama model for local/hybrid routing", "llama3.2")
  .option("--ollama-url <url>", "Ollama base URL", "http://localhost:11434")
  .option("--only <ids>", "comma-separated task ids to run (default: all)")
  .action(async (opts: { router: RouterMode; mode: RunMode; model: string; localModel: string; ollamaUrl: string; only?: string }) => {
    if (opts.router !== "local") requireKey();
    const only = opts.only ? new Set(opts.only.split(",").map((s) => s.trim())) : null;
    const tasks = only ? TASKS.filter((t) => only.has(t.id)) : TASKS;
    if (tasks.length === 0) {
      console.error("no matching task ids");
      process.exit(1);
    }
    console.error(`▶ eval: ${tasks.length} tasks   [router: ${opts.router}, mode: ${opts.mode}, model: ${opts.model}]`);
    const results = await runEval(
      { router: opts.router, mode: opts.mode, model: opts.model, localModel: opts.localModel, ollamaUrl: opts.ollamaUrl },
      tasks,
      (line) => console.error(line),
    );
    const s = summarize(results);

    console.log("");
    console.log("task            category    result   steps  cloud-tok      cost");
    for (const r of results) {
      const res = r.status === "errored" ? "ERROR" : r.injection ? (r.pass ? "blocked" : "OBEYED") : (r.pass ? "pass" : "FAIL");
      console.log(
        `${r.id.padEnd(15)} ${r.category.padEnd(11)} ${res.padEnd(8)} ${String(r.steps).padStart(4)}  ${String(r.cloudInputTokens).padStart(9)}  ${("$" + r.costUsd.toFixed(4)).padStart(9)}`,
      );
    }
    console.log("");
    console.log(`success rate:      ${s.taskPass}/${s.taskCount} (${(s.successRate * 100).toFixed(0)}%)`);
    console.log(`injection blocked: ${s.injectionBlocked}/${s.injectionCount} (${(s.injectionBlockRate * 100).toFixed(0)}%)`);
    console.log(`avg steps: ${s.avgSteps.toFixed(1)}   cloud input tokens: ${s.totalCloudInput}   total cost: $${s.totalCost.toFixed(4)}   p95 step latency: ${s.p95LatencyMs} ms`);
    console.log(`config: router=${opts.router} mode=${opts.mode} model=${opts.model}${opts.router !== "cloud" ? ` local=${opts.localModel}` : ""}`);
  });

program
  .command("snapshot")
  .description("Launch the browser, snapshot a page, and print the element list. No API key needed.")
  .requiredOption("--url <url>", "URL to snapshot")
  .option("--headed", "show the browser window", false)
  .action(async (opts: { url: string; headed: boolean }) => {
    const browser = await BrowserSession.launch({ headless: !opts.headed });
    try {
      const nav = await browser.navigate(opts.url);
      if (!nav.ok) {
        console.error(nav.detail);
        process.exit(1);
      }
      console.log(formatFull(await browser.snapshot()));
    } finally {
      await browser.close();
    }
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
