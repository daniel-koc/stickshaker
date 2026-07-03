#!/usr/bin/env node
import { Command } from "commander";
import { BrowserSession } from "./browser.js";
import { formatSnapshot } from "./tools.js";
import { runAgent } from "./agent.js";

// Load a local .env if present (Node >= 20.6). No dependency needed.
try {
  (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {
  // No .env file — rely on the ambient environment.
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
  .option("--max-steps <n>", "maximum agent steps", (v) => parseInt(v, 10), 25)
  .option("--headed", "show the browser window instead of running headless", false)
  .action(async (task: string, opts: { url?: string; model: string; maxSteps: number; headed: boolean }) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("ERROR: ANTHROPIC_API_KEY is not set. Put it in a .env file or your environment.");
      process.exit(1);
    }
    console.error(`▶ task: ${task}`);
    const result = await runAgent({
      task,
      startUrl: opts.url,
      model: opts.model,
      maxSteps: opts.maxSteps,
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
      console.log(formatSnapshot(await browser.snapshot()));
    } finally {
      await browser.close();
    }
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
