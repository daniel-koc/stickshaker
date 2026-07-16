/**
 * Shared harnesses for the test suite. Everything here runs with NO API key and
 * never talks to the cloud:
 *
 * - startSite: a local fixture web server, reachable via TWO hostnames for the
 *   same port — `ok` (127.0.0.1) and `away` (localhost) — so policy tests get an
 *   "allowed" and a "denied/cross-origin" origin from one process.
 * - startFakeOllama: a scripted OpenAI-compatible endpoint. Feeding it to the
 *   real runAgent with --router local drives the whole agent loop with
 *   predetermined tool calls — agent policy behavior is testable without any LLM.
 * - startMcpClient: buildServer wired to an in-memory MCP client.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp.js";

export interface SiteHandle {
  port: number;
  /** Base URL on the allowed hostname (127.0.0.1). */
  ok: string;
  /** Base URL on the other hostname (localhost) — a different host/origin for policy tests. */
  away: string;
  close: () => Promise<void>;
}

export type SiteResponse = string | { html: string; delayMs?: number };

export async function startSite(
  // Handlers that don't care about request headers just declare (path, url).
  handler: (path: string, url: URL, headers: IncomingHttpHeaders) => SiteResponse,
): Promise<SiteHandle> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://fixture");
    const r = handler(u.pathname, u, req.headers);
    const { html, delayMs = 0 } = typeof r === "string" ? { html: r } : r;
    const send = (): void => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
  // No host: binds the wildcard address (dual-stack), so both 127.0.0.1 and
  // localhost (which may resolve to ::1) reach it.
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    ok: `http://127.0.0.1:${port}`,
    away: `http://localhost:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeOllamaHandle {
  url: string;
  /** Mutable: unshift/replace between runs. Each completion request consumes one entry. */
  script: ScriptedCall[];
  /** Raw body of every completion request received — the bytes that actually left
   *  for the model backend, so leak tests can grep what the model was sent. */
  requests: string[];
  close: () => Promise<void>;
}

export async function startFakeOllama(initial: ScriptedCall[] = []): Promise<FakeOllamaHandle> {
  const handle: FakeOllamaHandle = { url: "", script: [...initial], requests: [], close: async () => {} };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/tags")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    // Capture the request body, then answer with the next scripted tool call.
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      handle.requests.push(body);
      const next = handle.script.shift() ?? { name: "fail", args: { reason: "script exhausted" } };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: "t1", type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  handle.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handle.close = () => new Promise<void>((r) => server.close(() => r()));
  return handle;
}

export interface McpHandle {
  client: Client;
  /** Call a tool and return its first text block. */
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}

export async function startMcpClient(opts: Parameters<typeof buildServer>[0]): Promise<McpHandle> {
  const { server, close } = buildServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stickshaker-tests", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    call: async (name, args = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }> };
      return r.content[0]?.text ?? "";
    },
    close: async () => {
      await client.close();
      await close();
    },
  };
}

/** The [ref] token of the first snapshot line whose text contains `label`. Handles
 *  both bare main-frame refs ("5") and frame-qualified refs ("f2:5"). */
export function refOf(snapshotText: string, label: string): string {
  for (const line of snapshotText.split("\n")) {
    if (line.includes(label)) {
      const m = /\[([A-Za-z0-9:]+)\]/.exec(line);
      if (m) return m[1]!;
    }
  }
  throw new Error(`no element containing ${JSON.stringify(label)} in snapshot:\n${snapshotText}`);
}

/** Agent-run defaults shared by the fake-Ollama tests. */
export function localAgentOpts(ollamaUrl: string) {
  return {
    model: "unused-cloud-model",
    mode: "diff" as const,
    maxSteps: 5,
    keyframeInterval: 5,
    headless: true,
    router: "local" as const,
    localModel: "fake",
    ollamaUrl,
  };
}
