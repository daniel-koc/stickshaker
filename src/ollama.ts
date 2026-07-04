import type Anthropic from "@anthropic-ai/sdk";

/**
 * Minimal client for a local model served by Ollama, via its OpenAI-compatible
 * endpoint. Everything degrades gracefully: if Ollama isn't running or the model
 * doesn't return a usable tool call, we return null and the router escalates to
 * Claude. No dependency beyond global fetch.
 */

export interface LocalToolCall {
  name: string;
  input: Record<string, unknown>;
  text?: string;
  inputTokens: number;
  outputTokens: number;
}

export async function ollamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** Anthropic conversation → OpenAI chat messages (preserving tool_use / tool_result pairing). */
export function toOpenAIMessages(system: string, messages: Anthropic.MessageParam[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      let text = "";
      const toolCalls: OpenAIMessage["tool_calls"] = [];
      for (const b of m.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        }
      }
      const msg: OpenAIMessage = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const c = b.content;
          const content = typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((x) => (x.type === "text" ? x.text : "")).join("")
              : "";
          out.push({ role: "tool", content, tool_call_id: b.tool_use_id });
        } else if (b.type === "text") {
          out.push({ role: "user", content: b.text });
        }
      }
    }
  }
  return out;
}

function toOpenAITools(tools: Anthropic.Tool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

export async function callOllama(opts: {
  baseUrl: string;
  model: string;
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}): Promise<LocalToolCall | null> {
  try {
    const r = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: toOpenAIMessages(opts.system, opts.messages),
        tools: toOpenAITools(opts.tools),
        tool_choice: "auto",
        stream: false,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = j.choices?.[0]?.message;
    const call = message?.tool_calls?.[0];
    if (!call?.function?.name) return null;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      return null;
    }
    return {
      name: call.function.name,
      input,
      ...(message?.content ? { text: message.content } : {}),
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
    };
  } catch {
    return null;
  }
}
