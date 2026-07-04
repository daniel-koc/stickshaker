#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { BrowserSession } from "./browser.js";
import { formatFull } from "./observe.js";
import { runAgent, type AgentResult } from "./agent.js";
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
  .option("--headed", "show the browser window instead of running headless", false)
  .action(async (task: string, opts: {
    url?: string;
    model: string;
    mode: RunMode;
    maxSteps: number;
    keyframeInterval: number;
    headed: boolean;
  }) => {
    requireKey();
    console.error(`▶ task: ${task}   [mode: ${opts.mode}, model: ${opts.model}]`);
    const result = await runAgent({
      task,
      startUrl: opts.url,
      model: opts.model,
      mode: opts.mode,
      maxSteps: opts.maxSteps,
      keyframeInterval: opts.keyframeInterval,
      headless: !opts.headed,
      onStep: (line) => console.error("  " + line),
    });

    console.error("");
    console.error(`● status: ${result.status}   steps: ${result.steps}`);
    console.error(
      `● tokens: in ${result.usage.inputTokens} / out ${result.usage.outputTokens}   ≈ $${result.costUsd.toFixed(4)}`,
    );
    console.error("");
    // The answer goes to stdout so it is pipeable; progress/telemetry go to stderr.
    console.log(result.message);
    process.exit(result.status === "failed" ? 2 : 0);
  });

program
  .command("bench")
  .description("Run a task in both full-snapshot and diff mode and compare input-token cost.")
  .argument("<task>", "the task, in natural language")
  .requiredOption("--url <url>", "starting URL")
  .option("--model <model>", "Claude model id", "claude-opus-4-8")
  .option("--max-steps <n>", "maximum agent steps", parsePositiveInt, 20)
  .option("--keyframe-interval <n>", "diff mode: force a full snapshot every N steps", parsePositiveInt, 5)
  .action(async (task: string, opts: {
    url: string;
    model: string;
    maxSteps: number;
    keyframeInterval: number;
  }) => {
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
    // Diff mode only diverges from full once it sends a delta. If it never did,
    // the two runs sent identical observations and the comparison is meaningless.
    if (deltaSteps(diff) === 0) {
      console.log("");
      console.log("⚠ diff mode sent 0 deltas: every step was a keyframe (first step, or a");
      console.log("  navigation each turn), so both modes sent identical observations. Diff");
      console.log("  mode only helps on multi-step tasks that stay on the same page. Also note");
      console.log("  each mode is run once, so short tasks are dominated by model nondeterminism.");
    }
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
