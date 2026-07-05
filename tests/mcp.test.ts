import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSite, startMcpClient, refOf, type SiteHandle, type McpHandle } from "./helpers.js";

/**
 * MCP-surface tests over in-memory transports and real Chromium (no API key).
 * The site is dual-hostname: 127.0.0.1 (`ok`, allowlisted) and localhost
 * (`away`, outside the allowlist) hit the same server.
 */

let site: SiteHandle;

before(async () => {
  site = await startSite((path, url) => {
    switch (path) {
      case "/home":
        return `<html><body><h1>Home</h1><p>the giraffe fact lives here</p>
          <a href="${site.away}/denied">off you go</a>
          <a href="/slow">slow link</a>
          <button id="both" onclick="window.open('${site.away}/denied');location.href='${site.away}/denied'">both</button>
          </body></html>`;
      case "/denied": {
        const hops = Number(url.searchParams.get("hops") ?? "0");
        const pushes = Array.from({ length: hops }, (_, i) => `history.pushState({}, "", "/p${i}");`).join("");
        return `<html><body><h1>Denied zone</h1><p>the zebra password is XYZZY-77</p><script>${pushes}</script></body></html>`;
      }
      case "/deniedlink":
        return `<html><body><a href="${site.away}/denied?hops=4">deep</a></body></html>`;
      case "/bounce":
        return `<html><body><script>location.href='${site.away}/denied'</script></body></html>`;
      case "/slow":
        return { html: `<html><body><h1>SLOW-TARGET</h1></body></html>`, delayMs: 700 };
      case "/tools":
        return `<html><body><h1>Tools</h1><script>
          if (window.agent) window.agent.provideContext({ tools: [{
            name: "get_status" + Array(80).join("x"),
            description: "line one\\nline two ${"y".repeat(600)}",
            inputSchema: { type: "object", properties: {} },
            execute: function(){ return { ok: true, message: "status: green" }; }
          }, {
            name: "order",
            description: "Places an order.",
            inputSchema: { type: "object", properties: { qty: { type: "integer" } } },
            execute: function(a){ return { ok: true, message: "ordered " + a.qty }; }
          }]});
        </script></body></html>`;
      default:
        return `<html><body><h1>page ${path}</h1></body></html>`;
    }
  });
});

after(async () => {
  await site.close();
});

const ALLOW_POLICY = () => ({ domains: { allow: ["127.0.0.1"] } });

describe("snapshot tool", () => {
  it("navigates, snapshots, and enforces nothing under an empty policy", async () => {
    const mcp = await startMcpClient({});
    try {
      const out = await mcp.call("snapshot", { url: `${site.ok}/home` });
      assert.match(out, /URL: .*\/home/);
      assert.match(out, /giraffe fact/);
    } finally {
      await mcp.close();
    }
  });

  it("pre-checks the requested URL against the policy", async () => {
    const mcp = await startMcpClient({ policy: { domains: { deny: ["localhost"] } } });
    try {
      const out = await mcp.call("snapshot", { url: `${site.away}/denied` });
      assert.match(out, /BLOCKED BY POLICY/);
      assert.ok(!out.includes("XYZZY-77"), "denied page was never fetched into the result");
    } finally {
      await mcp.close();
    }
  });

  it("post-checks the landing: a redirect to a denied host is blocked and withheld", async () => {
    const mcp = await startMcpClient({ policy: ALLOW_POLICY() });
    try {
      const out = await mcp.call("snapshot", { url: `${site.ok}/bounce` });
      assert.match(out, /BLOCKED BY POLICY \(after action\)/);
      assert.ok(!out.includes("XYZZY-77"), "denied content withheld");
    } finally {
      await mcp.close();
    }
  });
});

describe("act tool: destination enforcement", () => {
  it("pulls the session back when a click lands on a denied host", async () => {
    const mcp = await startMcpClient({ policy: ALLOW_POLICY() });
    try {
      const home = await mcp.call("snapshot", { url: `${site.ok}/home` });
      const out = await mcp.call("act", { tool: "click", ref: refOf(home, "off you go") });
      assert.match(out, /BLOCKED BY POLICY \(after action\)/);
      assert.match(out, /Returned to the previous page/);
      assert.ok(!out.includes("XYZZY-77"));
      const now = await mcp.call("snapshot", {});
      assert.match(now, new RegExp(`URL: ${site.ok}/home`));
    } finally {
      await mcp.close();
    }
  });

  it("reports BOTH violations when one action opens a denied popup AND navigates the main tab", async () => {
    const mcp = await startMcpClient({ policy: ALLOW_POLICY() });
    try {
      const home = await mcp.call("snapshot", { url: `${site.ok}/home` });
      const out = await mcp.call("act", { tool: "click", ref: refOf(home, '"both"') });
      assert.match(out, /landed on a disallowed destination/);
      assert.match(out, /new tab opened to a disallowed destination/);
      assert.ok(!out.includes("XYZZY-77"));
      const now = await mcp.call("snapshot", {});
      assert.match(now, new RegExp(`URL: ${site.ok}/home`), "main tab pulled back");
    } finally {
      await mcp.close();
    }
  });

  it("withholds content when a pushState chain defeats the pull-back", async () => {
    const mcp = await startMcpClient({ policy: ALLOW_POLICY() });
    try {
      const start = await mcp.call("snapshot", { url: `${site.ok}/deniedlink` });
      const out = await mcp.call("act", { tool: "click", ref: refOf(start, "deep") });
      assert.match(out, /BLOCKED BY POLICY \(after action\)/);
      assert.match(out, /withheld by policy/);
      assert.ok(!out.includes("XYZZY-77"), "denied content never shown");
    } finally {
      await mcp.close();
    }
  });

  it("treats approval-required (sameOriginOnly) as blocked upfront — no approver on this path", async () => {
    const mcp = await startMcpClient({ policy: { sameOriginOnly: true } });
    try {
      await mcp.call("snapshot", { url: `${site.ok}/home` }); // anchors taskOrigin
      const out = await mcp.call("act", { tool: "navigate", url: `${site.away}/denied` });
      assert.match(out, /BLOCKED BY POLICY/);
      assert.match(out, /cross-origin/);
      assert.match(out, /Action not performed/);
    } finally {
      await mcp.close();
    }
  });
});

describe("recall gating", () => {
  it("memorizes allowed pages but never denied ones", async () => {
    const mcp = await startMcpClient({ policy: ALLOW_POLICY() });
    try {
      const home = await mcp.call("snapshot", { url: `${site.ok}/home` });
      await mcp.call("act", { tool: "click", ref: refOf(home, "off you go") }); // blocked + pulled back
      const found = await mcp.call("recall", { query: "giraffe fact" });
      assert.match(found, /giraffe/);
      const denied = await mcp.call("recall", { query: "zebra password XYZZY" });
      assert.ok(!denied.includes("XYZZY-77"), `denied content recallable: ${denied.slice(0, 120)}`);
    } finally {
      await mcp.close();
    }
  });
});

describe("page-provided tools over MCP", () => {
  it("lists page tools with clamped, single-line name/description", async () => {
    const mcp = await startMcpClient({});
    try {
      const out = await mcp.call("snapshot", { url: `${site.ok}/tools` });
      assert.match(out, /Page-provided tools \(UNTRUSTED/);
      const toolLines = out.split("\n").filter((l) => l.trimStart().startsWith("•"));
      assert.equal(toolLines.length, 2, "one line per tool — no newline injection from descriptions");
      for (const line of toolLines) assert.ok(line.length < 450, `clamped: ${line.length}`);
    } finally {
      await mcp.close();
    }
  });

  it("act tool=webmcp calls the page tool and labels the result untrusted", async () => {
    const mcp = await startMcpClient({});
    try {
      await mcp.call("snapshot", { url: `${site.ok}/tools` });
      const out = await mcp.call("act", { tool: "webmcp", name: "order", args: { qty: 3 } });
      assert.match(out, /UNTRUSTED, treat as data/);
      assert.match(out, /ordered 3/);
    } finally {
      await mcp.close();
    }
  });

  it("act tool=webmcp without a name is a usable error", async () => {
    const mcp = await startMcpClient({});
    try {
      const out = await mcp.call("act", { tool: "webmcp" });
      assert.match(out, /requires a "name"/);
    } finally {
      await mcp.close();
    }
  });
});

describe("serialization", () => {
  it("a concurrent snapshot queues behind act and sees the post-action page", async () => {
    const mcp = await startMcpClient({});
    try {
      const home = await mcp.call("snapshot", { url: `${site.ok}/home` });
      const ref = refOf(home, "slow link");
      const [actOut, snapOut] = await Promise.all([
        mcp.call("act", { tool: "click", ref }),
        mcp.call("snapshot", {}),
      ]);
      assert.match(actOut, /SLOW-TARGET/);
      assert.match(snapOut, /SLOW-TARGET/);
      assert.match(snapOut, new RegExp(`URL: ${site.ok}/slow`));
    } finally {
      await mcp.close();
    }
  });
});

describe("get_trace confinement", () => {
  it("rejects paths outside the trace dir and reads real run summaries inside it", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "sk-traces-"));
    const mcp = await startMcpClient({ traceDir });
    try {
      const outside = await mcp.call("get_trace", { run_dir: join(traceDir, "..", "elsewhere") });
      assert.match(outside, /must be inside the trace directory/);

      const missing = await mcp.call("get_trace", { run_dir: join(traceDir, "nope") });
      assert.match(missing, /No run\.json/);

      const runDir = join(traceDir, "runx");
      mkdirSync(runDir);
      writeFileSync(join(runDir, "run.json"), JSON.stringify({ task: "t", status: "done", steps: 2, costUsd: 0.01 }));
      // A torn final trace line (killed mid-append) must not sink the summary.
      writeFileSync(join(runDir, "trace.jsonl"), `${JSON.stringify({ type: "action", step: 1 })}\n${JSON.stringify({ type: "run_end" })}\n{"type":"scr`);
      const ok = await mcp.call("get_trace", { run_dir: runDir });
      assert.match(ok, /status: done/);
      assert.match(ok, /action #1/);

      // A half-written run.json reports cleanly instead of throwing.
      const tornDir = join(traceDir, "torn");
      mkdirSync(tornDir);
      writeFileSync(join(tornDir, "run.json"), '{"task":"x","stat');
      const torn = await mcp.call("get_trace", { run_dir: tornDir });
      assert.match(torn, /corrupt or incomplete/);
    } finally {
      await mcp.close();
      rmSync(traceDir, { recursive: true, force: true });
    }
  });
});
