import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { RunMode, Usage } from "./types.js";

export interface RunMeta {
  task: string;
  startUrl?: string | undefined;
  model: string;
  mode: RunMode;
  startedAt: string;
  resumedFrom?: string;
}

export interface RunSummary {
  status: string;
  message: string;
  steps: number;
  usage: Usage;
  costUsd: number;
  finishedAt: string;
}

/** A filesystem-safe run directory name: timestamp + task slug. */
export function runDirName(task: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `${iso}_${slug}`;
}

/**
 * The flight recorder: an append-only JSONL trace of everything a run did, plus a
 * screenshot per step and a run.json checkpoint. A finished run replays offline
 * from these files (see view.ts); an interrupted one resumes from them (resume.ts).
 * run.json stays status:"running" until finish(), so a killed process is detectable.
 */
export class Recorder {
  readonly dir: string;
  private readonly tracePath: string;
  private readonly meta: RunMeta;
  private seq = 0;

  constructor(dir: string, meta: RunMeta) {
    this.dir = dir;
    this.meta = meta;
    mkdirSync(dir, { recursive: true });
    this.tracePath = join(dir, "trace.jsonl");
    writeFileSync(this.tracePath, "");
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ...meta, status: "running" }, null, 2));
    this.event("run_start", { ...meta });
  }

  event(type: string, data: Record<string, unknown>): void {
    appendFileSync(this.tracePath, JSON.stringify({ seq: this.seq++, t: new Date().toISOString(), type, ...data }) + "\n");
  }

  async screenshot(page: Page, step: number): Promise<string | null> {
    const file = `step-${String(step).padStart(2, "0")}.png`;
    try {
      await page.screenshot({ path: join(this.dir, file) });
      this.event("screenshot", { step, file });
      return file;
    } catch {
      return null;
    }
  }

  finish(summary: RunSummary): void {
    this.event("run_end", {
      status: summary.status,
      steps: summary.steps,
      message: summary.message,
      usage: summary.usage,
      costUsd: summary.costUsd,
    });
    writeFileSync(join(this.dir, "run.json"), JSON.stringify({ ...this.meta, ...summary }, null, 2));
  }
}
