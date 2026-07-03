import Anthropic from "@anthropic-ai/sdk";
import { BrowserSession } from "./browser.js";
import { tools, formatSnapshot } from "./tools.js";
import { costUsd } from "./llm.js";
import type { ActionResult, Usage } from "./types.js";

const SYSTEM = `You are Stickshaker, an agent that operates a real Chromium browser to accomplish a user's task.

Each turn you receive a snapshot of the current page: a numbered list of interactive elements (each with a [ref]) and the visible page text. Make ONE tool call to move toward the goal.

Rules:
- A [ref] is valid only for the CURRENT snapshot. After every action you get a fresh snapshot with new refs.
- Act on an element by passing its ref number to click / type / select_option.
- Read the visible page text to find the information the task asks for.
- When the task is complete, call "done" with the answer or a summary. If it is genuinely impossible, call "fail" with the reason.
- Be decisive and take the most direct path. Do not narrate your steps.`;

export interface AgentOptions {
  task: string;
  startUrl?: string | undefined;
  model: string;
  maxSteps: number;
  headless: boolean;
  onStep?: (line: string) => void;
}

export interface AgentResult {
  status: "done" | "failed" | "max_steps";
  message: string;
  steps: number;
  usage: Usage;
  costUsd: number;
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const client = new Anthropic();
  const browser = await BrowserSession.launch({ headless: opts.headless });
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const log = opts.onStep ?? (() => {});

  const finish = (status: AgentResult["status"], message: string, steps: number): AgentResult => ({
    status,
    message,
    steps,
    usage,
    costUsd: costUsd(opts.model, usage),
  });

  try {
    if (opts.startUrl) {
      log(`navigate → ${opts.startUrl}`);
      const nav = await browser.navigate(opts.startUrl);
      if (!nav.ok) return finish("failed", `Could not open the starting URL: ${nav.detail}`, 0);
    }

    const messages: Anthropic.MessageParam[] = [];
    let snapshot = await browser.snapshot();
    messages.push({
      role: "user",
      content: `Task: ${opts.task}\n\nCurrent page snapshot:\n${formatSnapshot(snapshot)}`,
    });

    for (let step = 1; step <= opts.maxSteps; step++) {
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

      const toolUse = resp.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const textBlock = resp.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );

      if (!toolUse) {
        // Model ended its turn without acting — take any text as the final answer.
        log("stop (no tool call)");
        return finish("done", textBlock?.text?.trim() || "(agent stopped without an answer)", step);
      }

      const input = toolUse.input as Record<string, unknown>;
      log(`step ${step}: ${toolUse.name}${summarizeInput(toolUse.name, input)}`);

      if (toolUse.name === "done") return finish("done", String(input.answer ?? ""), step);
      if (toolUse.name === "fail") return finish("failed", String(input.reason ?? ""), step);

      const result = await execAction(browser, toolUse.name, input);
      snapshot = await browser.snapshot();
      const body = `${result.ok ? "OK" : "ERROR"}: ${result.detail}\n\nCurrent page snapshot:\n${formatSnapshot(snapshot)}`;
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: body, is_error: !result.ok }],
      });
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
