import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Declarative, out-of-model action policy. The LLM proposes actions; this engine,
 * running in ordinary code the model has no way to influence, decides whether each
 * one runs. That separation is deliberate: a prompt injection can fool the model,
 * but it cannot edit the policy.
 */
export interface Policy {
  domains?: { allow?: string[]; deny?: string[] };
  /** Actions that leave the task's starting origin require approval. */
  sameOriginOnly?: boolean;
  /** Tool names that require human-in-the-loop approval. */
  requireApproval?: string[];
  /** Tool names that are always blocked. */
  block?: string[];
  budgets?: { maxSteps?: number; maxCostUsd?: number };
}

export const EMPTY_POLICY: Policy = {};

export type Decision =
  | { effect: "allow" }
  | { effect: "deny"; reason: string }
  | { effect: "approve"; reason: string };

export interface ActionContext {
  tool: string;
  input: Record<string, unknown>;
  currentUrl: string;
  taskOrigin?: string | undefined;
}

export function loadPolicy(path: string): Policy {
  const parsed = parseYaml(readFileSync(path, "utf8")) as Policy | null;
  return parsed ?? {};
}

function hostOf(url: string): string | null {
  try {
    // hostname, not host: a policy entry like "localhost" must match "localhost:8080".
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Host glob: `*` matches any run of characters; `*.example.com` also matches the apex. */
function globMatch(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith("*.") && host === p.slice(2)) return true;
  const re = new RegExp("^" + p.split("*").map(escapeRegex).join(".*") + "$");
  return re.test(host);
}

/** The browser-affecting tools that are subject to policy. */
export function isGuardedTool(tool: string): boolean {
  // Page-provided WebMCP tools run code on the current origin, so gate them too.
  return tool.startsWith("webmcp_") || ["navigate", "click", "type", "select_option", "scroll", "go_back"].includes(tool);
}

export function evaluateAction(policy: Policy, ctx: ActionContext): Decision {
  if (policy.block?.includes(ctx.tool)) {
    return { effect: "deny", reason: `tool "${ctx.tool}" is blocked by policy` };
  }

  // For navigation the target is the requested URL; for everything else it's the
  // page the action would run on.
  const targetUrl = ctx.tool === "navigate" ? String(ctx.input.url ?? "") : ctx.currentUrl;
  const host = hostOf(targetUrl);
  const origin = originOf(targetUrl);

  if (host && policy.domains?.deny?.some((p) => globMatch(p, host))) {
    return { effect: "deny", reason: `domain "${host}" is denied by policy` };
  }
  if (policy.domains?.allow?.length && host && !policy.domains.allow.some((p) => globMatch(p, host))) {
    return { effect: "deny", reason: `domain "${host}" is not in the policy allowlist` };
  }
  if (policy.sameOriginOnly && ctx.taskOrigin && origin && origin !== ctx.taskOrigin) {
    return { effect: "approve", reason: `cross-origin action to ${origin} (task origin ${ctx.taskOrigin})` };
  }
  if (policy.requireApproval?.includes(ctx.tool)) {
    return { effect: "approve", reason: `tool "${ctx.tool}" requires approval` };
  }
  return { effect: "allow" };
}

/**
 * Check where the browser actually *landed* after an action, independent of which
 * tool triggered it. The pre-action check only sees the `navigate` tool's target
 * URL; this catches a denied or cross-origin page reached via a click, a form
 * submit, or a page-provided tool that set `location`. Only the domain/origin
 * rules apply here — `block` / `requireApproval` are per-tool and already handled
 * before the action ran.
 */
export function evaluateDestination(policy: Policy, url: string, taskOrigin?: string): Decision {
  const host = hostOf(url);
  const origin = originOf(url);
  if (host && policy.domains?.deny?.some((p) => globMatch(p, host))) {
    return { effect: "deny", reason: `landed on denied domain "${host}"` };
  }
  if (policy.domains?.allow?.length && host && !policy.domains.allow.some((p) => globMatch(p, host))) {
    return { effect: "deny", reason: `landed on "${host}", which is not in the policy allowlist` };
  }
  if (policy.sameOriginOnly && taskOrigin && origin && origin !== taskOrigin) {
    return { effect: "approve", reason: `landed cross-origin at ${origin} (task origin ${taskOrigin})` };
  }
  return { effect: "allow" };
}
