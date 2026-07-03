# Stickshaker

**A systems-grade browser-agent runtime — an LLM drives a real Chromium
browser, built to be reliable, cheap, and debuggable.**

It runs as a **CLI**: point it at a URL with a natural-language task
and it drives the browser one tool call per turn.

> **Status: skeleton.** This is the naive full-snapshot baseline: a working CLI
> + Playwright loop + Claude tool-use agent. It exists so later work can
> measurably beat it. The differentiators — incremental snapshot **diffing**, a
> replayable **flight-recorder** trace, multi-agent orchestration, local-model
> routing, prompt-injection defense, and a benchmark harness — are still ahead.

---

## CLI commands

| Command | What it does |
|---------|--------------|
| `stickshaker run "<task>" --url <url>` | Drive Chromium to complete a task via tool use, one action per turn — a full page snapshot every turn, the deliberately naive baseline. |
| `stickshaker snapshot --url <url>` | Print the page's element list and text. No API key required. |

In a clone, run these as `pnpm stickshaker …` (tsx, no build step) or
`node dist/cli.js …` after `pnpm build`. `run` defaults to
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
```

---

## How it works

```
cli.ts ──▶ agent.ts ──▶ browser.ts (Playwright Chromium)
              │  snapshot: interactive elements (with [ref]) + visible text
              │  ↓
              └─▶ Claude (tool use: navigate / click / type / select / scroll / done / fail)
                   one action per turn → execute → fresh snapshot → repeat
```

Element refs are assigned per snapshot: every element gets a `data-sk-ref`
attribute so the agent can act on it by number. The **whole** snapshot is
re-sent each turn — that's the deliberately naive part. Stable refs and
per-turn diffs replace it later to cut tokens.

## Layout

| File | Role |
|---|---|
| `src/cli.ts` | Command-line entry (`run`, `snapshot`) |
| `src/agent.ts` | The agent loop (manual tool-use loop, one action per turn) |
| `src/browser.ts` | Playwright wrapper: launch, snapshot, actions |
| `src/tools.ts` | Tool schemas + snapshot formatting |
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
