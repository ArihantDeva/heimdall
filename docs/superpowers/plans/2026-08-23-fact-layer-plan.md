# Heimdall Fact Layer — Implementation Plan (2026-08-23)

Spec: docs/superpowers/specs/2026-08-23-fact-layer-design.md (user-approved).
Baseline: bench/runs/20260823-023236 recall@1=.04 @5=.16 @10=.30 @25=.78.
Constraint: CPU-only extraction; smallest diff reusing level-triggered patterns.

Execution notes:
- Session shell (rtk wrapper) died 2026-08-23 ~08:50Z — ALL commands run inside
  subagent children (dynamic workflows), never in-session bash, until it recovers.
- TDD order strict: RED task precedes its GREEN task; no production test after code.

| Task | Type | Depends | Output |
|------|------|---------|--------|
| B1 Bootstrap gates | mise.toml tasks (test/typecheck/bench-test) + minimal .github/workflows/ci.yml + parity check | — | green local == green CI |
| R1 facts RED | tests/facts.test.mjs failing suite: determinism, secret-skip, dedup, JSONL+plain modes, provenance edges, >512-char title truncate, torn-JSONL tail, empty input | B1 | failing run quoted |
| G1 facts extractor | bin/lib/facts.mjs pure bytes→nodes; ≤200 LOC; ponytail ceilings marked | R1 | RED suite green |
| G2 CLI shim | bin/lib/facts-cli.mjs + tests/cli-contract.test.mjs additions | G1 | contract green |
| G3 sink rendering | renderNode fact branch (sink.mjs) + reconcile wiring test | G1 | ownership/retract green |
| G4 capture + adapters | extensions/prompt-capture.ts; skipPath carve-out (reconcile.mjs, kb-autosync.ts); adapter snippets ×5 harnesses; tests | G3 | hint→node e2e in MemorySink |
| B2 bench ingest --facts | bench/ingest.py flag + bench/tests/test_ingest.py RED first | G2 | pytest green |
| M1 ablation measurement | same 50-question subset, facts off/on, committed runs/ artifacts | B2 | recall table committed |
| M2 retrieval tuning loop | per-type error breakdown → extractor/ranking iterations toward recall@10 ≥ .70 or documented CPU-only ceiling | M1 | evidence or ceiling report |
| V1 adversarial review | fresh-context reviewer over full logic diff; fix findings | G4,B2,M1 | PASS verdict |
| C1 cleanup + release prep | strip debug, README section, version 0.3.0, changelog | V1 | verifyCommand green |
| SHIP push + publish | git push origin main + npm publish (each behind explicit user approval) | C1 | pushed + published |

Ship bar: node --test green, tsc --noEmit clean, bench pytest green, ablation
beats baseline recall@k on identical subset, review passed, artifacts committed.
