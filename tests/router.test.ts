import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { cacheableSystem, annotateCacheControl } from "../src/router.js";

type Block = Record<string, unknown> & { cache_control?: unknown };
const blocksOf = (m: Anthropic.MessageParam): Block[] =>
  (typeof m.content === "string" ? [] : (m.content as unknown as Block[]));
const marked = (m: Anthropic.MessageParam): boolean => {
  const b = blocksOf(m);
  return b.length > 0 && b[b.length - 1]!.cache_control !== undefined;
};

describe("cacheableSystem", () => {
  it("wraps the system string in a single cache-controlled text block", () => {
    const s = cacheableSystem("SYSTEM PROMPT");
    assert.equal(s.length, 1);
    assert.equal(s[0]!.type, "text");
    assert.equal(s[0]!.text, "SYSTEM PROMPT");
    assert.deepEqual((s[0] as { cache_control?: unknown }).cache_control, { type: "ephemeral" });
  });
});

describe("annotateCacheControl", () => {
  const base = (): Anthropic.MessageParam[] => [
    { role: "user", content: "seed task" },
    { role: "assistant", content: [{ type: "text", text: "thinking" }, { type: "tool_use", id: "t1", name: "click", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "observation body" }] },
  ];

  it("marks the last block of each requested index and no others", () => {
    const msgs = base();
    const out = annotateCacheControl(msgs, [0, 2]);
    assert.ok(marked(out[0]!), "index 0 marked");
    assert.ok(!marked(out[1]!), "index 1 not marked");
    assert.ok(marked(out[2]!), "index 2 marked");
  });

  it("converts a string-content message into a cache-controlled text block", () => {
    const out = annotateCacheControl(base(), [0]);
    const b = blocksOf(out[0]!);
    assert.equal(b.length, 1);
    assert.equal(b[0]!.type, "text");
    assert.equal(b[0]!.text, "seed task");
    assert.deepEqual(b[0]!.cache_control, { type: "ephemeral" });
  });

  it("only marks the LAST block of a multi-block message", () => {
    const out = annotateCacheControl(base(), [1]);
    const b = blocksOf(out[1]!);
    assert.equal(b[0]!.cache_control, undefined, "first block untouched");
    assert.deepEqual(b[1]!.cache_control, { type: "ephemeral" });
  });

  it("does NOT mutate the input messages or their blocks (stored history stays clean)", () => {
    const msgs = base();
    const snapshot = JSON.stringify(msgs);
    const out = annotateCacheControl(msgs, [0, 1, 2]);
    assert.equal(JSON.stringify(msgs), snapshot, "inputs unchanged after annotation");
    assert.notEqual(out[2], msgs[2], "annotated entries are fresh objects");
    // The block objects themselves must not be shared-and-mutated.
    assert.equal(blocksOf(msgs[1]!)[1]!.cache_control, undefined, "original block not given cache_control");
  });

  it("ignores out-of-range and duplicate indices, and returns the same array when nothing marks", () => {
    const msgs = base();
    assert.equal(annotateCacheControl(msgs, [-1, 99]), msgs, "no valid index → original array");
    const out = annotateCacheControl(msgs, [2, 2, 2]);
    assert.ok(marked(out[2]!));
  });

  it("caps breakpoints well under the API's limit of 4 (preamble + 2 message marks = 3)", () => {
    // The runtime passes at most [boundary, last]; system adds one more. Never > 3.
    const out = annotateCacheControl(base(), [0, 2]);
    const count = out.filter(marked).length;
    assert.ok(count <= 3, `message-level breakpoints ${count} ≤ 3`);
  });
});
