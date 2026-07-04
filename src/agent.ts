import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { BrowserSession } from "./browser.js";
import { tools } from "./tools.js";
import { formatFull, formatDiff, diffSnapshots } from "./observe.js";
import { costUsd } from "./llm.js";
import { Recorder, runDirName, type RunMeta } from "./recorder.js";
import { initTelemetry, trace, context, SpanStatusCode, type Span } from "./telemetry.js";
import type { ActionResult, RunMode, Snapshot, StepTelemetry, Usage } from "./types.js";

const ELIDED = "[Earlier observation elided to save context — act on the most recent snapshot below.]";
const MAX_CONSECUTIVE_FAILURES = 3;

const SYSTEM = `You are Stickshaker, an agent that operates a real Chromium browser to accomplish a user's task.

Each turn you receive the page state and make ONE tool call. The state comes in two forms:
- A full snapshot: every visible interactive element (each with a [ref]) plus the visible page text.
- A delta: only the elements that were added, changed, or removed since the previous snapshot. Elements not listed are still on the page and keep their [ref]. "Visible page text: unchanged" means the text is the same as the previous snapshot.

Rules:
- Act on an element by passing its [ref] to click / type / select_option. A [ref] stays valid as long as that element remains on the page.
- Read the visible page text to find the information the task asks for.
- If an action fails, you will get a fresh full snapshot; try a different element or approach rather than repeating the same call.
- When the task is complete, call "done" with the answer or a summary. If it is genuinely impossible, call "fail" with the reason.
- Be decisive and take the most direct path. Do not narrate your steps.`;

export interface AgentOptions {
  task: string;
  startUrl?: string | undefined;
  model: string;
  maxSteps: number;
  headless: boolean;
  mode: RunMode;
  keyframeInterval: number;
  /** If set, write a flight-recorder trace under this directory. */
  traceDir?: string | undefined;
  /** Injected context when resuming a prior run. */
  priorContext?: string | undefined;
  /** Source run dir when this run is a resume. */
  resumedFrom?: string | undefined;
  onStep?: (line: string) => void;
}

export interface AgentResult {
  status: "done" | "failed" | "max_steps";
  message: string;
  steps: number;
  mode: RunMode;
  usage: Usage;
  costUsd: number;
  telemetry: StepTelemetry[];
  runDir?: string;
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const client = new Anthropic();
  const browser = await BrowserSession.launch({ headless: opts.headless });
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const telemetry: StepTelemetry[] = [];
  const log = opts.onStep ?? (() => {});
  const messages: Anthropic.MessageParam[] = [];

  // Flight recorder + OpenTelemetry (only when tracing is requested).
  const meta: RunMeta = {
    task: opts.task,
    startUrl: opts.startUrl,
    model: opts.model,
    mode: opts.mode,
    startedAt: new Date().toISOString(),
    ...(opts.resumedFrom ? { resumedFrom: opts.resumedFrom } : {}),
  };
  const runDir = opts.traceDir ? join(opts.traceDir, runDirName(opts.task)) : undefined;
  const recorder = runDir ? new Recorder(runDir, meta) : undefined;
  const tel = runDir ? initTelemetry(join(runDir, "otel-spans.jsonl")) : undefined;
  const rootSpan = tel?.tracer.startSpan("stickshaker.run", {
    attributes: { "stickshaker.model": opts.model, "stickshaker.mode": opts.mode },
  });
  const rootCtx = rootSpan ? trace.setSpan(context.active(), rootSpan) : undefined;

  const observations: { group: number; elide: () => void }[] = [];
  let keyframeGroup = 0;
  let result: AgentResult | undefined;

  const ret = (status: AgentResult["status"], message: string, steps: number): AgentResult => {
    result = {
      status,
      message,
      steps,
      mode: opts.mode,
      usage,
      costUsd: costUsd(opts.model, usage),
      telemetry,
      ...(runDir ? { runDir } : {}),
    };
    return result;
  };

  const addObservation = (body: string, toolUseId: string | null, isError: boolean): void => {
    if (toolUseId === null) {
      const msg: Anthropic.MessageParam = { role: "user", content: body };
      messages.push(msg);
      observations.push({ group: keyframeGroup, elide: () => { msg.content = ELIDED; } });
    } else {
      const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: toolUseId, content: body, is_error: isError };
      messages.push({ role: "user", content: [block] });
      observations.push({ group: keyframeGroup, elide: () => { block.content = ELIDED; } });
    }
  };

  try {
    if (opts.startUrl) {
      log(`navigate → ${opts.startUrl}`);
      const nav = await browser.navigate(opts.startUrl);
      if (!nav.ok) return ret("failed", `Could not open the starting URL: ${nav.detail}`, 0);
    }

    const seed = opts.priorContext
      ? `Task: ${opts.task}\n\n${opts.priorContext}`
      : `Task: ${opts.task}`;
    messages.push({ role: "user", content: seed });

    let cur = await browser.snapshot();
    let prev: Snapshot = cur;
    let prevUrl = cur.url;
    let stepsSinceKeyframe = 0;
    let consecutiveFailures = 0;

    keyframeGroup++;
    const firstBody = `Current page (full snapshot):\n${formatFull(cur)}`;
    addObservation(firstBody, null, false);
    recorder?.event("observation", { step: 0, kind: "full", url: cur.url, title: cur.title, chars: firstBody.length, body: firstBody });
    await recorder?.screenshot(browser.page, 0);

    for (let step = 1; step <= opts.maxSteps; step++) {
      if (opts.mode === "diff") {
        for (const o of observations) if (o.group < keyframeGroup) o.elide();
      }

      const stepSpan: Span | undefined = tel?.tracer.startSpan("stickshaker.step", { attributes: { "stickshaker.step": step } }, rootCtx);
      const t0 = Date.now();
      const resp = await client.messages.create({
        model: opts.model,
        max_tokens: 4096,
        system: SYSTEM,
        tools,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages,
      });
      const latencyMs = Date.now() - t0;

      usage.inputTokens += resp.usage.input_tokens;
      usage.outputTokens += resp.usage.output_tokens;
      usage.cacheReadTokens += resp.usage.cache_read_input_tokens ?? 0;
      usage.cacheCreationTokens += resp.usage.cache_creation_input_tokens ?? 0;

      messages.push({ role: "assistant", content: resp.content });

      const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");

      recorder?.event("llm", {
        step,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        latencyMs,
        stopReason: resp.stop_reason,
        ...(textBlock?.text ? { assistantText: textBlock.text } : {}),
      });
      stepSpan?.setAttributes({
        "llm.input_tokens": resp.usage.input_tokens,
        "llm.output_tokens": resp.usage.output_tokens,
        "stickshaker.latency_ms": latencyMs,
        "stickshaker.tool": toolUse?.name ?? "none",
      });

      if (!toolUse) {
        stepSpan?.end();
        log("stop (no tool call)");
        return ret("done", textBlock?.text?.trim() || "(agent stopped without an answer)", step);
      }

      const input = toolUse.input as Record<string, unknown>;
      recorder?.event("action", { step, tool: toolUse.name, input });

      if (toolUse.name === "done") {
        stepSpan?.end();
        log(`step ${step}: done`);
        return ret("done", String(input.answer ?? ""), step);
      }
      if (toolUse.name === "fail") {
        stepSpan?.end();
        log(`step ${step}: fail`);
        return ret("failed", String(input.reason ?? ""), step);
      }

      const result0 = await execAction(browser, toolUse.name, input);
      recorder?.event("result", { step, ok: result0.ok, detail: result0.detail });
      stepSpan?.setAttribute("stickshaker.action_ok", result0.ok);

      // Failure recovery: force a full re-snapshot so the model re-grounds, and
      // abort after too many consecutive failures rather than looping forever.
      if (!result0.ok) {
        consecutiveFailures++;
        recorder?.event("recovery", { step, note: `action failed (${consecutiveFailures} in a row) — forcing a full re-snapshot to replan` });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stepSpan?.setStatus({ code: SpanStatusCode.ERROR });
          stepSpan?.end();
          log(`step ${step}: aborting after ${consecutiveFailures} consecutive failures`);
          return ret("failed", `Aborted after ${consecutiveFailures} consecutive failed actions. Last error: ${result0.detail}`, step);
        }
      } else {
        consecutiveFailures = 0;
      }

      cur = await browser.snapshot();
      const navigated = cur.url !== prevUrl;
      stepsSinceKeyframe++;
      const isKeyframe = opts.mode === "full" || navigated || !result0.ok || stepsSinceKeyframe >= opts.keyframeInterval;

      let observation: string;
      let kind: "full" | "diff";
      if (isKeyframe) {
        if (opts.mode === "diff") keyframeGroup++;
        observation = `Current page (full snapshot):\n${formatFull(cur)}`;
        kind = "full";
        stepsSinceKeyframe = 0;
      } else {
        observation = `Result of the last action, then what changed:\n${formatDiff(diffSnapshots(prev, cur))}`;
        kind = "diff";
      }

      const hint = consecutiveFailures > 1 ? `\n(That action has failed ${consecutiveFailures} times — try a different element or approach.)` : "";
      const body = `${result0.ok ? "OK" : "ERROR"}: ${result0.detail}${hint}\n\n${observation}`;
      addObservation(body, toolUse.id, !result0.ok);
      recorder?.event("observation", { step, kind, url: cur.url, title: cur.title, chars: body.length, body });
      await recorder?.screenshot(browser.page, step);

      stepSpan?.setAttributes({ "stickshaker.observation_kind": kind, "stickshaker.observation_chars": body.length });
      stepSpan?.end();

      log(`step ${step}: ${toolUse.name}${summarizeInput(toolUse.name, input)}   [${kind}, ${body.length} chars]`);
      telemetry.push({ step, kind, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens, observationChars: body.length });

      prev = cur;
      prevUrl = cur.url;
    }

    return ret("max_steps", `Reached the ${opts.maxSteps}-step limit without finishing.`, opts.maxSteps);
  } finally {
    await browser.close();
    if (recorder && result) {
      recorder.finish({
        status: result.status,
        message: result.message,
        steps: result.steps,
        usage: result.usage,
        costUsd: result.costUsd,
        finishedAt: new Date().toISOString(),
      });
    }
    if (rootSpan) {
      rootSpan.setAttributes({
        "stickshaker.status": result?.status ?? "error",
        "stickshaker.steps": result?.steps ?? 0,
        "llm.input_tokens": usage.inputTokens,
        "llm.output_tokens": usage.outputTokens,
        "stickshaker.cost_usd": result?.costUsd ?? 0,
      });
      rootSpan.setStatus({ code: result?.status === "failed" ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      rootSpan.end();
    }
    if (tel) await tel.shutdown();
  }
}

async function execAction(
  browser: BrowserSession,
  name: string,
  input: Record<string, unknown>,
): Promise<ActionResult> {
  switch (name) {
    case "navigate":
      return browser.navigate(String(input.url ?? ""));
    case "click":
      return browser.click(Number(input.ref));
    case "type":
      return browser.type(Number(input.ref), String(input.text ?? ""), Boolean(input.submit));
    case "select_option":
      return browser.selectOption(Number(input.ref), String(input.value ?? ""));
    case "scroll":
      return browser.scroll(input.direction === "up" ? "up" : "down");
    case "go_back":
      return browser.goBack();
    default:
      return { ok: false, detail: `unknown tool: ${name}` };
  }
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "navigate":
      return ` ${String(input.url)}`;
    case "click":
      return ` [${String(input.ref)}]`;
    case "type":
      return ` [${String(input.ref)}] ${JSON.stringify(String(input.text).slice(0, 40))}${input.submit ? " ⏎" : ""}`;
    case "select_option":
      return ` [${String(input.ref)}] = ${JSON.stringify(String(input.value))}`;
    case "scroll":
      return ` ${String(input.direction)}`;
    default:
      return "";
  }
}
