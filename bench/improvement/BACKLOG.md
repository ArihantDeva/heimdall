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

### 1. ~~Accuracy lane measures fixtures, not live retrieval~~ — DONE (101dae6)
Closed. `bench/improvement/retrieval-lane.mjs` now scores real retrieval through
`embed-index`'s `query()` in a scratch index: mrr 0.889, recall@1 0.889, n=9.
Remaining gap, still open: this is a small synthetic corpus, not the real
knowledge base, so it shows the lane works — not that product retrieval quality
improved. Next real step is reusing `bench/`'s LongMemEval `cycle1` subset (a
frozen comparative corpus with committed runs) through the same lane.

### 2. `depth` probe is still re-paid on every cold start
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

- **A fresh git worktree does not inherit ignore rules or build outputs.** Verified on a detached
  worktree at the combined tree `f76f59a`: `node_modules`, `vendor/graft/build`, and `bench/data` were
  all MISSING, so `verify:improvement` cannot run until they are linked from the primary tree
  (`ln -s <primary>/<path> <worktree>/<path>` for each). The failure is a `FileNotFoundError` on
  `longmemeval_oracle.json` or a module-resolution error, which reads as a broken repo rather than a
  missing symlink. Two independent workers hit this.
- **The baseline is SHA-anchored by design.** `baseline.json` records the commit it was measured at,
  and `commit` is deliberately NOT part of workload identity so a new commit is comparable. Do not
  "fix" a workload-mismatch refusal by re-adding `commit`; that made the gate unable to measure change.
- Test counts and measurements in these notes are point-in-time observations, not invariants.
  Re-measure before quoting: the count moves with every landed test (399 at `196d9ed`, 438 at
  `661eff4`, 446 at `ae11133`; the combined tree with the bloat campaign measures 437).

- Metric contract is fixed; do not redefine a metric to make a candidate pass.
- One bounded change per cycle; profile before optimizing.
- Report every slice, including failures; never cherry-pick.
- Speed claims need paired repetitions on a quiet machine (load average is
  recorded context, and the runner refuses to judge when repeats disagree by
  >1.25×).
- Local commits only; no push, PR, release, or publish.
- Scoped work runs on DeepSeek V4.1 Flash; logic changes get three
  independent-context adversarial reviews before merge.
