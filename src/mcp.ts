import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSession } from "./browser.js";
import { formatFull } from "./observe.js";
import { runAgent } from "./agent.js";
import { evaluateAction, isGuardedTool, EMPTY_POLICY, type Policy } from "./guardrails.js";
import type { ActionResult, Snapshot } from "./types.js";

const VERSION = "0.1.0";

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** One interactive browser session shared across snapshot/act/recall calls. */
class Interactive {
  private session?: BrowserSession;
  private visited: { url: string; title: string; text: string }[] = [];
  taskOrigin?: string;

  private async ensure(): Promise<BrowserSession> {
    if (!this.session) this.session = await BrowserSession.launch({ headless: true });
    return this.session;
  }

  currentUrl(): string {
    try {
      return this.session?.page.url() ?? "about:blank";
    } catch {
      return "about:blank";
    }
  }

  private record(s: Snapshot): void {
    this.visited.push({ url: s.url, title: s.title, text: s.text });
    if (this.visited.length > 50) this.visited.shift();
  }

  private noteOrigin(url: string): void {
    if (this.taskOrigin) return;
    try {
      this.taskOrigin = new URL(url).origin;
    } catch {
      /* ignore */
    }
  }

  async navigateAndSnapshot(url: string): Promise<Snapshot> {
    const b = await this.ensure();
    await b.navigate(url);
    this.noteOrigin(url);
    const s = await b.snapshot();
    this.record(s);
    return s;
  }

  async snapshot(): Promise<Snapshot> {
    const b = await this.ensure();
    const s = await b.snapshot();
    this.record(s);
    return s;
  }

  async act(tool: string, input: Record<string, unknown>): Promise<{ result: ActionResult; snapshot: Snapshot }> {
    const b = await this.ensure();
    let result: ActionResult;
    switch (tool) {
      case "navigate":
        result = await b.navigate(String(input.url ?? ""));
        this.noteOrigin(String(input.url ?? ""));
        break;
      case "click":
        result = await b.click(Number(input.ref));
        break;
      case "type":
        result = await b.type(Number(input.ref), String(input.text ?? ""), Boolean(input.submit));
        break;
      case "select_option":
        result = await b.selectOption(Number(input.ref), String(input.value ?? ""));
        break;
      case "scroll":
        result = await b.scroll(input.direction === "up" ? "up" : "down");
        break;
      case "go_back":
        result = await b.goBack();
        break;
      default:
        result = { ok: false, detail: `unknown tool: ${tool}` };
    }
    const s = await b.snapshot();
    this.record(s);
    return { result, snapshot: s };
  }

  recall(query: string, limit = 3): string {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: { url: string; snippet: string; score: number }[] = [];
    for (const p of this.visited) {
      const lower = p.text.toLowerCase();
      let score = 0;
      let first = -1;
      for (const t of terms) {
        const idx = lower.indexOf(t);
        if (idx >= 0) {
          score++;
          if (first < 0 || idx < first) first = idx;
        }
      }
      if (score > 0) {
        const start = Math.max(0, first - 120);
        const snippet = p.text.slice(start, start + 320).replace(/\s+/g, " ").trim();
        hits.push({ url: p.url, snippet, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    if (hits.length === 0) return `No matches for "${query}" across ${this.visited.length} visited page(s).`;
    return hits.slice(0, limit).map((h) => `• ${h.url}\n  …${h.snippet}…`).join("\n\n");
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
  }
}

/** Build the Stickshaker MCP server. Reused by the CLI and by the test harness. */
export function buildServer(opts: { policy?: Policy | undefined; traceDir?: string | undefined }): {
  server: McpServer;
  close: () => Promise<void>;
} {
  const policy = opts.policy ?? EMPTY_POLICY;
  const interactive = new Interactive();
  const server = new McpServer({ name: "stickshaker", version: VERSION });

  server.registerTool(
    "browse_task",
    {
      title: "Browse to accomplish a task",
      description:
        "Run the autonomous browser agent on a natural-language task and return its answer. Self-contained: it opens its own browser, records a trace, and closes.",
      inputSchema: {
        task: z.string().describe("What to accomplish, in natural language."),
        url: z.string().optional().describe("Starting URL."),
        mode: z.enum(["diff", "full"]).optional().describe("Observation mode (default diff)."),
        max_steps: z.number().int().positive().optional().describe("Step cap (default 20)."),
      },
    },
    async ({ task, url, mode, max_steps }) => {
      if (!process.env.ANTHROPIC_API_KEY) return textResult("ANTHROPIC_API_KEY is not set on the server.", true);
      const result = await runAgent({
        task,
        startUrl: url,
        model: process.env.STICKSHAKER_MODEL ?? "claude-opus-4-8",
        mode: mode ?? "diff",
        maxSteps: max_steps ?? 20,
        keyframeInterval: 5,
        headless: true,
        policy,
        ...(opts.traceDir ? { traceDir: opts.traceDir } : {}),
      });
      const header = `status: ${result.status}   steps: ${result.steps}   cost: $${result.costUsd.toFixed(4)}${result.runDir ? `\ntrace: ${result.runDir}` : ""}`;
      return textResult(`${header}\n\n${result.message}`, result.status === "failed");
    },
  );

  server.registerTool(
    "snapshot",
    {
      title: "Snapshot the current page",
      description:
        "Return the interactive elements (each with a [ref]) and visible text of the current page. Optionally navigate to a URL first.",
      inputSchema: { url: z.string().optional().describe("If given, navigate here first.") },
    },
    async ({ url }) => {
      if (url) {
        const decision = evaluateAction(policy, { tool: "navigate", input: { url }, currentUrl: interactive.currentUrl(), taskOrigin: interactive.taskOrigin });
        if (decision.effect !== "allow") return textResult(`BLOCKED BY POLICY: ${decision.reason}`, true);
        return textResult(formatFull(await interactive.navigateAndSnapshot(url)));
      }
      return textResult(formatFull(await interactive.snapshot()));
    },
  );

  server.registerTool(
    "act",
    {
      title: "Perform one browser action",
      description:
        "Perform a single action on the current page and return the resulting snapshot. Refs come from the most recent snapshot.",
      inputSchema: {
        tool: z.enum(["navigate", "click", "type", "select_option", "scroll", "go_back"]),
        url: z.string().optional(),
        ref: z.number().int().optional(),
        text: z.string().optional(),
        value: z.string().optional(),
        submit: z.boolean().optional(),
        direction: z.enum(["up", "down"]).optional(),
      },
    },
    async (args) => {
      const { tool, ...rest } = args;
      const input = rest as Record<string, unknown>;
      if (isGuardedTool(tool)) {
        const decision = evaluateAction(policy, { tool, input, currentUrl: interactive.currentUrl(), taskOrigin: interactive.taskOrigin });
        if (decision.effect !== "allow") return textResult(`BLOCKED BY POLICY: ${decision.reason}. Action not performed.`, true);
      }
      const { result, snapshot } = await interactive.act(tool, input);
      return textResult(`${result.ok ? "OK" : "ERROR"}: ${result.detail}\n\n${formatFull(snapshot)}`, !result.ok);
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall from visited pages",
      description:
        "Keyword-search the text of pages visited so far in this session and return matching snippets. (Vector-based page memory is planned.)",
      inputSchema: { query: z.string().describe("What to look for.") },
    },
    async ({ query }) => textResult(interactive.recall(query)),
  );

  server.registerTool(
    "get_trace",
    {
      title: "Read a run trace",
      description: "Summarize a run directory produced by browse_task or the CLI: status, steps, cost, and the last events.",
      inputSchema: { run_dir: z.string().describe("Path to a run directory (under .stickshaker/traces/).") },
    },
    async ({ run_dir }) => {
      const runJson = join(run_dir, "run.json");
      if (!existsSync(runJson)) return textResult(`No run.json in ${run_dir}`, true);
      const summary = JSON.parse(readFileSync(runJson, "utf8")) as Record<string, unknown>;
      const tracePath = join(run_dir, "trace.jsonl");
      const events = existsSync(tracePath) ? readFileSync(tracePath, "utf8").split("\n").filter(Boolean) : [];
      const tail = events
        .slice(-8)
        .map((l) => {
          try {
            const e = JSON.parse(l) as { type: string; step?: number };
            return `  ${e.type}${e.step != null ? " #" + e.step : ""}`;
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join("\n");
      return textResult(
        `task: ${summary.task}\nstatus: ${summary.status}   steps: ${summary.steps ?? "?"}   cost: $${Number(summary.costUsd ?? 0).toFixed(4)}\nlast events:\n${tail}`,
      );
    },
  );

  return { server, close: () => interactive.close() };
}

export async function startStdioServer(opts: { policy?: Policy | undefined; traceDir?: string | undefined }): Promise<void> {
  const { server, close } = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("stickshaker MCP server running on stdio");
  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
