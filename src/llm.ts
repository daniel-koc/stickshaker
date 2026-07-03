import type { Usage } from "./types.js";

/** USD per 1M tokens, by model. Feeds the cost counter the benchmark harness builds on. */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-fable-5": { in: 10, out: 50 },
};

/**
 * Estimated USD cost of a run. Cache reads bill at ~0.1x input and cache writes
 * at ~1.25x, matching Anthropic's published multipliers.
 */
export function costUsd(model: string, u: Usage): number {
  const p = PRICING[model] ?? { in: 5, out: 25 };
  return (
    u.inputTokens * p.in +
    u.outputTokens * p.out +
    u.cacheReadTokens * p.in * 0.1 +
    u.cacheCreationTokens * p.in * 1.25
  ) / 1_000_000;
}
