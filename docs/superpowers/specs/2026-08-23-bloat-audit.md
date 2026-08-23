# Bloat Audit — heimdall repo (2026-08-23, cycle 1)

Method: dead-export scan (every `export` in bin/lib/*.mjs grep-checked against
all bin/, extensions/, tests/ sources), TODO/FIXME sweep, dependency-use
check, docs-drift spot check. Subagent audit attempt failed twice (model
produced no output); replaced with this deterministic scan.

## Findings

| # | Location | What | Evidence | Action |
|---|---|---|---|---|
| F1 | bin/lib/depth.mjs:23 | `VENDOR_GRAPHIFY` export never referenced outside its own file | grep: only definition line | DELETE export (keep as local if bridge needs it — it doesn't; BRIDGE path is separate) |
| F2 | bin/lib/extract.mjs:18 | `hashFile()` export never called anywhere | grep: zero call sites | DELETE function (~5 LOC) |
| F3 | bin/kb-search-guard.ts | deployed copy is `.disabled-broken-dep` in ~/.pi/agent/extensions — extension is broken in production | symlink dir listing | KEEP code but record status; not dead, disabled pending dep fix |
| F4 | README.md:115-116 | commented-out demo GIF block + empty assets/ dir | ls assets = empty | KEEP (documented intent, harmless) — or delete; low value |
| F5 | package.json files[] | lists `types/` `vendor/` `config/` — all exist | ls | OK |
| F6 | devDependencies.typebox | used by extensions/kb-tools.ts only | import at kb-tools.ts:11 | KEEP (runtime dep of shipped extension) |

## Structural law check (≤200 LOC/file)

All files pass except:
- bin/lib/journal.mjs: 342 LOC (**over limit**) — split candidate: dedup queue
  + generations into journal-helpers.mjs
- bin/lib/cli-main.mjs: 279 LOC (**over limit**) — split candidate: command
  implementations → cli-cmds.mjs
- bin/lib/reconcile.mjs: 231 LOC (**over limit**, marginal) — extract the
  unchanged-hot-path block

Total immediately removable: ~10 LOC (F1, F2). Real bloat is file-size debt:
~250 LOC over the structural cap across three files.

## Non-findings (checked, clean)
- No TODO/FIXME markers in bin/ or extensions/.
- Zero runtime dependencies in package.json (promise holds).
- All bench/*.py modules referenced by run.py or tests.
