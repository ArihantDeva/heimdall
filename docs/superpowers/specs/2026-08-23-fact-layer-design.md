# Heimdall Fact Layer — Design Spec (2026-08-23)

Status: DRAFT — awaiting user approval before implementation.
Baseline evidence: `bench/runs/20260823-023236/summary.json` — LongMemEval-S,
50 questions, recall@1=0.04 @5=0.16 @10=0.30 @25=0.78 (single-session-user).
Failure mode measured: retrieval cannot see *what was said*, only where files are.

## Problem

Heimdall indexes files/symbols/notes. User prompts ("I use SQLite", "my API is
at X", "prefer tabs") never enter the graph, so conversational-memory questions
have no indexed evidence. LongMemEval retrieval sits near floor.

## Goals / Non-goals

Goals:
1. Capture every user prompt from all five supported harnesses.
2. Index atomic facts as first-class graph nodes with provenance.
3. Prove lift on the identical 50-question bench subset (ablation: facts off/on).
4. Ship to GitHub main + npm with version bump.

Non-goals (this round): LLM-based extraction (user decision: CPU-only),
entity resolution across documents, temporal reasoning, fact supersede/conflict
resolution beyond co-existence with provenance.

## Decisions

| # | Decision | Rejected alternative | Why |
|---|----------|---------------------|-----|
| D1 | Facts enter via the existing level-triggered reconciler: prompt log is just another watched file | Separate fact store + side index | Second consistency surface duplicates graft; breaks journal-authoritative doctrine |
| D2 | CPU-only heuristic extraction, pure function of bytes | LLM at capture time; whole-prompt nodes | User decision (token promise); whole-prompt bloats graph with noise |
| D3 | One extractor implementation (JS, `bin/lib/facts.mjs`); bench consumes it via a thin CLI shim | Reimplementing patterns in Python for bench | Two implementations drift |
| D4 | Per-path fact ownership (fact ids namespaced by source-file hash) | Global fact dedup | Breaks exact retraction when a file changes/deletes |
| D5 | Secrets hard-skipped at extraction (regex classes) | Configurable filtering | Trust boundary, not preference |

## Architecture

```
harness hook (5 adapters) ──append──▶ ~/.heimdall/prompts/<project-hash>.jsonl
                                              │ (hinted like any file)
                                              ▼
                              reconciler: desiredState(path, depth)
                                              │
                                    facts.mjs extractFacts(bytes)
                              pure: bytes → [{id,title,body,keywords,edges}]
                                              │
                                     journal.commit → sink (graft)
```

Components (all follow structural constraints: ≤200 LOC/file, ≤30 LOC/construct):

1. **Capture** — `extensions/prompt-capture.ts` (pi) appends
   `{"at":iso,"cwd":"…","text":"…"}` per user prompt to
   `~/.heimdall/prompts/<sha12(cwd)>.jsonl`, then hints the path.
   Adapter templates (adapters.mjs / docs/adapters.md) gain the equivalent
   snippet for claude-code/codex/cursor/windsurf.
2. **skipPath carve-out** — reconcile.mjs + kb-autosync.ts currently exclude
   `${HOME}/.*`; add explicit allow for `${HOME}/.heimdall/prompts/`.
3. **Extraction** — `bin/lib/facts.mjs`: ordered pattern set over utterances
   (first-person assertions, preferences always/never/favorite/prefer,
   declarations "X is Y" containing a named entity, negations). Output per
   fact: normalized title (≤120 chars), body = verbatim utterance +
   `path:line` provenance, keywords = [heimdall, fact, kind, …entities].
   Input modes: JSONL prompt logs and plain text/markdown (bench windows);
   torn/non-JSON final line skipped. Secret-shaped strings skipped (D5):
   sk-/ghp_/AKIA/bearer/password=/≥20-char hex/base64 classes.
4. **Sink rendering** — extend `renderNode` with `kind:"fact"` branch.
5. **Bench CLI shim** — `bin/lib/facts-cli.mjs --file F` prints JSON fact
   array; `bench/ingest.py --facts` calls it per session window and inserts
   fact nodes (same BENCH_MARKER, isolated longmemeval profile).
6. **Retrieval** — unchanged; graft already ranks titles/bodies/keywords.

## Edge cases (explicit)

Empty prompt · whitespace-only · >512-char sentence (truncate title, full
verbatim in body) · duplicate fact within one file (dedup by normalized hash) ·
same fact across files (two nodes, D4) · contradictions (both stored) ·
secrets (skipped, counted) · torn JSONL tail (skipped) · empty file (no nodes)
· file deleted (retract owned fact nodes) · unicode/NFKC normalize ·
non-English (no match → zero facts, acceptable) · concurrent writers
(level-triggered: safe by construction) · prompt-injection text (stored inertly
as data, never executed).

## Bench methodology

Same 50-question subset (`longmemeval_s.json`), same isolated profile, same
reader/judge settings as baseline run. Two passes: `--facts off` (reproduces
baseline ≈) and `--facts on`. Committed artifacts under `bench/runs/<id>/`.
Success trajectory (user bar): iterate extraction/retrieval tuning until
recall@10 ≥ 0.70 or CPU-only ceiling reached and reported honestly.

## Known ceilings (deliberate, ponytail-marked)

Cross-path duplication (D4) · English-pattern recall bound · no conflict
resolution. Upgrade paths noted inline in code comments.

## Test strategy

RED first, per component:
- `tests/facts.test.mjs`: determinism (same bytes ⇒ same node set), secret
  skip, dedup, JSONL + plain modes, provenance edges, idempotent re-reconcile.
- `tests/edge-matrix.test.mjs` additions: cases above.
- `tests/cli-contract.test.mjs`: facts-cli output contract.
- `bench/tests/test_ingest.py`: `--facts` inserts expected fact-node count,
  marker present, purge removes them.
- Gates: `npm test && npm run typecheck` + `pytest bench/tests`.

## Bootstrap gaps found during analysis (must precede RED)

- No `.github/workflows/` in repo → minimal Agentic Workflow required.
- No `mise.toml` → add tasks mirroring test/typecheck gates.
