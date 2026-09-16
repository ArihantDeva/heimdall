# Heimdall maximum bloat-reduction design

**Date:** 2026-09-16
**Status:** approved — all sections authorized by the user on 2026-09-16. Facts and choices below are settled; the implementing session must not re-explore or redesign them.

## Problem and baseline

Heimdall has accumulated dead/private code, dormant-but-documented capabilities, generated tracked data, orphan assets and generators, duplicated guard logic, and oversized maintained hotspots.

Baseline measured by three independent read-only explorers (`chain/deepseek-v4.1-flash`) at base `e35acbbea58bf96073320743bd669e9c43a9b562`:

| Measure | Value |
|---|---|
| Tracked files | 326 |
| Tracked bytes | 7,880,901 |
| Reported tracked lines | 88,702 |
| Tracked lines excluding vendor, generated model data, lockfiles | 25,853 |
| Handwritten source lines | ≈10.9k |
| Runtime dependencies | 0 |
| Dev dependencies | 4 |
| Node tests | 374, all green |

`npm test` and `npm run typecheck` are the canonical CI gates. Local disk-only caches (`bench/runs`, `bench/data`, `target`, vendored builds/models) are excluded from repository reduction claims.

## Chosen strategy

Maximal evidence-backed deletion. Delete the largest proven-unused slice first, gated by final caller/package/dynamic/template checks. Pure dead-code deletion requires caller proof, not invented tests. Any behavior-affecting simplification gets a minimal characterization test first. Selection order: delete > existing helper > stdlib/native > installed dependency > minimum new code. No wholesale rewrite, no split-by-file-size work.

## In scope

- Dead execution path in `bin/kb_search_verify.py`, retaining live `extract_paths`, plus tests that exclusively cover the dead behavior.
- Dead exports/imports in `bin/lib/enforcement-rules.mjs`, the empty statement in `facts-cli.mjs`, and other zero-caller private internals confirmed by final checks.
- Documented but zero-runtime-caller dormant capabilities explicitly approved by the user: the Rust search/embed workspace and its exclusive tracked generated model artifacts, manifests, and docs; the parked agent tier (`tier.mjs`, `agent-memory.mjs`, their exclusive tests/docs); manual zero-caller `kb-verify.sh`. Removed capabilities get no compatibility shim.
- Dangling machine-specific `kernels` symlink.
- Zero-reader render generators, orphan generated images/video, obsolete examples, and stale docs/manifest exclusions made unnecessary by the deletions.
- Guard implementation duplication — only if current tool vocabulary, escalation, and reset behavior is characterized and preserved.
- Oversized maintained hotspots (`setup.mjs`, `cli-main.mjs`, `journal.mjs`, `kb-search.sh`, `graft-build.mjs`, `adapters.mjs`, `reconcile.mjs`) — only where caller-mapped change is demonstrably net-negative in maintained LOC and preserves semantics.
- Package, ignore, and docs reconciliation forced by the approved deletions.

## Out of scope

- Deleting ignored local caches, benchmark runs/data, build outputs, or other user data.
- Selective pruning of `vendor/graft` or `vendor/graphify`; both remain live and distribution-sensitive.
- Deleting live `assets/demo.gif`.
- Treating template-emitted `HeimdallPlugin` text as dead code.
- Rewrites, speculative abstractions, dependency additions, or file splitting merely to hit an LOC cap.
- Push, merge, release, publish, deployed config changes, history rewrites, destructive cleanup.

## Invariants

Preserve active CLI, setup/install, search and trust-verdict behavior, hook/guard behavior, journal/reconciliation semantics, package output, security, data safety, crash safety, atomic-write/locking/order semantics, public file formats, and documented public interfaces not explicitly approved for deletion. Any newly discovered live consumer blocks that deletion and triggers replan.

## Execution model

The parent reasoning model owns judgment and integration. All scoped exploration, implementation, testing/debugging, and review run on `chain/deepseek-v4.1-flash`. One writer per managed isolated worktree; independent lanes run concurrently and merge only after focused checks. Recheck base SHA and active sessions before writing — HEAD moved during initial exploration. Never use the stale dirty worktree `heimdall-c11`.

Execution lanes:

1. Unquestionably dead internals.
2. Approved dormant capabilities.
3. Behavior-preserving deduplication.
4. Caller-mapped hotspot simplification.
5. Package/generated/docs cleanup.
6. Integration and review.

Writers touching the same files or manifests must not run in parallel.

## TDD and verification

Behavior changes: RED via the smallest characterization test with the intended failure recorded; GREEN via the minimum change; REFACTOR only while green. Deletion of unreachable code/artifacts: re-run caller/package scans at the current SHA, delete, then rely on existing focused/full tests.

Every lane runs its relevant focused tests plus `git diff --check`. Integration runs `npm pack --dry-run`, `npm test`, and `npm run typecheck`; implicated Python/benchmark tests run when their files change.

Three fresh independent adversarial review passes (`chain/deepseek-v4.1-flash`) receive raw repository/diff/test evidence only — never another reviewer's verdict or reasoning. Completion requires zero open high-severity findings.

## Metrics

Use identical before/after commands and identical git-tracked boundaries. Report, with maintained and generated/vendor/local-disk measures kept separate:

- maintained handwritten LOC,
- tests LOC (separate),
- generated text lines,
- vendored lines,
- tracked files,
- tracked bytes,
- dependency counts,
- npm package contents and bytes,
- deletions by lane.

Never count ignored local-disk cleanup as a repository improvement. Never present tentative estimates as final numbers.

## Risks and rollback

Risks: hidden dynamic or manual consumers; packaging omissions; differing guard tool vocabularies; loss of intended future capability; shared-state journal regressions; concurrent branch movement.

Controls: final whole-repo callers/dynamic/template/package checks; characterization tests; isolated lane commits; focused and full test runs; `npm pack` inspection; three review passes; commit-level rollback.

If proof is weak, skip the candidate and report it rather than forcing an LOC target.

## Ask-before gates

Ask before:

- deleting any newly discovered public/documented capability outside the user-approved Rust / tier / `kb-verify.sh` groups,
- deleting untracked files or user data,
- deployed machine or config changes,
- push, merge, release, or publish,
- destructive history operations.

## Success criteria

- Every source/test/script/config/generated/dependency domain audited.
- All approved high-confidence cuts landed with net-negative maintained LOC.
- Final adversarial audit finds no unjustified dependency, dead path, duplicate owner, or layer.
- Before/after report is reproducible and separates maintained / generated / vendor / local-disk measures.
- Public behavior and invariants pass focused journeys, `npm pack` inspection, `npm test`, and `npm run typecheck`.
- Three independent review passes leave zero open high-severity findings.

## Self-review checklist

- No TBD/TODO/placeholders.
- No contradiction between maximal deletion and the invariants.
- Exact in/out scope.
- No promise to delete a candidate whose final caller check fails.
- No local-cache bytes counted.
- No implementation code changes in this task.
