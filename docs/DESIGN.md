# Browser agents are a systems problem

Most "LLM browses the web" demos treat the browser as an afterthought: screenshot
or dump the DOM, ask the model what to click, repeat. That works in a demo and
falls over in production — on cost, on debuggability, on reliability, on security.
The interesting problems in browser automation aren't prompt problems. They're the
same problems I spent years on in a browser engine: how you represent changing
state, where you put the boundaries, and how you observe what happened.

[Stickshaker](../README.md) is a browser-agent runtime I built to take that position
seriously. Here are five places where the common abstraction is wrong, and what
the numbers looked like when I fixed each one. Every figure below is reproducible
from the repo — see [`BENCHMARKS.md`](./BENCHMARKS.md).

## 1. A page is a delta stream, not a document you re-read

The default loop re-sends the whole page every turn. But the API is stateless —
every call re-sends the entire conversation — so "the whole page every turn"
also means *every past page, on every future turn*: cost grows with the square
of the step count. That's not a page-size problem, it's a representation
problem, and it's one a compositor engineer has seen before: you don't
repaint the screen every frame, you track damage rects and push deltas.

Stickshaker gives every interactive element a stable id that rides on the DOM node,
sends a full **keyframe** only on navigation and every N steps, and sends **deltas**
in between — added, changed, and removed elements — while eliding stale observations
from history so context stays flat. On a multi-step form task this cut input tokens
**22.9%** at the identical outcome, and the gap widens with task length. The lesson
isn't "compress the prompt"; it's "stop modeling a stream as a series of documents."

## 2. Planning and actuation are different jobs — let them run on different models

If deciding *what* to do and deciding *how* to phrase a click are the same call to
the same frontier model, you pay frontier prices for both. They shouldn't be the
same call. Stickshaker routes each step: a small local model (via Ollama) proposes
the action, and only the steps it can't handle — or the ones that fail — escalate
to Claude. Cost accrues only on cloud steps.

On the eval suite, hybrid routing ran a task set for **~55% less** than cloud-only.
It also scored lower (3/4 vs 4/4 on one slice — the 3B model submitted a wrong form
value entirely on-device), which is the honest half of the story: this is a
cost-vs-accuracy dial, not a free lunch, and the runtime's job is to expose the
dial and measure it, not to pretend the cheap path is always right.

## 3. Replayable traces beat verbose logs

When an agent does the wrong thing on step 9 of 12, "more logging" is the wrong
tool. You want the crash dump: every observation the model saw, every decision it
made, every screenshot, replayable offline. Stickshaker writes each run as an
append-only JSONL trace plus a screenshot per step and OpenTelemetry spans, and
bakes it into a single self-contained HTML report you can open with no server. An
interrupted run is detectable (its checkpoint says `running`) and resumable from
its trace. This is the debugging story browser agents mostly don't have, and it's
straight out of the crash-reporting / record-replay playbook.

## 4. The model is not a security boundary

Every agentic-browser incident of the last year — Comet and friends — has the same
root cause: an instruction hidden in a web page convinced the model to do something
the user never asked for. You cannot prompt your way out of this, because the thing
being attacked *is* the prompt. The fix is architectural: enforcement has to live in
code the model can't talk its way past.

Stickshaker does two things. It labels page text as untrusted at the structural
level (fenced between markers a page cannot forge) so a hidden instruction
reads as data, not a command — the model-facing half. And it runs every
action through a declarative policy engine (domain allow/deny, origin
scoping, budgets, human-in-the-loop) *before* the action executes — the
enforcing half. On the adversarial eval fixtures (white-on-white text, a fake "assistant
directive" block) the agent answered the real question and ignored the injection
**2/2**. Two patterns and one capable model isn't proof — but the point is that the
defense is a boundary, not a please.

## 5. WebMCP will split the web in two, so the runtime must be hybrid

Chrome's [WebMCP](https://developer.chrome.com/docs/ai/webmcp) origin trial
lets a page expose typed tools to agents directly — `place_order(product,
quantity)` instead of "find the button, click it, fill the form." That's
strictly better when it exists: one typed call instead of a snapshot-act
loop. But most of the web won't have it for years. So a runtime that
bets entirely on either actuation *or* typed tools is wrong. Stickshaker detects
page-provided tools each turn and prefers them, falling back to snapshot+act on the
legacy web — one agent that speaks both dialects. (Page-provided tool descriptions
are themselves untrusted input, which is exactly why point 4 isn't optional.)

## The through-line

None of these are AI insights. They're systems insights — representation, boundary
placement, observability, trust — applied to a place where the industry is still
writing demos. That's the bet: the hard parts of browser agents are a systems
problem, and they reward being treated like one.

*Stickshaker is [open source](../README.md); the benchmarks reproduce with one
command.*
