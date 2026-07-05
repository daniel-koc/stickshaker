import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateReport } from "../src/view.js";
import { parseTrace } from "../src/recorder.js";

function makeRun(files: { trace?: string; run?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-view-"));
  if (files.trace !== undefined) writeFileSync(join(dir, "trace.jsonl"), files.trace);
  if (files.run !== undefined) writeFileSync(join(dir, "run.json"), files.run);
  return dir;
}

const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";

describe("parseTrace", () => {
  it("parses well-formed lines and skips blanks", () => {
    const raw = line({ type: "a", step: 1 }) + "\n" + line({ type: "b" });
    const evs = parseTrace(raw);
    assert.equal(evs.length, 2);
    assert.equal(evs[0]?.type, "a");
  });

  it("skips a torn final line (killed mid-append) without throwing", () => {
    const raw = line({ type: "run_start" }) + line({ type: "action", step: 1 }) + '{"type":"observation","step":1,"bo';
    const evs = parseTrace(raw);
    assert.equal(evs.length, 2, "the two whole lines survive; the partial one is dropped");
    assert.equal(evs[1]?.type, "action");
  });

  it("returns nothing for an empty body", () => {
    assert.deepEqual(parseTrace(""), []);
    assert.deepEqual(parseTrace("\n\n"), []);
  });
});

describe("generateReport", () => {
  it("throws only when there is no trace at all", () => {
    const dir = makeRun({});
    try {
      assert.throws(() => generateReport(dir), /no trace\.jsonl/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bakes a self-contained HTML report from trace + run.json + screenshots", () => {
    const dir = makeRun({
      run: JSON.stringify({ task: "buy milk", model: "claude-sonnet-5", mode: "diff", status: "done", steps: 1, costUsd: 0.0123, usage: { inputTokens: 100, outputTokens: 20 } }),
      trace:
        line({ type: "screenshot", step: 0, file: "step-00.png" }) +
        line({ type: "observation", step: 0, kind: "full", url: "http://ok/", title: "Home", chars: 12, body: "<b>hi & bye</b>" }) +
        line({ type: "llm", step: 1, inputTokens: 100, outputTokens: 20, latencyMs: 500, assistantText: "clicking" }) +
        line({ type: "action", step: 1, tool: "click", input: { ref: 3 } }) +
        line({ type: "result", step: 1, ok: true, detail: "clicked element 3" }),
    });
    // The screenshot file the "screenshot" event above references, embedded as a data URI.
    writeFileSync(join(dir, "step-00.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const out = generateReport(dir);
      const html = readFileSync(out, "utf8");
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /buy milk/);
      assert.match(html, /\$0\.0123/);
      assert.match(html, /data:image\/png;base64,/);
      // Trace body is HTML-escaped — no raw injection from observation content.
      assert.ok(!html.includes("<b>hi & bye</b>"), "observation body is escaped");
      assert.match(html, /&lt;b&gt;hi &amp; bye&lt;\/b&gt;/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders an interrupted run: torn trace line AND half-written run.json", () => {
    const dir = makeRun({
      run: '{"task":"interrupted","status":"runn', // torn mid-write
      trace:
        line({ type: "observation", step: 0, kind: "full", url: "http://ok/", title: "T", chars: 3, body: "abc" }) +
        line({ type: "action", step: 1, tool: "scroll", input: { direction: "down" } }) +
        '{"type":"observation","step":1,"body":"trunc', // torn final line
    });
    try {
      // Must not throw despite both files being partially written.
      const html = readFileSync(generateReport(dir), "utf8");
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /step 1/); // the whole action line still rendered
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
