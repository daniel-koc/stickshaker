import Anthropic from "@anthropic-ai/sdk";
import { BrowserSession } from "./browser.js";
import { tools } from "./tools.js";
import { formatFull, formatDiff, diffSnapshots } from "./observe.js";
import { costUsd } from "./llm.js";
import type { ActionResult, RunMode, Snapshot, StepTelemetry, Usage } from "./types.js";

const ELIDED = "[Earlier observation elided to save context — act on the most recent snapshot below.]";

const SYSTEM = `You are Stickshaker, an agent that operates a real Chromium browser to accomplish a user's task.

Each turn you receive the page state and make ONE tool call. The state comes in two forms:
- A full snapshot: every visible interactive element (each with a [ref]) plus the visible page text.
- A delta: only the elements that were added, changed, or removed since the previous snapshot. Elements not listed are still on the page and keep their [ref]. "Visible page text: unchanged" means the text is the same as the previous snapshot.

Rules:
- Act on an element by passing its [ref] to click / type / select_option. A [ref] stays valid as long as that element remains on the page.
- Read the visible page text to find the information the task asks for.
- When the task is complete, call "done" with the answer or a summary. If it is genuinely impossible, call "fail" with the reason.
- Be decisive and take the most direct path. Do not narrate your steps.`;

export interface AgentOptions {
  task: string;
  startUrl?: string | undefined;
  model: string;
  maxSteps: number;
  headless: boolean;
  /** "diff" (default): keyframes + deltas + history elision. "full": the naive baseline. */
  mode: RunMode;
  /** In diff mode, force a full snapshot every N steps to bound drift. */
  keyframeInterval: number;
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
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const client = new Anthropic();
  const browser = await BrowserSession.launch({ headless: opts.headless });
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const telemetry: StepTelemetry[] = [];
  const log = opts.onStep ?? (() => {});
  const messages: Anthropic.MessageParam[] = [];

  // Observation registry: each page observation records the keyframe group it
  // belongs to and how to elide its body in place. In diff mode we keep only the
  // most recent keyframe group live; older groups are collapsed to a placeholder,
  // which keeps per-call context flat instead of O(steps^2).
  const observations: { group: number; elide: () => void }[] = [];
  let keyframeGroup = 0;

  const finish = (status: AgentResult["status"], message: string, steps: number): AgentResult => ({
    status,
    message,
    steps,
    mode: opts.mode,
    usage,
    costUsd: costUsd(opts.model, usage),
    telemetry,
  });

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
      if (!nav.ok) return finish("failed", `Could not open the starting URL: ${nav.detail}`, 0);
    }

    // The task lives in its own message and is never elided.
    messages.push({ role: "user", content: `Task: ${opts.task}` });

    let cur = await browser.snapshot();
    let prev: Snapshot = cur;
    let prevUrl = cur.url;
    let stepsSinceKeyframe = 0;

    // The first observation is always a full keyframe.
    keyframeGroup++;
    addObservation(`Current page (full snapshot):\n${formatFull(cur)}`, null, false);

    for (let step = 1; step <= opts.maxSteps; step++) {
      if (opts.mode === "diff") {
        for (const o of observations) if (o.group < keyframeGroup) o.elide();
      }

      const resp = await client.messages.create({
        model: opts.model,
        max_tokens: 4096,
        system: SYSTEM,
        tools,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages,
      });

      usage.inputTokens += resp.usage.input_tokens;
      usage.outputTokens += resp.usage.output_tokens;
      usage.cacheReadTokens += resp.usage.cache_read_input_tokens ?? 0;
      usage.cacheCreationTokens += resp.usage.cache_creation_input_tokens ?? 0;

      messages.push({ role: "assistant", content: resp.content });

      const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");

      if (!toolUse) {
        log("stop (no tool call)");
        return finish("done", textBlock?.text?.trim() || "(agent stopped without an answer)", step);
      }

      const input = toolUse.input as Record<string, unknown>;

      if (toolUse.name === "done") {
        log(`step ${step}: done`);
        return finish("done", String(input.answer ?? ""), step);
      }
      if (toolUse.name === "fail") {
        log(`step ${step}: fail`);
        return finish("failed", String(input.reason ?? ""), step);
      }

      const result = await execAction(browser, toolUse.name, input);
      cur = await browser.snapshot();

      const navigated = cur.url !== prevUrl;
      stepsSinceKeyframe++;
      const isKeyframe = opts.mode === "full" || navigated || stepsSinceKeyframe >= opts.keyframeInterval;

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

      const body = `${result.ok ? "OK" : "ERROR"}: ${result.detail}\n\n${observation}`;
      addObservation(body, toolUse.id, !result.ok);

      log(`step ${step}: ${toolUse.name}${summarizeInput(toolUse.name, input)}   [${kind}, ${body.length} chars]`);
      telemetry.push({
        step,
        kind,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        observationChars: body.length,
      });

      prev = cur;
      prevUrl = cur.url;
    }

    return finish("max_steps", `Reached the ${opts.maxSteps}-step limit without finishing.`, opts.maxSteps);
  } finally {
    await browser.close();
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
