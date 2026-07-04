import type Anthropic from "@anthropic-ai/sdk";
import { callOllama } from "./ollama.js";

export type RouterMode = "cloud" | "local" | "hybrid";

/** A single step's decision, normalized so the agent loop is source-agnostic. */
export interface Decision {
  source: "cloud" | "local";
  text?: string | undefined;
  toolUse?: { id: string; name: string; input: Record<string, unknown> } | undefined;
  /** Exact Anthropic blocks for a cloud decision (preserved verbatim in history). */
  rawContent?: Anthropic.ContentBlock[] | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
  stopReason?: string | undefined;
  /** True when hybrid tried local first and fell back to cloud this step. */
  escalated?: boolean;
  /** Set when the step cannot proceed at all (e.g. escalation needed but no API key). */
  hardFail?: string | undefined;
}

export interface RouterConfig {
  mode: RouterMode;
  client: Anthropic;
  model: string;
  localModel: string;
  ollamaUrl: string;
  system: string;
  maxTokens: number;
  /** Whether an ANTHROPIC_API_KEY is available for cloud steps / escalation. */
  hasKey: boolean;
}

/**
 * Routes each step to a local model (cheap) or Claude (capable). Hybrid is
 * local-first: it uses the local model's action when it's usable and escalates
 * to Claude otherwise — plus the caller escalates after a failed local action
 * (a low-confidence signal). Cost accrues only on cloud steps.
 */
export class Router {
  private counter = 0;
  constructor(private readonly cfg: RouterConfig) {}

  async decide(messages: Anthropic.MessageParam[], opts: { tools: Anthropic.Tool[]; forceCloud: boolean }): Promise<Decision> {
    if (this.cfg.mode === "cloud" || opts.forceCloud) {
      return this.cfg.hasKey ? this.cloud(messages, opts.tools) : this.noKeyFail(opts.forceCloud);
    }

    const local = await this.tryLocal(messages, opts.tools);
    if (local) return local;

    // local produced nothing usable (or Ollama is down) → escalate to Claude,
    // unless there's no key to escalate with (keyless --router local): fail cleanly
    // rather than firing a doomed API call with a placeholder key.
    if (!this.cfg.hasKey) return this.noKeyFail(false);
    return { ...(await this.cloud(messages, opts.tools)), escalated: true };
  }

  private noKeyFail(afterFailedLocal: boolean): Decision {
    const why = afterFailedLocal
      ? "The local model's action failed and there is no ANTHROPIC_API_KEY set to escalate to Claude."
      : "The local model could not produce a usable action and there is no ANTHROPIC_API_KEY set to escalate to Claude.";
    return { source: "local", inputTokens: 0, outputTokens: 0, hardFail: `${why} Set the key, use a more capable local model, or run --router cloud.` };
  }

  private async tryLocal(messages: Anthropic.MessageParam[], tools: Anthropic.Tool[]): Promise<Decision | null> {
    const call = await callOllama({
      baseUrl: this.cfg.ollamaUrl,
      model: this.cfg.localModel,
      system: this.cfg.system,
      tools,
      messages,
    });
    if (!call) return null;
    // Reject an action that names a tool we don't have — that's a low-confidence
    // signal, so escalate rather than execute garbage.
    if (!tools.some((t) => t.name === call.name) && call.name !== "done" && call.name !== "fail") {
      return null;
    }
    return {
      source: "local",
      text: call.text,
      toolUse: { id: `local-${this.counter++}`, name: call.name, input: call.input },
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
    };
  }

  private async cloud(messages: Anthropic.MessageParam[], tools: Anthropic.Tool[]): Promise<Decision> {
    const resp = await this.cfg.client.messages.create({
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      system: this.cfg.system,
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages,
    });
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return {
      source: "cloud",
      rawContent: resp.content,
      text: textBlock?.text,
      toolUse: toolUse ? { id: toolUse.id, name: toolUse.name, input: toolUse.input as Record<string, unknown> } : undefined,
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: resp.usage.cache_creation_input_tokens ?? 0,
      stopReason: resp.stop_reason ?? undefined,
    };
  }
}
