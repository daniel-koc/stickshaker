# Stickshaker

**A systems-grade browser-agent runtime — an LLM drives a real Chromium
browser, built to be reliable, cheap, and debuggable.**

It runs as a **CLI**: point it at a URL with a natural-language task
and it drives the browser one tool call per turn.

> **Status: snapshot diff engine.** On top of the baseline skeleton (CLI +
> Playwright loop + Claude tool-use agent), the agent now sends incremental
> page **deltas** instead of a full snapshot every turn, and elides stale
> observations from history so context stays bounded. On a sample form-fill
> task this cut input tokens **22.9%** at the same outcome — see
> [BENCHMARKS.md](docs/BENCHMARKS.md). Still ahead: a replayable
> **flight-recorder** trace, multi-agent orchestration, local-model routing,
> prompt-injection defense, and the full eval matrix.

---

## Why

Most "LLM browses the web" loops re-send the whole page every turn, trust the
model to police itself, and log a wall of text when something breaks. Each of
those is a systems mistake, and each has a systems fix here:

- **Pages are delta streams, not documents.** Stable element refs +
  keyframe/delta observations + history elision keep the per-call context
  flat instead of growing with every step — **22.9% fewer input tokens** on a
  sample task, and the gap widens with task length.

---

## CLI commands

| Command | What it does |
|---------|--------------|
| `stickshaker run "<task>" --url <url>` | Drive Chromium to complete a task via tool use, one action per turn. Incremental `diff` mode by default (`--mode full` for the baseline). |
| `stickshaker bench "<task>" --url <url>` | Run the same task in `full` and `diff` mode and print the input-token reduction. |
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
  [Anthropic Console](https://console.anthropic.com)) — `snapshot` works without
  one

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
# One-shot task
pnpm stickshaker run "What is the top headline?" --url https://news.ycombinator.com

# Watch the browser work; iterate on a cheaper model; allow a longer task
pnpm stickshaker run "Find the contact email" --url https://example.com \
  --headed --model claude-sonnet-5 --max-steps 40

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
| `src/cli.ts` | Command-line entry (`run`, `bench`, `snapshot`) |
| `src/agent.ts` | The agent loop: tool-use loop, keyframe/delta decisions, history elision |
| `src/browser.ts` | Playwright wrapper: launch, stable-ref snapshot, actions |
| `src/observe.ts` | Snapshot diffing and observation rendering (full + delta) |
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
