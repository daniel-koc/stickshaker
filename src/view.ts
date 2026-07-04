import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface TraceEvent {
  seq: number;
  t?: string;
  type: string;
  step?: number;
  [k: string]: unknown;
}

interface StepView {
  step: number;
  screenshot?: string;
  action?: { tool: string; input: unknown };
  result?: { ok: boolean; detail: string };
  observation?: { kind: string; url: string; title: string; chars: number; body: string };
  llm?: { inputTokens: number; outputTokens: number; latencyMs: number; assistantText?: string };
  recovery?: string[];
}

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Bake a run's trace.jsonl + screenshots into a single self-contained report.html.
 * Screenshots are embedded as data URIs, so the file opens offline with no server
 * and can be shared as-is. This is the flight recorder's offline-debug surface.
 */
export function generateReport(runDir: string): string {
  const tracePath = join(runDir, "trace.jsonl");
  if (!existsSync(tracePath)) throw new Error(`no trace.jsonl found in ${runDir}`);

  const events: TraceEvent[] = readFileSync(tracePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEvent);

  const summary: Record<string, unknown> = existsSync(join(runDir, "run.json"))
    ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"))
    : {};

  const dataUri = (file: string): string | undefined => {
    const p = join(runDir, file);
    return existsSync(p) ? "data:image/png;base64," + readFileSync(p).toString("base64") : undefined;
  };

  const steps = new Map<number, StepView>();
  const stepOf = (n: number): StepView => {
    let v = steps.get(n);
    if (!v) {
      v = { step: n };
      steps.set(n, v);
    }
    return v;
  };

  for (const e of events) {
    const step = typeof e.step === "number" ? e.step : undefined;
    if (step === undefined) continue;
    const sv = stepOf(step);
    switch (e.type) {
      case "screenshot":
        sv.screenshot = dataUri(String(e.file));
        break;
      case "action":
        sv.action = { tool: String(e.tool), input: e.input };
        break;
      case "result":
        sv.result = { ok: Boolean(e.ok), detail: String(e.detail) };
        break;
      case "observation":
        sv.observation = {
          kind: String(e.kind),
          url: String(e.url),
          title: String(e.title),
          chars: Number(e.chars),
          body: String(e.body ?? ""),
        };
        break;
      case "llm":
        sv.llm = {
          inputTokens: Number(e.inputTokens),
          outputTokens: Number(e.outputTokens),
          latencyMs: Number(e.latencyMs),
          assistantText: e.assistantText ? String(e.assistantText) : undefined,
        };
        break;
      case "recovery":
        (sv.recovery ??= []).push(String(e.note));
        break;
    }
  }

  const ordered = [...steps.values()].sort((a, b) => a.step - b.step);
  const cost = typeof summary.costUsd === "number" ? summary.costUsd : 0;
  const usage = (summary.usage ?? {}) as { inputTokens?: number; outputTokens?: number };

  const cards = ordered
    .map((s) => {
      const badge = s.result
        ? `<span class="badge ${s.result.ok ? "ok" : "err"}">${s.result.ok ? "ok" : "error"}</span>`
        : "";
      const kindBadge = s.observation ? `<span class="badge kind">${esc(s.observation.kind)}</span>` : "";
      const action = s.action
        ? `<div class="action"><b>${esc(s.action.tool)}</b> <code>${esc(JSON.stringify(s.action.input))}</code></div>`
        : s.step === 0
          ? `<div class="action"><b>initial page</b></div>`
          : "";
      const llm = s.llm
        ? `<div class="meta">in ${s.llm.inputTokens} · out ${s.llm.outputTokens} tok · ${s.llm.latencyMs} ms</div>`
        : "";
      const think = s.llm?.assistantText
        ? `<div class="think">${esc(s.llm.assistantText)}</div>`
        : "";
      const resultDetail = s.result ? `<div class="detail">${esc(s.result.detail)}</div>` : "";
      const recovery = s.recovery?.length
        ? `<div class="recovery">⚠ ${s.recovery.map(esc).join("<br>")}</div>`
        : "";
      const obs = s.observation
        ? `<details><summary>observation sent to model · ${s.observation.chars} chars · ${esc(s.observation.url)}</summary><pre>${esc(s.observation.body)}</pre></details>`
        : "";
      const img = s.screenshot
        ? `<img src="${s.screenshot}" alt="step ${s.step}">`
        : `<div class="noshot">no screenshot</div>`;
      return `<section class="step">
  <div class="shot">${img}</div>
  <div class="body">
    <div class="head"><span class="n">${s.step === 0 ? "start" : "step " + s.step}</span> ${action} ${badge} ${kindBadge}</div>
    ${llm}${think}${resultDetail}${recovery}${obs}
  </div>
</section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Stickshaker run — ${esc(summary.task ?? runDir)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d1117; color: #c9d1d9; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { padding: 20px 28px; border-bottom: 1px solid #21262d; position: sticky; top: 0; background: #0d1117; }
  header h1 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
  header .sub { color: #8b949e; font-size: 13px; }
  header .kpi { margin-top: 10px; display: flex; gap: 22px; flex-wrap: wrap; }
  header .kpi b { color: #e6edf3; }
  main { max-width: 1100px; margin: 0 auto; padding: 22px 28px 60px; }
  .step { display: grid; grid-template-columns: 300px 1fr; gap: 20px; padding: 18px 0; border-bottom: 1px solid #161b22; }
  .shot img { width: 100%; border: 1px solid #21262d; border-radius: 6px; display: block; }
  .noshot { color: #6e7681; padding: 40px 0; text-align: center; border: 1px dashed #21262d; border-radius: 6px; }
  .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .head .n { font-weight: 700; color: #e6edf3; }
  .action code { color: #79c0ff; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .badge.ok { background: #12261e; color: #3fb950; }
  .badge.err { background: #2d1416; color: #f85149; }
  .badge.kind { background: #1c2333; color: #a5a5ff; }
  .meta { color: #8b949e; font-size: 12px; margin: 2px 0; }
  .think { color: #d2a8ff; margin: 6px 0; white-space: pre-wrap; }
  .detail { margin: 4px 0; }
  .recovery { color: #d29922; margin: 6px 0; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: #8b949e; }
  pre { background: #010409; border: 1px solid #21262d; border-radius: 6px; padding: 12px; overflow-x: auto; white-space: pre-wrap; max-height: 380px; overflow-y: auto; }
</style>
<header>
  <h1>${esc(summary.task ?? "Stickshaker run")}</h1>
  <div class="sub">${esc(summary.model ?? "")} · mode ${esc(summary.mode ?? "")}${summary.resumedFrom ? " · resumed from " + esc(summary.resumedFrom) : ""}</div>
  <div class="kpi">
    <span>status <b>${esc(summary.status ?? "?")}</b></span>
    <span>steps <b>${esc(summary.steps ?? ordered.length)}</b></span>
    <span>input <b>${esc(usage.inputTokens ?? "?")}</b> tok</span>
    <span>output <b>${esc(usage.outputTokens ?? "?")}</b> tok</span>
    <span>cost <b>$${cost.toFixed(4)}</b></span>
  </div>
</header>
<main>
${cards}
</main>`;

  const out = join(runDir, "report.html");
  writeFileSync(out, html);
  return out;
}
