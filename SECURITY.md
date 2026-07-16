# Security policy

Stickshaker drives a real browser with an LLM in the loop, so it is worth
stating precisely where the security boundary sits. The short version, argued
in [DESIGN.md](docs/DESIGN.md#4-the-model-is-not-a-security-boundary): the
model is not the boundary — the policy engine is. Page content can fool the
model; it must never be able to defeat the policy.

## Reporting a vulnerability

Report privately via GitHub (Security tab → "Report a vulnerability") or by
email to daniel.koc@gmail.com. Please don't open a public issue for anything
exploitable. This is a one-person project: expect an acknowledgment within a
few days, a fix as fast as severity warrants, and credit unless you'd rather
skip it.

## Supported versions

Pre-1.0, only the latest commit on `main` is supported.

## What counts as a vulnerability

- **Guardrail bypass** — any way a browser-affecting action escapes a
  correctly written policy: domain allow/deny globs, `sameOriginOnly`, tool
  blocks, approval gates, or budgets. Redirects, popups, embedded frames,
  `data:`/`blob:` URLs, and page-provided (WebMCP) tools are all inside the
  enforcement perimeter; a hole in any of them is a bug.
- **Fence escape** — page-controlled bytes (page text, titles, iframe or
  shadow-root content, accessible names, page-provided tool metadata and
  results) reaching the model outside their untrusted labeling, or forged
  fence markers surviving neutralization.
- **Secret exposure** — password-field values reaching the model, the trace,
  or the report (they are redacted at snapshot capture); an API key leaking
  into any artifact; or any value from a `--storage-state` file (cookie or
  localStorage contents) appearing in a trace, an observation, a report, or a
  model request — the runtime records the *path* of the state file, never its
  contents, and a sentinel-based leak test enforces exactly this.
- **Storage-state gate bypass** — the MCP server loading a storage-state file
  (via `browse_task`'s `storage_state` argument or the `--storage-state`
  launch flag) without the policy's explicit `allowStorageState: true`, or a
  resume silently continuing unauthenticated after the recorded state file
  disappeared.
- **Trace escape** — `get_trace` or the report generator reading files
  outside the run directory they were pointed at.

## What doesn't

- The model *obeying* an injected instruction that the policy allows. That is
  a model-robustness problem — measured by the injection suite in
  [BENCHMARKS.md](docs/BENCHMARKS.md), mitigated by provenance labeling — not
  a boundary break: nothing the model decides can exceed the policy.
- Content inside closed shadow roots being invisible to snapshots — a
  documented limitation, not an escape.
- Running without `--policy`. No policy means everything is allowed; that is
  the documented default, not a vulnerability.
- Bugs in Chromium or Playwright themselves — report those upstream.

## Hardening guidance

- Run with a policy. Start from
  [`stickshaker.policy.example.yaml`](stickshaker.policy.example.yaml); for
  anything that touches authenticated sessions, prefer a domain allowlist
  plus `sameOriginOnly: true` and `--approve prompt`.
- Treat a `--storage-state` file as what it is: a credentials file. State is
  applied when the browser context is created, so **the policy's origin rules
  are the only thing confining where that signed-in authority can be
  steered** — always pair state with a domain allowlist (the CLI warns when
  you don't; the `inject-authed` fixture measures the lure this confines).
  The runtime never writes the file's values anywhere — traces record the
  path only — but the file itself is yours to protect, and the *pages* an
  authenticated session visits render account data that lands in traces and
  screenshots like any other page content.
- Treat `.stickshaker/traces/` as sensitive. A trace holds the page text and
  a screenshot of everything the agent saw — for authenticated runs, that is
  logged-in content. Password fields are redacted; nothing else is.
- Keep `ANTHROPIC_API_KEY` in `.env` or the environment — never in a policy
  file or a task string, where it would end up in the trace.
