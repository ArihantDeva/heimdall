# Improvement backlog

Ranked, evidence-backed candidates for the next cycles. Each entry states what
would be measured, what evidence exists, and what blocks it. A cycle picks the
top entry it can execute within its authority; a rejected experiment is
recorded here too, with the measurement that rejected it.

Metric definitions, the gate, and the hermetic recipe live in
`docs/superpowers/specs/2026-09-16-continuous-speed-accuracy-evals-design.md`.
Baseline: `bench/improvement/baseline.json`. Gate:
`mise -C /Users/arihantdeva/Repos/heimdall run verify:improvement`.

## Measured so far

| Change | Measurement | Result |
|---|---|---|
| `capability()` python spawns 2 → 1 (commit `196d9ed`) | hyperfine, 20 runs, paired, same session, `depth` on a scratch file | 148.1ms ±10.3 → 114.6ms ±7.4 (−23%); second round 146.0 ±23.4 → 124.9 ±20.0 (−14%). Verdict unchanged (`capability: graph`). |

Rejected: shrinking the probe file (bridge startup dominates: 54.2ms for a 6-line
file vs 62.8ms for 96 lines); porting the extraction bridge to Rust (tree-sitter
cost dominates, not the JS/Python boundary — no profile evidence supports it).

## Candidates

### 1. Accuracy lane measures fixtures, not live retrieval — close this gap first
The accuracy lane currently scores `bench/improvement/fixtures.mjs`, a frozen
labeled set. That proves the scoring arithmetic and gate validity, **not** that
real retrieval has improved. Until it exercises the real retrieval path, no
accuracy claim about Heimdall is supported by this gate.
- Measure: recall@k / nDCG / MRR over a pinned corpus with labels, retrieved
  through the real path (`graft` + `kb-search.sh`, or the embed-index query path
  the insert-probe uses).
- Blocker: the live `graft` daemon is machine-local, and `bench/analysis.md`
  records a CPU-only build crash after ~5 embeds. Start with the scratch-index
  query path (proven portable in `tests/portable-coverage.test.mjs`), which
  needs no daemon.
- Note: `bench/` already has a LongMemEval harness with `cycle1` as a frozen
  comparative subset — reuse it rather than building a second corpus.

### 2. `depth` probe is re-paid on every cold start
`capability()` caches in `_cachedCap`, process-lifetime only. Every CLI
invocation re-runs the probe (measured ~54ms of the ~115ms `depth` call).
- Measure: `depth` p50 with a warm cached capability signal.
- Candidate: the journal already stamps `cap_max` per path; a persisted
  capability record keyed by (python path, root, mtime) could skip the probe.
- Risk: a stale persisted signal silently reports the wrong depth — that is the
  exact class of bug the probe was written to prevent (issue #12). Any cache must
  be invalidated by python/root/vendor changes and must fail closed.

### 3. Shell layer spawns python for work node already does
Audit finding (`/tmp/heimdall-improvement-20260916/deep-simplification.md`, S5):
`bin/kb-search.sh` spawns `python3` up to 6× per search; the path-resolution and
config-read spawns are one-liners that `node -e` or awk could handle in the
caller's process budget. 15 further sites across `telemetry.sh`, `kb-rehome.sh`,
`kb-rebuild.sh`.
- Measure: `search` end-to-end p50 (local-only: needs the daemon).
- Blocker: `search` requires the graft daemon; measure on a controlled machine
  and serialize against benchmark runs.

### 4. Typecheck surface does not cover the product
Audit finding S8: `tsconfig.json` `include` covers `extensions/**` +
`types/**`, so ~200 typed lines are checked while `bin/**` (~3000 lines of
`.mjs`, the actual product) is not. Zero runtime deps is a stated invariant.
- Measure: not a speed/accuracy metric — a verification-coverage gap.
- Candidate: widen `include` to `bin/**/*.mjs` with `allowJs` (already true),
  then fix what it surfaces. Decide deliberately: either widen or document that
  typecheck is extension-only.

### 5. Live-corpus latency for the real product workflow
`kb_search` latency, reconcile/insert throughput, and update time on the real
`~/.graft` + `~/.heimdall` state are unmeasured; the gate only measures `depth`
on a scratch fixture.
- Measure: cold/warm `search` p50/p95 (n≥20), reconcile time for a fixed
  changed-file set (s), insert throughput.
- Blocker: needs the live daemon + isolated state — machine-local, never in CI.

## Deliberately dropped coverage (do not re-add)

From `bin/kb-verify.sh`, judged machine/host-specific rather than behavioral:
the 790k-file index floor, and `graft ask` against a private repo. The three
portable assertions were ported to `tests/portable-coverage.test.mjs`.

## Rules for a cycle

- Metric contract is fixed; do not redefine a metric to make a candidate pass.
- One bounded change per cycle; profile before optimizing.
- Report every slice, including failures; never cherry-pick.
- Speed claims need paired repetitions on a quiet machine (load average is
  recorded context, and the runner refuses to judge when repeats disagree by
  >1.25×).
- Local commits only; no push, PR, release, or publish.
- Scoped work runs on DeepSeek V4.1 Flash; logic changes get three
  independent-context adversarial reviews before merge.
