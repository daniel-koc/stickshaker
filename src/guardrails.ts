import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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
  /**
   * Allow the MCP server to load a storage-state file (credentials) — the
   * `browse_task` `storage_state` argument and the `mcp --storage-state` launch
   * flag are both refused without it. Off by default: a client asking a server to
   * read a credentials file off local disk is a policy decision, not a free
   * argument. The CLI's own `--storage-state` is operator-typed (the same trust
   * as choosing the policy file itself) and is not gated by this.
   */
  allowStorageState?: boolean;
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

// Structural validation with unknown-key rejection: a policy is a security
// control, so a typo ("domain:", "sameoriginonly:") or a mistyped value
// ("maxSteps: ten") must fail loudly at load time, not silently enforce nothing.
const PolicySchema = z.strictObject({
  domains: z.strictObject({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  sameOriginOnly: z.boolean().optional(),
  requireApproval: z.array(z.string()).optional(),
  block: z.array(z.string()).optional(),
  allowStorageState: z.boolean().optional(),
  budgets: z.strictObject({
    maxSteps: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
  }).optional(),
});

export function loadPolicy(path: string): Policy {
  const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
  const res = PolicySchema.safeParse(parsed ?? {});
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid policy file ${path} — ${issues}`);
  }
  return res.data as Policy;
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
  // A host-less navigation target (data:, blob:, javascript:) can never match an
  // allowlist, so under one it is denied — otherwise data: URLs would be a way to
  // load arbitrary attacker-shaped pages that no host glob can ever cover.
  if (policy.domains?.allow?.length && ctx.tool === "navigate" && !host && targetUrl !== "about:blank") {
    return { effect: "deny", reason: `"${targetUrl.slice(0, 80)}" has no host and cannot match the domain allowlist` };
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
  // The initial empty document, and srcdoc frames. Popups start at about:blank,
  // and benign pages open a blank tab and write into it; an about:srcdoc frame's
  // content is authored inline by its parent page (same trust as the parent).
  // Neither has a host, so treating them as "cross-origin at null" would
  // false-positive on everyday patterns.
  if (url === "about:blank" || url === "about:srcdoc") return { effect: "allow" };
  const host = hostOf(url);
  const origin = originOf(url);
  if (host && policy.domains?.deny?.some((p) => globMatch(p, host))) {
    return { effect: "deny", reason: `landed on denied domain "${host}"` };
  }
  if (policy.domains?.allow?.length && !host) {
    // data:, blob:, javascript: — no host can ever match an allowlist.
    return { effect: "deny", reason: `landed on "${url.slice(0, 80)}", which has no host and cannot match the domain allowlist` };
  }
  if (policy.domains?.allow?.length && host && !policy.domains.allow.some((p) => globMatch(p, host))) {
    return { effect: "deny", reason: `landed on "${host}", which is not in the policy allowlist` };
  }
  if (policy.sameOriginOnly && taskOrigin && origin && origin !== taskOrigin) {
    return { effect: "approve", reason: `landed cross-origin at ${origin} (task origin ${taskOrigin})` };
  }
  return { effect: "allow" };
}
