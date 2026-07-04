# Stickshaker

**A systems-grade browser-agent runtime — an LLM drives a real Chromium
browser, built to be reliable, cheap, and debuggable.**

It runs as a **CLI**: point it at a URL with a natural-language task
and it drives the browser one tool call per turn.

> **Status: flight recorder + observability.** On top of the earlier layers
> (CLI + Playwright loop + Claude tool-use agent + incremental snapshot
> **diffing**), every run is now recorded as a replayable **flight-recorder**
> trace: an append-only JSONL log, a screenshot per step, OpenTelemetry spans,
> and a `run.json` checkpoint. `stickshaker view` bakes a run into a single
> self-contained HTML report for offline debugging, `stickshaker resume`
> restarts an interrupted run from its checkpoint, and a failed action forces a
> fresh re-snapshot so the agent re-grounds. Still ahead: multi-agent
> orchestration, local-model routing, prompt-injection defense, and the full
> eval matrix.

---

## Why

Most "LLM browses the web" loops re-send the whole page every turn, trust the
model to police itself, and log a wall of text when something breaks. Each of
those is a systems mistake, and each has a systems fix here:

- **Pages are delta streams, not documents.** Stable element refs +
  keyframe/delta observations + history elision keep the per-call context
  flat instead of growing with every step — **22.9% fewer input tokens** on a
  sample task, and the gap widens with task length.
- **Replayable traces beat verbose logs.** Every run is an append-only JSONL
  trace + a screenshot per step + OpenTelemetry spans, baked into a single
  offline HTML report. Interrupted runs are detectable and resumable.

---

## CLI commands

| Command | What it does |
|---------|--------------|
| `stickshaker run "<task>" --url <url>` | Drive Chromium to complete a task via tool use, one action per turn. Incremental `diff` mode by default (`--mode full` for the baseline); traces to `.stickshaker/traces/`. |
| `stickshaker bench "<task>" --url <url>` | Run the same task in `full` and `diff` mode and print the input-token reduction. |
| `stickshaker view <run-dir>` | Bake a run's trace into a self-contained `report.html`. No API key required. |
| `stickshaker resume <run-dir>` | Continue an interrupted run from its trace. |
| `stickshaker snapshot --url <url>` | Print the page's element list and text. No API key required. |

In a clone, run these as `pnpm stickshaker …` (tsx, no build step) or
`node dist/cli.js …` after `pnpm build`. `run` and `bench` default to
`--model claude-opus-4-8`; pass e.g. `--model claude-sonnet-5` to run cheaper.
Every run prints per-run **token and cost** accounting at the end.

---

## Quick Start

### 1. Prerequisites

- **Node.js ≥ 20.6** and **[pnpm](https://pnpm.io)** (`corepack enable`)
- An **Anthropic API key** for agent runs (create one in the
  [Anthropic Console](https://console.anthropic.com)) — `snapshot` and `view` work
  without one

### 2. Clone & build

```bash
git clone https://github.com/daniel-koc/stickshaker
cd stickshaker
pnpm install
pnpm exec playwright install chromium   # one-time browser download

# Try the browser layer with no API key:
pnpm stickshaker snapshot --url https://example.com

# Set your key, then run the agent:
cp .env.example .env    # then edit .env to add ANTHROPIC_API_KEY
pnpm stickshaker run "What is the top headline?" --url https://news.ycombinator.com
```


---

## Examples

```bash
# One-shot task, traced to .stickshaker/traces/
pnpm stickshaker run "What is the top headline?" --url https://news.ycombinator.com

# Watch the browser work; iterate on a cheaper model; allow a longer task
pnpm stickshaker run "Find the contact email" --url https://example.com \
  --headed --model claude-sonnet-5 --max-steps 40

# Replay a run offline; resume an interrupted one
pnpm stickshaker view .stickshaker/traces/<run-dir>
pnpm stickshaker resume .stickshaker/traces/<run-dir>

# Diff-vs-full token benchmark on any task
pnpm stickshaker bench "Fill the first text field with 'Stickshaker', choose 'Two' in the dropdown select menu, type 'hello' into the 'Type to search' field, then click Submit and report the confirmation message shown." \
  --url https://www.selenium.dev/selenium/web/web-form.html \
  --model claude-sonnet-5
```

---

## How it works

```
cli.ts ──▶ agent.ts ──▶ browser.ts (Playwright Chromium)
              │  observe.ts: full snapshot (keyframe) or delta vs. previous
              │  ↓
              └─▶ Claude (tool use: navigate / click / type / select / scroll / done / fail)
                   one action per turn → execute → observe → repeat
```

Every interactive element gets a **stable** `data-sk-ref` — a ref that stays on
the DOM node across turns (and resets on navigation), so the same element keeps
its number and successive snapshots can be diffed by ref. In `diff` mode the
agent sends a full **keyframe** on the first turn, after any navigation, and
every N steps (`--keyframe-interval`, default 5); in between it sends only
added/changed/removed elements and a text-changed flag. Older observations are
collapsed to placeholders so the per-call context stays flat instead of growing
with every step. `--mode full` disables all of this to reproduce the
full-snapshot baseline for benchmarking.

## Flight recorder

Tracing is on by default for CLI `run` (`--no-trace` to disable) and
`resume`, and off for the measurement command (`bench`). Every traced run
writes a directory under `.stickshaker/traces/`:
```
.stickshaker/traces/<timestamp>_<task-slug>/
  trace.jsonl        append-only event log: LLM I/O, actions, results, observations, timings
  step-NN.png        a screenshot per step
  otel-spans.jsonl   OpenTelemetry spans (one run span + one per step), file-exported
  run.json           checkpoint / summary (status stays "running" until the run finishes)
  report.html        self-contained offline report (generated by run/view)
```

`report.html` embeds the screenshots as data URIs, so it opens with no server
and can be shared as a single file — this is the offline-debugging surface.
Because `run.json` stays `"running"` until a run finishes cleanly, an
interrupted run is detectable, and `stickshaker resume <run-dir>` restarts it:
it restores the last page URL, hands the model a summary of the actions it
already took, and continues (recording a fresh linked trace).

---

## Benchmarks

Every claim reproduces with one command — see
[BENCHMARKS.md](docs/BENCHMARKS.md) for methodology, tables, and caveats.

| Claim | Measured |
|-------|----------|
| Incremental diffs vs. full re-send | **22.9% fewer input tokens**, 19.5% lower cost on a 5-step form task, same outcome |

## Layout

| File | Role |
|---|---|
| `src/cli.ts` | Command-line entry (`run`, `resume`, `view`, `bench`, `snapshot`) |
| `src/agent.ts` | The agent loop: tool-use loop, keyframe/delta decisions, history elision, failure recovery, recording |
| `src/browser.ts` | Playwright wrapper: launch, stable-ref snapshot, actions |
| `src/observe.ts` | Snapshot diffing and observation rendering (full + delta) |
| `src/recorder.ts` | Flight recorder: JSONL trace, screenshots, `run.json` checkpoint |
| `src/telemetry.ts` | OpenTelemetry spans exported to a JSONL file |
| `src/view.ts` | Self-contained HTML report generator |
| `src/resume.ts` | Reconstruct context from a trace and continue an interrupted run |
| `src/tools.ts` | Tool schemas |
| `src/llm.ts` | Model pricing / cost accounting |
| `src/types.ts` | Shared types |

## Development

From a local clone:

```bash
git clone https://github.com/daniel-koc/stickshaker
cd stickshaker
pnpm install
pnpm exec playwright install chromium   # one-time browser download

pnpm stickshaker …   # run the CLI via tsx (no build step)
pnpm typecheck       # tsc --noEmit
pnpm build           # compile to dist/
```

---

## License

[Apache-2.0](./LICENSE) © 2026 Daniel Kocielinski
