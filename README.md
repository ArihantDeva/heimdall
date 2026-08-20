# Heimdall

**Agent memory that beats grep.** A self-healing, verified knowledge layer for
AI coding agents — searchable, ranked, and trustworthy across every project
you've ever touched.

Heimdall is the orchestration + verification layer that sits **on top of** a
semantic memory store. It watches everything your agent does, keeps the memory
graph fresh, and — the part that makes it usable — **labels every search hit
with a trust verdict** so your agent never acts on a dead path or a
hallucinated match.

## Why this exists

Every agent session starts cold. Grep across `~/` can't answer *"did I already
solve X in another project?"* — the answer lives in a different directory,
described in prose, under a path you don't know. A single LLM query
hallucinates or returns one flat hit. The result: **the same work rebuilt three
times.**

Heimdall fixes retrieval, not storage. The insight: agent memory fails not from
lack of storage but from lack of *retrieval with trust*.

## What it does

| Component | File | Job |
|---|---|---|
| **Ranked search** | `bin/kb-search.sh` | top-k ranked candidates + graph walk, `--scope` filter |
| **Trust verification** | `bin/kb_search_verify.py` | every hit gets `STRONG` / `WEAK` / `STALE` / `REBUILT` verdict |
| **Edit-log sync** | `bin/sync-edits.sh` | refresh the graph from agent session edit logs |
| **Self-healing graph** | `extensions/kb-autosync.ts` | hooks agent `tool_result` — edits, moves, deletes, bulk renames all update the graph live |
| **Search guard** | `extensions/kb-search-guard.ts` + `lib/kb-guard-core.mjs` | warns the agent after 3 consecutive grep-style searches without consulting knowledge |
| **Session orientation** | `extensions/kb-orient.ts` | injects relevant prior work into the first prompt of a session |
| **Health & telemetry** | `bin/kb-health.sh`, `bin/telemetry.sh` | daemon health, index freshness, usage stats |
| **Stale pruning** | `bin/kb-stale-scan.py`, `bin/kb-rehome.sh` | dead anchors get rehomed (bounded basename search) or removed |
| **Rebuild** | `bin/kb-rebuild.sh` | full graph rebuild with backup + parallel restore |
| **Seed** | `bin/seed-graft.sh` | load inventory TSV into the store |
| **Semantic-memory backend** | `vendor/graft/` | Graft source (Apache 2.0) — storage + hybrid ranked retrieval |
| **Code-graph layer** | `vendor/graphify/` | per-repo AST+semantic code graph (vendored, MIT) |
| **Agent tools** | `extensions/kb-tools.ts` | exposes `kb_search` / `kb_insert` / `kb_sync` as first-class agent tools |

## The trust verdict (the part nobody builds)

Every search result is verified before it's shown:

- `STRONG` — path exists on disk **and** strong lexical coverage of the query
- `WEAK` — semantic match only (path exists)
- `STALE` — the anchor path is gone → auto-rehome (find where the file moved)
  or auto-remove, so dead anchors stop ranking
- `REBUILT` — stale node found its new home and was rebuilt in place
- `NOPATH` — no path anchored

An agent acting on a dead path is worse than no answer. The verdict layer is
what makes the graph *trustworthy enough to act on*.

## Architecture

```
agent session ──► kb-autosync (watches edits/moves/deletes)
      │                        │
      │                 sqlite refresh (deterministic)
      ▼                        ▼
kb-search ──► kb_search_verify ──► verdicts (STRONG/WEAK/STALE/REBUILT)
      │              ▲
      └── graft explore (graph walk for related work)
```

**Backends are pluggable.** Heimdall talks to any semantic memory store through
a thin CLI contract (`insert`, `retrieve`, `explore`, `get`, `delete`, `stats`).
The reference backend is [Graft](https://github.com/tinygrad/graft) — a
local-first semantic memory daemon (SQLite + embeddings + graph edges).

### Graft attribution

- **Graft** is the semantic memory backend Heimdall was built against and is
  tested with. It provides: hybrid (lexical + vector) ranked retrieval,
  graph edges, keyword dedup, and a local embedding model (bge-m3). All credit
  for the *storage + ranking* engine goes to Graft — we deliberately did **not**
  reimplement a vector store. (Project: [tinygrad/graft](https://github.com/tinygrad/graft),
  local-first, **Apache 2.0**, runs entirely on-device.)
- **Graft's source is vendored** under `vendor/graft/` (Apache 2.0, source +
  headers + CMake, build artifacts and `third_party/` deps excluded — see
  `vendor/graft/VENDORED.md`). Build it per upstream instructions, put
  `graft`/`graftd` on `$PATH`.
- **Heimdall** contributes the *orchestration*: watching agent sessions,
  keeping the graph fresh, verifying every hit, guarding against grep-habit,
  and orienting the agent at session start.
- The Graft binary is **not bundled** in this repo. Heimdall detects it and
  degrades gracefully when it's absent — the scripts error with a clear
  "install the backend" message rather than crashing. Install Graft, point
  `bin/` at it via `$PATH`, done.

### Graphify attribution

- **[Graphify](https://github.com/safishamsi/graphify)** (MIT, © Safi Shamsi)
  is vendored under `vendor/graphify/` as a default component: it provides the
  per-repo code-graph layer (AST + semantic extraction → `graph.json` →
  BFS/DFS query with token budget). All credit for the code-graph extraction
  goes to graphify — we vendored it rather than reimplementing AST parsing.
- It complements Graft (storage) and Heimdall (orchestration): graphify
  answers *codebase* questions, Graft persists *notes/facts*, Heimdall ties
  them together with trust verdicts. See `vendor/graphify/VENDORED.md` for
  usage + update instructions.

## Install

1. Install a backend (currently: [Graft](https://github.com/tinygrad/graft)) so
   `graft` is on `$PATH`.
2. `cp config/heimdall.yaml.example ~/.graft/config.yaml` and adjust paths.
3. `cp launchd/com.graft.daemon.plist ~/Library/LaunchAgents/` (macOS) or run
   the daemon however you like.
4. `bin/seed-graft.sh` to load an inventory TSV, then `bin/sync-edits.sh`.
5. Drop the extensions into your agent harness's extension dir
   (`kb-tools.ts`, `kb-orient.ts`, `kb-autosync.ts`, `kb-search-guard.ts`,
   `lib/kb-guard-core.mjs`).

> **Note:** `bin/telemetry.sh` optionally checks a local goal-verification gate
> script (`.graft-verify.sh`) that lives outside this repo — it degrades to
> `gates=0` when absent. That file is a personal health gate, not part of
> Heimdall.

## Requirements

- `bash`, `python3`, `sqlite3`, `graft` (or any compliant backend)
- The extensions target the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)
  `ExtensionAPI`; the guard-core is pure JS with zero deps and runs anywhere.

## Testing

```bash
npm install          # dev deps (typescript, @types/node, typebox)
npm test             # guard state machine contract (node --test)
npm run typecheck    # tsc --noEmit (via types/pi-coding-agent.d.ts stub)
for f in bin/*.sh; do bash -n "$f"; done
python3 -m py_compile bin/kb_search_verify.py
```

## License

MIT. This is an independent project — not affiliated with Graft or its
authors. Graft remains their work and is attributed above.
