import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateAction, evaluateDestination, isGuardedTool, loadPolicy, type Policy } from "../src/guardrails.js";

const ctx = (over: Partial<Parameters<typeof evaluateAction>[1]> = {}) => ({
  tool: "click",
  input: {},
  currentUrl: "http://ok.test/page",
  ...over,
});

describe("loadPolicy", () => {
  const dir = mkdtempSync(join(tmpdir(), "sk-policy-"));
  const load = (yaml: string): Policy => {
    const p = join(dir, `p${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(p, yaml);
    try {
      return loadPolicy(p);
    } finally {
      rmSync(p, { force: true });
    }
  };

  it("parses a full valid policy", () => {
    const p = load("domains:\n  allow: [a.com]\n  deny: ['*.b.com']\nsameOriginOnly: true\nrequireApproval: [navigate]\nblock: [scroll]\nbudgets:\n  maxSteps: 10\n  maxCostUsd: 0.5\n");
    assert.deepEqual(p.domains, { allow: ["a.com"], deny: ["*.b.com"] });
    assert.equal(p.sameOriginOnly, true);
    assert.deepEqual(p.budgets, { maxSteps: 10, maxCostUsd: 0.5 });
  });

  it("treats an empty file as an empty policy", () => {
    assert.deepEqual(load(""), {});
  });

  it("rejects an unknown top-level key (typo detection)", () => {
    assert.throws(() => load("sameoriginonly: true\n"), /invalid policy file/);
  });

  it("rejects an unknown nested key", () => {
    assert.throws(() => load("domains:\n  allowed: [a.com]\n"), /invalid policy file/);
  });

  it("rejects a mistyped value and names the path", () => {
    assert.throws(() => load("budgets:\n  maxSteps: ten\n"), /budgets\.maxSteps/);
  });

  it("rejects a scalar where an array is required", () => {
    assert.throws(() => load("block: navigate\n"), /invalid policy file/);
  });

  it("rejects non-positive budgets", () => {
    assert.throws(() => load("budgets:\n  maxSteps: 0\n"), /invalid policy file/);
  });
});

describe("evaluateAction", () => {
  it("allows everything under an empty policy", () => {
    assert.equal(evaluateAction({}, ctx()).effect, "allow");
    assert.equal(evaluateAction({}, ctx({ tool: "navigate", input: { url: "https://anywhere.io" } })).effect, "allow");
  });

  it("denies a blocked tool and allows others", () => {
    const p: Policy = { block: ["scroll"] };
    assert.equal(evaluateAction(p, ctx({ tool: "scroll" })).effect, "deny");
    assert.equal(evaluateAction(p, ctx({ tool: "click" })).effect, "allow");
  });

  it("requires approval for a listed tool", () => {
    const d = evaluateAction({ requireApproval: ["navigate"] }, ctx({ tool: "navigate", input: { url: "http://ok.test/" } }));
    assert.equal(d.effect, "approve");
  });

  it("denies a denied domain (exact host)", () => {
    const d = evaluateAction({ domains: { deny: ["evil.test"] } }, ctx({ tool: "navigate", input: { url: "http://evil.test/x" } }));
    assert.equal(d.effect, "deny");
  });

  it("matches *.glob against subdomains AND the apex, but not lookalikes", () => {
    const p: Policy = { domains: { deny: ["*.evil.test"] } };
    const nav = (url: string) => evaluateAction(p, ctx({ tool: "navigate", input: { url } })).effect;
    assert.equal(nav("http://sub.evil.test/"), "deny");
    assert.equal(nav("http://a.b.evil.test/"), "deny");
    assert.equal(nav("http://evil.test/"), "deny");
    assert.equal(nav("http://notevil.test/"), "allow");
    assert.equal(nav("http://evil.test.example.com/"), "allow");
  });

  it("matches hostnames regardless of port", () => {
    const d = evaluateAction({ domains: { deny: ["localhost"] } }, ctx({ tool: "navigate", input: { url: "http://localhost:8080/" } }));
    assert.equal(d.effect, "deny");
  });

  it("is case-insensitive on hosts and patterns", () => {
    const d = evaluateAction({ domains: { deny: ["EVIL.test"] } }, ctx({ tool: "navigate", input: { url: "http://Evil.TEST/" } }));
    assert.equal(d.effect, "deny");
  });

  it("deny wins over the allowlist", () => {
    const p: Policy = { domains: { allow: ["evil.test"], deny: ["evil.test"] } };
    assert.equal(evaluateAction(p, ctx({ tool: "navigate", input: { url: "http://evil.test/" } })).effect, "deny");
  });

  it("a non-empty allowlist denies hosts outside it", () => {
    const p: Policy = { domains: { allow: ["ok.test"] } };
    const nav = (url: string) => evaluateAction(p, ctx({ tool: "navigate", input: { url } })).effect;
    assert.equal(nav("http://ok.test/"), "allow");
    assert.equal(nav("http://other.test/"), "deny");
  });

  it("denies host-less navigation targets under an allowlist (data:), but allows about:blank", () => {
    const p: Policy = { domains: { allow: ["ok.test"] } };
    const nav = (url: string) => evaluateAction(p, ctx({ tool: "navigate", input: { url } })).effect;
    assert.equal(nav("data:text/html,<h1>hi</h1>"), "deny");
    assert.equal(nav("about:blank"), "allow");
  });

  it("allows data: navigation when no allowlist is configured", () => {
    assert.equal(evaluateAction({ domains: { deny: ["evil.test"] } }, ctx({ tool: "navigate", input: { url: "data:text/html,x" } })).effect, "allow");
  });

  it("checks navigate against the requested URL but other tools against the current page", () => {
    const p: Policy = { domains: { allow: ["ok.test"] } };
    assert.equal(evaluateAction(p, ctx({ tool: "click", currentUrl: "http://other.test/" })).effect, "deny");
    assert.equal(evaluateAction(p, ctx({ tool: "click", currentUrl: "http://ok.test/" })).effect, "allow");
  });

  it("sameOriginOnly: same origin allows, cross-origin requires approval, no anchor allows", () => {
    const p: Policy = { sameOriginOnly: true };
    const at = (url: string, taskOrigin?: string) =>
      evaluateAction(p, ctx({ tool: "navigate", input: { url }, taskOrigin })).effect;
    assert.equal(at("http://ok.test/deeper", "http://ok.test"), "allow");
    assert.equal(at("http://other.test/", "http://ok.test"), "approve");
    assert.equal(at("http://other.test/"), "allow");
  });

  it("guards webmcp_ tools like browser tools", () => {
    const d = evaluateAction({ block: ["webmcp_place_order"] }, ctx({ tool: "webmcp_place_order" }));
    assert.equal(d.effect, "deny");
  });
});

describe("evaluateDestination", () => {
  it("always allows about:blank and about:srcdoc (even under sameOriginOnly + allowlist)", () => {
    const p: Policy = { sameOriginOnly: true, domains: { allow: ["ok.test"] } };
    assert.equal(evaluateDestination(p, "about:blank", "http://ok.test").effect, "allow");
    // srcdoc frames carry parent-authored inline content; excluding them under an
    // allowlist would spuriously omit same-trust content from snapshots.
    assert.equal(evaluateDestination(p, "about:srcdoc", "http://ok.test").effect, "allow");
  });

  it("denies a denied domain landing", () => {
    assert.equal(evaluateDestination({ domains: { deny: ["evil.test"] } }, "http://evil.test/landed").effect, "deny");
  });

  it("denies landings outside a non-empty allowlist", () => {
    const p: Policy = { domains: { allow: ["ok.test"] } };
    assert.equal(evaluateDestination(p, "http://ok.test/fine").effect, "allow");
    assert.equal(evaluateDestination(p, "http://other.test/").effect, "deny");
  });

  it("denies host-less landings under an allowlist (data:)", () => {
    assert.equal(evaluateDestination({ domains: { allow: ["ok.test"] } }, "data:text/html,x").effect, "deny");
  });

  it("sameOriginOnly: cross-origin landing requires approval; same-origin allows", () => {
    const p: Policy = { sameOriginOnly: true };
    assert.equal(evaluateDestination(p, "http://other.test/", "http://ok.test").effect, "approve");
    assert.equal(evaluateDestination(p, "http://ok.test/deeper", "http://ok.test").effect, "allow");
  });
});

describe("isGuardedTool", () => {
  it("guards all browser-affecting tools and webmcp_*", () => {
    for (const t of ["navigate", "click", "type", "select_option", "scroll", "go_back", "webmcp_anything"]) {
      assert.equal(isGuardedTool(t), true, t);
    }
  });

  it("does not guard done/fail or unknown names", () => {
    for (const t of ["done", "fail", "webmcp", "recall", ""]) {
      assert.equal(isGuardedTool(t), false, t);
    }
  });
});
