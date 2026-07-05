import type Anthropic from "@anthropic-ai/sdk";
import { callOllama } from "./ollama.js";

export type RouterMode = "cloud" | "local" | "hybrid";

const EPHEMERAL = { type: "ephemeral" as const };

/** Wrap the (static) system prompt so a cache breakpoint sits at its end — this
 *  caches the whole request preamble (tools precede system in the cache prefix, so
 *  one breakpoint here covers tools + system). */
export function cacheableSystem(system: string): Anthropic.TextBlockParam[] {
  return [{ type: "text", text: system, cache_control: EPHEMERAL }];
}

/**
 * Return a copy of `messages` with a cache_control breakpoint on the last content
 * block of each given index. Crucially it does NOT mutate the input or its blocks —
 * annotated messages are fresh objects — so the caller's stored history stays clean;
 * otherwise breakpoints would accumulate turn over turn and blow the 4-breakpoint
 * limit. Out-of-range / duplicate indices are ignored.
 */
export function annotateCacheControl(messages: Anthropic.MessageParam[], indices: number[]): Anthropic.MessageParam[] {
  const marks = new Set<number>();
  for (const i of indices) if (Number.isInteger(i) && i >= 0 && i < messages.length) marks.add(i);
  if (marks.size === 0) return messages;
  return messages.map((m, i) => (marks.has(i) ? markLastBlock(m) : m));
}

function markLastBlock(m: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof m.content === "string") {
    return { role: m.role, content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }] };
  }
  if (m.content.length === 0) return m;
  const last = m.content.length - 1;
  const content = m.content.map((b, i) => (i === last ? ({ ...b, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam) : b));
  return { role: m.role, content };
}

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
  /** Place prompt-cache breakpoints on cloud requests (default runtime behavior). */
  cache: boolean;
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

  async decide(
    messages: Anthropic.MessageParam[],
    opts: { tools: Anthropic.Tool[]; forceCloud: boolean; cacheBoundaryIndex?: number },
  ): Promise<Decision> {
    if (this.cfg.mode === "cloud" || opts.forceCloud) {
      return this.cfg.hasKey ? this.cloud(messages, opts.tools, opts.cacheBoundaryIndex) : this.noKeyFail(opts.forceCloud);
    }

    const local = await this.tryLocal(messages, opts.tools);
    if (local) return local;

    // local produced nothing usable (or Ollama is down) → escalate to Claude,
    // unless there's no key to escalate with (keyless --router local): fail cleanly
    // rather than firing a doomed API call with a placeholder key.
    if (!this.cfg.hasKey) return this.noKeyFail(false);
    return { ...(await this.cloud(messages, opts.tools, opts.cacheBoundaryIndex)), escalated: true };
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

  private async cloud(messages: Anthropic.MessageParam[], tools: Anthropic.Tool[], cacheBoundaryIndex?: number): Promise<Decision> {
    // Prompt caching: one breakpoint caches the preamble (tools + system); one at the
    // stable elided-history boundary keeps that prefix cached across keyframe elisions;
    // one on the last message caches the whole conversation for the common append-only
    // step. Reads are automatic (longest matching prefix), so this degrades gracefully.
    const useCache = this.cfg.cache;
    const resp = await this.cfg.client.messages.create({
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      system: useCache ? cacheableSystem(this.cfg.system) : this.cfg.system,
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: useCache ? annotateCacheControl(messages, [cacheBoundaryIndex ?? -1, messages.length - 1]) : messages,
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
