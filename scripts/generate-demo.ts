/**
 * Regenerate the committed demo artifacts:
 *   docs/demo-report.html     the real, self-contained flight-recorder report
 *   docs/demo-filmstrip.png   a hero storyboard for the README, rendered from the
 *                             run's own step screenshots (no ffmpeg / image libs)
 *
 * Best-effort: it drives a LIVE site (Hacker News), so exact steps drift over time.
 * The point is to show the instrumentation on a page a reader recognizes; the fully
 * reproducible, deterministic path is `stickshaker eval` against the self-hosted
 * fixtures. Run with:  pnpm demo   (needs ANTHROPIC_API_KEY and network).
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/agent.js";
import { generateReport } from "../src/view.js";

(process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is required to generate the demo.");
  process.exit(1);
}

const TASK =
  "Open the 'Ask HN' section on Hacker News, then open the comments page of the top Ask HN post and report its title and how many comments it has.";
const START_URL = "https://news.ycombinator.com/";
const MODEL = "claude-sonnet-5";

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Trim to a word boundary so the hero footer never cuts mid-word. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(" ", n);
  return s.slice(0, cut > 0 ? cut : n) + "…";
}

interface TraceEvent { type: string; step?: number; file?: string; tool?: string; input?: unknown; url?: string; assistantText?: string }

/** One human-readable caption for the action taken to REACH a step's screenshot. */
function caption(ev: TraceEvent | undefined): string {
  if (!ev) return "initial page";
  const input = (ev.input ?? {}) as Record<string, unknown>;
  switch (ev.tool) {
    case "navigate": return `navigate → ${String(input.url ?? "")}`;
    case "click": return `click [${String(input.ref)}]`;
    case "type": return `type [${String(input.ref)}] ${JSON.stringify(String(input.text ?? "")).slice(0, 30)}`;
    case "select_option": return `select [${String(input.ref)}] = ${JSON.stringify(String(input.value ?? ""))}`;
    case "scroll": return `scroll ${String(input.direction ?? "")}`;
    case "go_back": return "go back";
    case "done": return "done — answer reported";
    default: return ev.tool ? String(ev.tool) : "step";
  }
}

async function main(): Promise<void> {
  mkdirSync("docs", { recursive: true });
  console.error(`▶ demo: ${TASK}`);

  const result = await runAgent({
    task: TASK,
    startUrl: START_URL,
    model: MODEL,
    mode: "diff",
    maxSteps: 8,
    keyframeInterval: 5,
    headless: true,
    traceDir: ".stickshaker/traces",
    onStep: (l) => console.error("  " + l),
  });

  if (!result.runDir) throw new Error("no run directory produced");
  console.error(`\n● status: ${result.status}   steps: ${result.steps}   cost: $${result.costUsd.toFixed(4)}`);
  console.error(`● answer: ${result.message}`);

  // 1) The self-contained report — the project's signature artifact.
  const report = generateReport(result.runDir);
  copyFileSync(report, join("docs", "demo-report.html"));
  console.error("● wrote docs/demo-report.html");

  // 2) Build the hero filmstrip from the run's OWN screenshots + trace captions.
  const events: TraceEvent[] = readFileSync(join(result.runDir, "trace.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as TraceEvent);
  const actionByStep = new Map<number, TraceEvent>();
  for (const e of events) if (e.type === "action" && typeof e.step === "number") actionByStep.set(e.step, e);

  const shots = events
    .filter((e) => e.type === "screenshot" && typeof e.step === "number" && e.file)
    .map((e) => ({ step: e.step!, file: e.file! }))
    .filter((s) => existsSync(join(result.runDir!, s.file)));

  // Keep the frame count readable: always the first and last, sample the middle.
  const pick = shots.length <= 5 ? shots : [shots[0]!, ...shots.slice(1, -1).filter((_, i, a) => i % Math.ceil(a.length / 3) === 0).slice(0, 3), shots[shots.length - 1]!];

  const cards = pick.map((s, i) => {
    const uri = "data:image/png;base64," + readFileSync(join(result.runDir!, s.file)).toString("base64");
    const label = s.step === 0 ? "initial page" : caption(actionByStep.get(s.step));
    const n = s.step === 0 ? "start" : `step ${s.step}`;
    return `<figure class="card">
      <div class="frame"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><img src="${uri}" alt="${esc(n)}"></div>
      <figcaption><b>${esc(n)}</b> · ${esc(label)}${i < pick.length - 1 ? ' <span class="arrow">→</span>' : ""}</figcaption>
    </figure>`;
  }).join("\n");

  const html = `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { background: #0d1117; color: #c9d1d9; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 34px 40px; width: max-content; }
    .brand { display: flex; align-items: baseline; gap: 14px; }
    .brand h1 { font-size: 30px; color: #e6edf3; letter-spacing: -0.5px; }
    .brand .tag { color: #8b949e; font-size: 15px; }
    .task { margin: 12px 0 22px; color: #79c0ff; font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .task span { color: #6e7681; }
    .strip { display: flex; gap: 22px; align-items: flex-start; }
    .card { width: 360px; }
    .frame { border: 1px solid #30363d; border-radius: 8px; overflow: hidden; background: #010409; }
    .bar { height: 22px; background: #161b22; display: flex; align-items: center; gap: 6px; padding: 0 9px; border-bottom: 1px solid #30363d; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #30363d; }
    .frame img { display: block; width: 100%; height: 225px; object-fit: cover; object-position: top; }
    figcaption { margin-top: 9px; color: #adbac7; font-size: 13px; position: relative; }
    figcaption b { color: #e6edf3; }
    .arrow { position: absolute; right: -19px; top: 0; color: #444c56; font-size: 16px; }
    .foot { margin-top: 24px; display: flex; gap: 26px; align-items: center; color: #8b949e; font-size: 14px; }
    .foot .kpi b { color: #3fb950; }
    .foot .ans { color: #c9d1d9; max-width: 900px; }
    .foot .ans b { color: #e6edf3; }
  </style>
  <div class="brand"><h1>✈ Stickshaker</h1><span class="tag">an LLM drives a real Chromium browser — one action per turn, every step recorded to a replayable trace.</span></div>
  <div class="task"><span>task:</span> ${esc(TASK)}</div>
  <div class="strip">${cards}</div>
  <div class="foot">
    <span class="kpi"><b>${result.steps}</b> steps · <b>$${result.costUsd.toFixed(4)}</b> · ${esc(MODEL)}</span>
    <span class="ans"><b>answer:</b> ${esc(truncate(result.message, 190))}</span>
  </div>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "networkidle" });
    const body = await page.$("body");
    await body!.screenshot({ path: join("docs", "demo-filmstrip.png") });
    console.error("● wrote docs/demo-filmstrip.png");
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
