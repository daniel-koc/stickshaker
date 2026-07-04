/** Shared types for the Stickshaker runtime. */

/** One interactive element found on the page, addressable by `ref`. */
export interface ElementInfo {
  /** Index into the current snapshot. Valid only until the next snapshot. */
  ref: number;
  tag: string;
  type?: string;
  role?: string;
  name: string;
  value?: string;
  href?: string;
}

/**
 * A full page snapshot. `--mode full` sends this in its entirety every turn — the
 * full-snapshot baseline the diff mode is measured against.
 */
export interface Snapshot {
  url: string;
  title: string;
  elements: ElementInfo[];
  text: string;
  elementsTruncated: boolean;
  textTruncated: boolean;
}

/** Outcome of a single browser action. */
export interface ActionResult {
  ok: boolean;
  detail: string;
}

/** Running token counters across an agent run. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** How the agent presents page state to the model. */
export type RunMode = "full" | "diff";

/** Per-step record for telemetry and the benchmark. */
export interface StepTelemetry {
  step: number;
  /** Which backend chose this step's action. */
  source: "cloud" | "local";
  kind: "full" | "diff";
  /** Input tokens for the call that chose this step's action. */
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock latency of the decision call, in ms. */
  latencyMs: number;
  /** Size of the observation appended after this step, in characters. */
  observationChars: number;
}
