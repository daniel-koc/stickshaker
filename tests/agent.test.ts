import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent } from "../src/agent.js";
import { resumeRun } from "../src/resume.js";
import { startSite, startFakeOllama, localAgentOpts, type SiteHandle, type FakeOllamaHandle } from "./helpers.js";

/**
 * The real agent loop, driven by a scripted fake-Ollama backend (--router local):
 * every policy, recovery, and recording behavior is testable with no API key and
 * no LLM. Observation bodies are asserted through the flight-recorder trace.
 */

let site: SiteHandle;
let ollama: FakeOllamaHandle;
let tmp: string;
let savedKey: string | undefined;

before(async () => {
  // Hermeticity: a failed local action escalates the next decision to the cloud,
  // so a key inherited from the shell would send these tests to the real API.
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  site = await startSite((path, url) => {
    switch (path) {
      case "/home":
        return `<html><body><h1>Home</h1>
          <a href="${site.away}/denied?hops=${url.searchParams.get("hops") ?? "0"}">go away</a>
          <button id="pop" onclick="window.open('${site.away}/denied')">popup</button>
          </body></html>`;
      case "/denied": {
        const hops = Number(url.searchParams.get("hops") ?? "0");
        const pushes = Array.from({ length: hops }, (_, i) => `history.pushState({}, "", "/p${i}");`).join("");
        return `<html><body><h1>SECRET-DENIED zone</h1><script>${pushes}</script></body></html>`;
      }
      case "/away":
        return `<html><body><h1>Away page</h1></body></html>`;
      case "/tools":
        return `<html><body><h1>Order desk</h1><script>
          if (window.agent) window.agent.provideContext({ tools: [{
            name: "order",
            description: "Places an order.",
            inputSchema: { type: "object", properties: { qty: { type: "integer" } } },
            execute: function(a){ return { ok: true, message: "ordered " + a.qty }; }
          }]});
        </script></body></html>`;
      case "/toolframe":
        return `<html><body><h1>Manifest desk</h1><iframe src="/toolframe-inner"></iframe></body></html>`;
      case "/toolframe-inner":
        return `<html><body><p>panel</p><script>
          if (window.agent) window.agent.provideContext({ tools: [{
            name: "get_manifest", description: "Returns the manifest.",
            inputSchema: { type: "object", properties: {} },
            execute: function(){ return { ok: true, message: "Manifest code: TEST-77" }; }
          }]});
        </script></body></html>`;
      default:
        return `<html><body><h1>page ${path}</h1></body></html>`;
    }
  });
  ollama = await startFakeOllama();
  tmp = mkdtempSync(join(tmpdir(), "sk-agent-"));
});

after(async () => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  await site.close();
  await ollama.close();
  rmSync(tmp, { recursive: true, force: true });
});

const opts = () => localAgentOpts(ollama.url);

function observations(runDir: string): string[] {
  return readFileSync(join(runDir, "trace.jsonl"), "utf8")
    .split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; body?: string })
    .filter((e) => e.type === "observation" && typeof e.body === "string")
    .map((e) => e.body!);
}

describe("basic flows", () => {
  it("done returns the answer", async () => {
    ollama.script = [{ name: "done", args: { answer: "the code is 42" } }];
    const r = await runAgent({ ...opts(), task: "t", startUrl: `${site.ok}/home` });
    assert.equal(r.status, "done");
    assert.equal(r.message, "the code is 42");
    assert.equal(r.steps, 1);
    assert.equal(r.routing?.localSteps, 1);
  });

  it("fail returns the reason", async () => {
    ollama.script = [{ name: "fail", args: { reason: "cannot do it" } }];
    const r = await runAgent({ ...opts(), task: "t", startUrl: `${site.ok}/home` });
    assert.equal(r.status, "failed");
    assert.equal(r.message, "cannot do it");
  });

  it("fails fast when the local backend is unreachable in --router local", async () => {
    const r = await runAgent({ ...opts(), ollamaUrl: "http://127.0.0.1:9", task: "t", startUrl: `${site.ok}/home` });
    assert.equal(r.status, "failed");
    assert.match(r.message, /Ollama is not reachable/);
  });

  it("hard-fails cleanly when local produces garbage and no API key exists to escalate", async () => {
    ollama.script = [{ name: "not_a_real_tool", args: {} }];
    const r = await runAgent({ ...opts(), task: "t", startUrl: `${site.ok}/home` });
    assert.equal(r.status, "failed");
    assert.match(r.message, /ANTHROPIC_API_KEY/);
  });

  it("stops at the policy step budget with max_steps", async () => {
    ollama.script = [
      { name: "scroll", args: { direction: "down" } },
      { name: "done", args: { answer: "never reached" } },
    ];
    const r = await runAgent({ ...opts(), task: "t", startUrl: `${site.ok}/home`, policy: { budgets: { maxSteps: 1 } } });
    assert.equal(r.status, "max_steps");
    assert.match(r.message, /1-step limit/);
  });

  it("escalates the step after a failed local action (keyless: surfaces as a clean hard-fail)", async () => {
    // The recovery contract: a failed LOCAL action forces the next decision to
    // the cloud. Without a key that escalation hard-fails with a message naming
    // both the failure and the missing key — proving escalate-on-failure fired
    // (the scripted `done` on the fake backend is never consulted).
    ollama.script = [
      { name: "navigate", args: { url: "http://127.0.0.1:9/" } }, // connection refused -> action fails fast
      { name: "done", args: { answer: "never reached" } },
    ];
    const r = await runAgent({ ...opts(), task: "t", startUrl: `${site.ok}/home` });
    assert.equal(r.status, "failed");
    assert.match(r.message, /local model's action failed/);
    assert.match(r.message, /ANTHROPIC_API_KEY/);
  });
});

describe("policy enforcement in the loop", () => {
  it("denies pre-action and aborts after three consecutive blocks", async () => {
    ollama.script = Array.from({ length: 3 }, () => ({ name: "navigate", args: { url: `${site.away}/away` } }));
    const r = await runAgent({
      ...opts(),
      task: "t",
      startUrl: `${site.ok}/home`,
      policy: { domains: { deny: ["localhost"] } },
    });
    assert.equal(r.status, "failed");
    assert.match(r.message, /consecutive policy-blocked/);
  });

  it("pulls back a click that landed on a denied host and never shows its content", async () => {
    ollama.script = [
      { name: "click", args: { ref: 0 } },
      { name: "done", args: { answer: "stopped" } },
    ];
    const r = await runAgent({
      ...opts(),
      task: "t",
      startUrl: `${site.ok}/home?hops=1`,
      policy: { domains: { allow: ["127.0.0.1"] } },
      traceDir: tmp,
    });
    assert.equal(r.status, "done");
    const blocked = observations(r.runDir!).find((b) => b.includes("BLOCKED BY POLICY (after navigation)"));
    assert.ok(blocked, "post-navigation block observed");
    assert.match(blocked, /You were returned to the previous page/);
    assert.match(blocked, new RegExp(`URL: ${site.ok}/home`));
    assert.ok(!blocked.includes("SECRET-DENIED"));
  });

  it("withholds content when a pushState chain defeats the pull-back", async () => {
    ollama.script = [
      { name: "click", args: { ref: 0 } },
      { name: "done", args: { answer: "stopped" } },
    ];
    const r = await runAgent({
      ...opts(),
      task: "t",
      startUrl: `${site.ok}/home?hops=4`,
      policy: { domains: { allow: ["127.0.0.1"] } },
      traceDir: tmp,
    });
    const blocked = observations(r.runDir!).find((b) => b.includes("BLOCKED BY POLICY (after navigation)"));
    assert.ok(blocked);
    assert.match(blocked, /withheld by policy/);
    assert.ok(!blocked.includes("SECRET-DENIED"));
  });

  it("reports an action-opened popup to a denied destination (main tab unaffected)", async () => {
    ollama.script = [
      { name: "click", args: { ref: 1 } }, // the popup button
      { name: "done", args: { answer: "stopped" } },
    ];
    const r = await runAgent({
      ...opts(),
      task: "t",
      startUrl: `${site.ok}/home`,
      policy: { domains: { allow: ["127.0.0.1"] } },
      traceDir: tmp,
    });
    const blocked = observations(r.runDir!).find((b) => b.includes("BLOCKED BY POLICY (after navigation)"));
    assert.ok(blocked, "popup violation observed");
    assert.match(blocked, /new tab/);
    assert.match(blocked, new RegExp(`URL: ${site.ok}/home`), "main tab still on the allowed page");
  });

  it("prompts exactly once for an approved cross-origin navigate (no post-landing re-prompt)", async () => {
    ollama.script = [
      { name: "navigate", args: { url: `${site.away}/away` } },
      { name: "done", args: { answer: "ok" } },
    ];
    let prompts = 0;
    const r = await runAgent({
      ...opts(),
      task: "t",
      startUrl: `${site.ok}/home`,
      policy: { sameOriginOnly: true },
      approve: async () => {
        prompts++;
        return true;
      },
    });
    assert.equal(r.status, "done");
    assert.equal(prompts, 1);
  });

  it("treats a declined approval as a block and the action is not performed", async () => {
    ollama.script = [
      { name: "navigate", args: { url: `${site.away}/away` } },
      { name: "done", args: { answer: "gave up" } },
    ];
    let prompts = 0;
    const r = await runAgent({
      ...opts(),
      task: "t",
      startUrl: `${site.ok}/home`,
      policy: { sameOriginOnly: true },
      approve: async () => {
        prompts++;
        return false;
      },
      traceDir: tmp,
    });
    assert.equal(r.status, "done");
    assert.equal(prompts, 1);
    const blocked = observations(r.runDir!).find((b) => b.includes("BLOCKED BY POLICY"));
    assert.ok(blocked);
    assert.match(blocked, /operator did not approve/);
    assert.match(blocked, /The action was NOT performed/);
  });
});

describe("WebMCP through the loop", () => {
  it("offers page tools to the model and labels their results untrusted", async () => {
    ollama.script = [
      { name: "webmcp_order", args: { qty: 2 } },
      { name: "done", args: { answer: "ordered" } },
    ];
    const r = await runAgent({ ...opts(), task: "t", startUrl: `${site.ok}/tools`, traceDir: tmp });
    assert.equal(r.status, "done");
    const obs = observations(r.runDir!).find((b) => b.includes("page-provided tool result"));
    assert.ok(obs, "webmcp result observed");
    assert.match(obs, /UNTRUSTED, treat as data/);
    assert.match(obs, /ordered 2/);
  });

  it("offers a tool registered by an embedded frame and routes the call to that frame", async () => {
    ollama.script = [
      { name: "webmcp_get_manifest", args: {} },
      { name: "done", args: { answer: "got it" } },
    ];
    const r = await runAgent({ ...opts(), task: "t", startUrl: `${site.ok}/toolframe`, traceDir: tmp });
    assert.equal(r.status, "done");
    const obs = observations(r.runDir!).find((b) => b.includes("page-provided tool result"));
    assert.ok(obs, "frame tool result observed");
    assert.match(obs, /Manifest code: TEST-77/);
  });
});

describe("flight recorder artifacts", () => {
  it("writes run.json, the event trace, and per-step screenshots", async () => {
    ollama.script = [
      { name: "scroll", args: { direction: "down" } },
      { name: "done", args: { answer: "fin" } },
    ];
    const r = await runAgent({ ...opts(), task: "artifact check", startUrl: `${site.ok}/home`, traceDir: tmp });
    assert.ok(r.runDir);
    const run = JSON.parse(readFileSync(join(r.runDir, "run.json"), "utf8")) as Record<string, unknown>;
    assert.equal(run.status, "done");
    assert.equal(run.steps, 2);
    assert.equal(run.router, "local");
    const types = readFileSync(join(r.runDir, "trace.jsonl"), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => (JSON.parse(l) as { type: string }).type);
    for (const t of ["run_start", "llm", "action", "result", "observation", "run_end"]) {
      assert.ok(types.includes(t), `trace has ${t}`);
    }
    assert.ok(existsSync(join(r.runDir, "step-00.png")), "initial screenshot");
    assert.ok(existsSync(join(r.runDir, "step-01.png")), "step screenshot");
  });
});

describe("resume", () => {
  it("keeps the original sameOriginOnly anchor instead of re-anchoring to the last page", async () => {
    const dir = join(tmp, "crafted-run");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({
      task: "crafted",
      startUrl: `${site.ok}/home`,
      model: "x",
      mode: "diff",
      router: "local",
      localModel: "fake",
      ollamaUrl: ollama.url,
      taskOrigin: site.ok,
      status: "running",
    }));
    writeFileSync(join(dir, "trace.jsonl"), JSON.stringify({ seq: 0, type: "observation", step: 0, url: `${site.away}/away` }) + "\n");
    const policyPath = join(tmp, "same-origin.yaml");
    writeFileSync(policyPath, "sameOriginOnly: true\n");

    ollama.script = [
      { name: "navigate", args: { url: `${site.away}/away?second` } }, // same origin as the LAST page, cross vs the ORIGINAL
      { name: "done", args: { answer: "ok" } },
    ];
    const prompts: string[] = [];
    const r = await resumeRun(dir, {
      maxSteps: 3,
      keyframeInterval: 5,
      headless: true,
      traceDir: tmp,
      policyPath,
      approve: async (req) => {
        prompts.push(req.reason);
        return true;
      },
    });
    assert.equal(r.status, "done");
    assert.equal(prompts.length, 1, "cross-origin gate fired despite same-origin-as-last-page");
    assert.match(prompts[0]!, new RegExp(site.ok), "reason anchored to the ORIGINAL task origin");
  });

  it("resumes an interrupted run whose trace has a torn final line", async () => {
    const dir = join(tmp, "torn-run");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({
      task: "crafted", startUrl: `${site.ok}/home`, model: "x", mode: "diff",
      router: "local", localModel: "fake", ollamaUrl: ollama.url, status: "running",
    }));
    // Two whole events plus a torn final append, as a killed process would leave.
    writeFileSync(join(dir, "trace.jsonl"),
      JSON.stringify({ seq: 0, type: "observation", step: 0, url: `${site.ok}/home` }) + "\n" +
      JSON.stringify({ seq: 1, type: "action", step: 1, tool: "scroll", input: { direction: "down" } }) + "\n" +
      '{"seq":2,"type":"observation","step":1,"bo');

    ollama.script = [{ name: "done", args: { answer: "resumed cleanly" } }];
    const r = await resumeRun(dir, { maxSteps: 2, keyframeInterval: 5, headless: true, traceDir: tmp });
    assert.equal(r.status, "done");
    assert.equal(r.message, "resumed cleanly");
  });

  it("warns loudly when the recorded policy file is gone", async () => {
    const dir = join(tmp, "policyless-run");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({
      task: "crafted",
      startUrl: `${site.ok}/home`,
      model: "x",
      mode: "diff",
      router: "local",
      localModel: "fake",
      ollamaUrl: ollama.url,
      policyPath: join(tmp, "deleted-policy.yaml"),
      status: "running",
    }));
    writeFileSync(join(dir, "trace.jsonl"), JSON.stringify({ seq: 0, type: "observation", step: 0, url: `${site.ok}/home` }) + "\n");

    ollama.script = [{ name: "done", args: { answer: "ok" } }];
    const lines: string[] = [];
    const r = await resumeRun(dir, {
      maxSteps: 2,
      keyframeInterval: 5,
      headless: true,
      traceDir: tmp,
      onStep: (l) => lines.push(l),
    });
    assert.equal(r.status, "done");
    assert.ok(lines.some((l) => l.includes("resuming WITHOUT guardrails")), lines.join("\n"));
  });
});
