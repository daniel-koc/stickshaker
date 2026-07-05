import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../src/llm.js";
import { callOllama, toOpenAIMessages } from "../src/ollama.js";

describe("costUsd", () => {
  const usage = (over: Partial<Parameters<typeof costUsd>[1]> = {}) => ({
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...over,
  });

  it("prices input and output per model", () => {
    assert.equal(costUsd("claude-fable-5", usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })), 60);
    assert.equal(costUsd("claude-sonnet-5", usage({ inputTokens: 1_000_000 })), 3);
  });

  it("applies cache multipliers (0.1x read, 1.25x write)", () => {
    assert.ok(Math.abs(costUsd("claude-sonnet-5", usage({ cacheReadTokens: 1_000_000 })) - 0.3) < 1e-9);
    assert.ok(Math.abs(costUsd("claude-sonnet-5", usage({ cacheCreationTokens: 1_000_000 })) - 3.75) < 1e-9);
  });

  it("falls back to opus pricing for unknown models", () => {
    assert.equal(costUsd("some-future-model", usage({ inputTokens: 1_000_000 })), 5);
  });
});

describe("toOpenAIMessages", () => {
  it("emits the system message first and passes string turns through", () => {
    const out = toOpenAIMessages("SYS", [{ role: "user", content: "hi" }]);
    assert.deepEqual(out[0], { role: "system", content: "SYS" });
    assert.deepEqual(out[1], { role: "user", content: "hi" });
  });

  it("converts assistant text+tool_use into content plus tool_calls", () => {
    const messages: Anthropic.MessageParam[] = [{
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "tu_1", name: "click", input: { ref: 3 } },
      ],
    }];
    const out = toOpenAIMessages("s", messages);
    const a = out[1]!;
    assert.equal(a.role, "assistant");
    assert.equal(a.content, "thinking");
    assert.equal(a.tool_calls?.[0]?.function.name, "click");
    assert.deepEqual(JSON.parse(a.tool_calls?.[0]?.function.arguments ?? "{}"), { ref: 3 });
  });

  it("converts tool_result blocks (string or text-array) into role:tool turns", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "plain result" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: "arr result" }] }] },
    ];
    const out = toOpenAIMessages("s", messages);
    assert.deepEqual(out[1], { role: "tool", content: "plain result", tool_call_id: "tu_1" });
    assert.deepEqual(out[2], { role: "tool", content: "arr result", tool_call_id: "tu_2" });
  });

  it("handles elided observations (plain-string history rewrites)", () => {
    const out = toOpenAIMessages("s", [{ role: "user", content: "[Earlier observation elided]" }]);
    assert.equal(out[1]?.content, "[Earlier observation elided]");
  });
});

describe("callOllama (graceful degradation)", () => {
  const base = { model: "m", system: "s", tools: [], messages: [] };

  it("returns null when the server is unreachable", async () => {
    assert.equal(await callOllama({ ...base, baseUrl: "http://127.0.0.1:9" }), null);
  });

  async function withServer(body: string, status = 200): Promise<ReturnType<typeof callOllama>> {
    const server = createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      return await callOllama({ ...base, baseUrl: url });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it("returns null on a non-OK status", async () => {
    assert.equal(await withServer("{}", 500), null);
  });

  it("returns null when there is no tool call in the response", async () => {
    assert.equal(await withServer(JSON.stringify({ choices: [{ message: { content: "just text" } }] })), null);
  });

  it("returns null when tool-call arguments are not valid JSON", async () => {
    const body = JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "click", arguments: "{not json" } }] } }] });
    assert.equal(await withServer(body), null);
  });

  it("parses a well-formed tool call with usage", async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "note", tool_calls: [{ function: { name: "click", arguments: '{"ref":1}' } }] } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
    const call = await withServer(body);
    assert.equal(call?.name, "click");
    assert.deepEqual(call?.input, { ref: 1 });
    assert.equal(call?.text, "note");
    assert.equal(call?.inputTokens, 11);
    assert.equal(call?.outputTokens, 7);
  });
});
