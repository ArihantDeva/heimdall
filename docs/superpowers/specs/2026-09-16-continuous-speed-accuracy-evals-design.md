# Continuous speed & accuracy evaluations — design

**Date:** 2026-09-16
**Status:** draft — awaiting user review before implementation (RED).
**Goal contract:** /Users/arihantdeva/.until-done/tasks.yaml (continuous Heimdall improvement; speed + accuracy metrics built first, then maximized).
**Related work:** `docs/superpowers/specs/2026-09-16-maximum-bloat-reduction-design.md` (simplification lane, owned by another session — reused, not duplicated).

## Problem (measured facts at HEAD `4eed256`)

| Fact | Evidence |
|---|---|
| A quality harness already exists and works | `bench/` 1807 LOC Python, 10 test files, 15 recorded runs, `recall.py`, `metrics.py`, `regression_gate.py` |
| **Speed is not measured at all** | `summary.json` keys contain no timing field; child lane confirmed "Speed metrics absent from bench entirely" |
| Ranking metrics are Recall@k only | `bench/recall.py`; no nDCG, no MRR |
| Gate compares point estimates with zero tolerance | `regression_gate.py` `TOLERANCE = 0.0`, no noise model |
| No environment/corpus/repetition record | `summary.json` lacks commit SHA, corpus hash, hardware, cache state, n |
| Real product workflows unmeasured | `kb_search` latency, reconcile/insert throughput, verdict accuracy have no benchmark |
| Long runs currently blocked | `bench/analysis.md`: graft CPU-only build crashes after ~5 embeds |
| Only verdict-correctness unit coverage | `tests/kb-verify.test.mjs` drives `bin/kb_search_verify.py --selftest`; the file is scheduled for deletion by the simplification lane (A1) |
| Only E2E trust fixture | `tests/e2e-fixture.test.mjs` (edit → reconcile → query); its verdict function is an explicit approximation |
| `kb-verify.sh` cannot be a portable gate | hard-coded 790000-file floor and host-specific query text |

## Chosen strategy: eval-first, profile-gated optimization

Build the measurement system first, freeze a baseline, then optimize only where measurement identifies a cause. A rejected experiment is a valid, recorded outcome.

Rejected alternatives:
- **Native-core-first (Rust/C++)** — no profiling evidence; the existing `rs/` workspace is unreferenced, unshipped, machine-locked, and scheduled for deletion. Native ports stay on the table only for a measured hotspot with conformance evidence.
- **Retrieval-quality-only** — ignores half the stated goal (speed) and the product's own trust-verdict claim.

## Metric contract

### Speed (per operation; distributions, never a bare mean)
- cold and warm end-to-end CLI search latency: p50 / p95 / p99, with n
- index/insert throughput on a fixed fixture corpus (nodes/sec)
- reconcile time for a fixed changed-file set (s)
- guardrails: peak RSS, CPU time
- every number recorded with: commit SHA, corpus hash, hardware/OS, cache state, concurrency, repetition count

### Accuracy (held-out; frozen labels)
- recall@k, nDCG@k, MRR on the frozen `cycle1` subset (reuse `bench/run.py --subset cycle1`)
- trust-verdict precision / recall / **false-STRONG rate** on a frozen labeled fixture set, exercised through the real public path
- abstention correctness on unanswerable (`_abs`) questions
- stale / moved / deleted path behavior as labeled cases

Rules: no blended single score; speed and accuracy reported separately and never traded silently; labels are frozen before tuning.

## Gates — single source of truth

`mise -C /Users/arihantdeva/Repos/heimdall run verify:improvement` (mise task, creates: node tests + bench tests + eval validity + regression gate).

Note: the previously locked contract spelling `mise exec -- cd <repo> && …` is **broken** (it ran npm in `/Users/arihantdeva`, `Missing script: "verify:improvement"`). The contract has been re-locked with the corrected, verified spelling `mise -C <repo> run verify:improvement` (`mise -C … exec -- pwd` → repo path).

### Verified hermetic recipe (bootstrap evidence, 2026-09-16)

Scratch-HOME isolation works and is the pattern to reuse:

```
HOME="$SCRATCH" HEIMDALL_PYTHON=/Users/arihantdeva/.heimdall/venv/bin/python3 \
  node bin/heimdall.js depth "$SCRATCH/proj/a.mjs"
# → capability: graph (tree-sitter + graphify extractors available)
```

Two verified facts this depends on:
1. `HOME=<temp>` redirects every state path (`~/.heimdall/{config.json,journal.db,lock,hints.jsonl}`, `homelab` facts dir) — no live state is touched (`node bin/heimdall.js depth …` left the live journal unchanged).
2. `HEIMDALL_PYTHON` **must be absolute**. Under a scratch HOME the candidate list `[HEIMDALL_PYTHON, homedir()/.heimdall/venv/bin/python3, python3]` resolves the venv path into the scratch dir, so a relative/`$HOME`-expanded value silently degrades to `capability: file` (L2/L3 unavailable). CI does the same thing with `HEIMDALL_PYTHON="$RUNNER_TEMP/ts-py/bin/python3"`.

Existing scratch-HOME precedent to follow: `tests/init-e2e.test.mjs` (mkdtemp HOME → spawn CLI with `env: {...process.env, HOME: home}` → assert → rmSync).

### CI parity

`.github/workflows/ci.yml` runs `npm test` + `npm run typecheck` on macOS and Linux, installs tree-sitter python, sets `HEIMDALL_NO_BUILD=1`, and deliberately has no bench job (needs local graft daemon + `~/.heimdall`). Consequence: the new speed benchmark cannot run in CI; CI gets deterministic **correctness/validity** gates only, with the performance lane documented as local-controlled-machine.

## Workflow lanes

1. **Evaluation lane (this session).** Extends `bench/`; new portable fixtures under `bench/improvement/**` and `tests/improvement-eval.test.mjs` (paths reserved with the simplification session). Delivers the portable verdict/insert-search coverage that replaces `kb-verify.sh`'s host-specific assertions and unblocks the simplification lane's A1/B3 deletions.
2. **Simplification lane (other session, `01a0aa44`).** Bloat campaign (deletions, dedup, hotspot work). Reused, not duplicated; merges stay eval-gated.
3. **Optimization lane.** Profile → one bounded change → paired measurement vs frozen baseline → accept or reject. Order determined by evidence, not preference.

## Continuation mechanism

Back-to-back cycles while Pi runs (user-chosen; no periodic timer). Local commits only — no push, PR, release, or publish. Scoped work on DeepSeek V4.1 Flash only (user-chosen, no fallback). Durable checkpoint: `.until-done/tasks.yaml` + raw artifacts under `/tmp/heimdall-improvement-20260916/` + kb memory entries.

A cycle is: pick the top executable entry from `bench/improvement/BACKLOG.md` → profile → RED test → smallest change → measure against the frozen baseline → three independent adversarial reviews → local commit. A rejected experiment is recorded in BACKLOG.md with the measurement that rejected it. The backlog is the durable handoff: a future cycle starts there, not from memory of this one.

Known limits of the mechanism, stated rather than implied: cycles run only while Pi runs (no daemon; nothing happens while the host sleeps), and the gate refuses to make speed claims on a loaded machine, so a busy host produces no speed progress — only accuracy and simplification progress.

## What was actually measured (2026-09-16)

| Claim | Evidence |
|---|---|
| Accuracy lane measures real retrieval | `mrr 0.889, recall@1 0.889, n=9` through `embed-index`'s `query()` in a scratch index (was `0.450` scoring literals) |
| The accuracy lane can fail | validity test degrades the corpus and requires recall@1 `< 0.5`; it initially FAILED at 0.889 because ranking rode on descriptive filenames, which is how the `doc-NN.md` naming rule was found |
| Speed improvement | capability() 2 python spawns → 1; paired hyperfine 148.1±10.3 → 114.6±7.4ms and 146.0±23.4 → 124.9±20.0ms |
| Gate fails on degradation | exit 1 on degraded accuracy, degraded speed, workload mismatch, malformed artifacts, and noisy measurements; exit 0 on 3/3 consecutive clean runs |
| Gate can compare across commits | fixed after review found `commit` in workload identity made every cross-commit comparison refuse |

Not measured, and therefore not claimed: product retrieval quality on a real corpus (the lane proves a small scratch corpus is retrievable), any live-workflow latency (`kb_search`, reconcile, insert throughput), and any native-port benefit.

## Risks and rollback

- Vendor `vendor/graft` FTS levers (from `bench/analysis.md`) change vendored code and interact with config keys (`rrf_k_const`, fused-gate thresholds) — requires its own approval, not part of this design's scope.
- Graft CPU-only daemon crash blocks long runs; short-fixture evals must not depend on it.
- Machine noise: performance comparisons only within one controlled machine, identical fixture and cache state. The gate enforces this by refusing to judge when repeats disagree by >1.25x (p50 and p95 checked separately).
- Rollback: per-lane commits, no remote writes, revert via git.

## Resolved during implementation

1. ~~User runs `/until-done cancel`, then contract re-locks with the corrected verifyCommand.~~ Done — re-locked as `mise -C /Users/arihantdeva/Repos/heimdall run verify:improvement`.
2. User reviewed and approved the eval-first approach.
3. First optimization landed (capability probe); next candidates ranked in `bench/improvement/BACKLOG.md`.
