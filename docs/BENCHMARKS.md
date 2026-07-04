# Benchmarks

Reproducible measurements of what Stickshaker's design actually buys — claims
backed by numbers you can regenerate with one command.

> Status: first result. A single task is enough to establish the
> mechanism; the full multi-task matrix (success rate, latency, cloud vs. local,
> injection-block rate) comes later with the eval harness.

## Incremental diffs vs. full snapshots

**Claim:** sending per-step *deltas* plus eliding stale observations from history
uses materially fewer input tokens than re-sending a full page snapshot every
turn (the naive full-snapshot baseline), at the same task outcome.

**How it's measured.** The `bench` command runs the identical task twice through
the same agent loop — once in `full` mode (a complete snapshot every turn, full
history retained) and once in `diff` mode (keyframe on step 1 / after navigation
/ every 5 steps, deltas in between, older observations collapsed to placeholders).
Input/output tokens come straight from the Anthropic API `usage` fields. Neither
mode uses prompt caching, so the comparison is apples-to-apples on raw tokens.

**Task.** Fill a text field, choose a dropdown option, type into a second field,
submit the form, and report the confirmation — three same-page actions followed
by a navigation. Model: `claude-sonnet-5`.

```
mode   steps   input-tok   output-tok      cost  status
full      5       15882         337   $0.0527  done
diff      5       12242         380   $0.0424  done

diff vs full: 22.9% fewer input tokens, 19.5% lower cost.
```

Both modes produced the correct confirmation message in the same number of steps.

**Reproduce:**

```bash
pnpm stickshaker bench \
  "Fill the first text field with 'Stickshaker', choose 'Two' in the dropdown select menu, type 'hello' into the 'Type to search' field, then click Submit and report the confirmation message shown." \
  --url https://www.selenium.dev/selenium/web/web-form.html \
  --model claude-sonnet-5
```

### Reading the result

The per-observation shrink is larger than the run-level number: on same-page
diff steps the observation was ~410–430 characters versus ~1120–1130 for the
full snapshot — about **63% smaller**. The run-level figure is lower (22.9%)
because system prompt, tool schemas, the task message, and the assistant turns
are fixed overhead, and one turn (the post-submit page) is a keyframe.

The gap **widens with task length.** The stateless API re-sends the whole
conversation each call, so full mode's cost grows roughly with the square of the
step count (every past full snapshot is re-sent on every later turn), while diff
mode's retained context stays bounded by the keyframe interval. A five-step task
is the shallow end of that curve.

### When diff mode helps — and when it doesn't

Diff mode only diverges from the baseline once it sends a **delta**, which never
happens on the first step (always a keyframe) or on a step that navigates
(navigation forces a keyframe). So:

- **No benefit:** single-step tasks (e.g. "read the top headline") and tasks that
  navigate on every step — every observation is a full keyframe in both modes, so
  the token counts are identical. `bench` now prints a `deltas` column and warns
  when diff mode sent zero deltas, so a degenerate comparison is obvious.
- **Benefit grows with same-page depth:** the more consecutive actions the agent
  takes on one page (form filling, filtering, pagination, expanding sections), the
  more full snapshots get replaced by small deltas and the more history elision
  saves. The form-fill task above (3 same-page actions) is a modest case.

Because each mode is run once, short tasks are also dominated by model
nondeterminism (a mode that happens to take one extra step swamps the encoding
difference). Averaging over repeated trials is what the eval harness below adds.

### Caveats (honest scope)

- **One task, one model.** Establishes the mechanism, not a distribution. The
  eval harness below runs a fixture suite across models and snapshot modes.
- **Success is operator-verified here**, not automated. Automated success grading
  arrives with the eval harness below.
- **No prompt caching in either mode.** Caching would cut full mode's re-sent
  history to ~0.1× on cache reads, narrowing the cost gap — but caching has a
  5-minute TTL (lost across human-in-the-loop gaps) and history elision mutates
  the prefix, which defeats caching. Reconciling elision with caching is a real
  tension tracked for later; measuring raw tokens keeps this result clean.
