# Heimdall

**Your agent keeps rebuilding work you already did. Heimdall makes it stop.**

Every AI coding session starts cold. Grep across your repos can't answer *"did
I already solve this in another project?"* — the answer lives in a different
directory, described in prose, under a path you've never opened. The result:
**the same work rebuilt three times.**

Heimdall is a self-healing, **trust-verified knowledge layer** for AI coding
agents. It watches what your agent does, keeps a semantic memory graph fresh
across every project you touch, and — the part nobody else builds — **labels
every search hit with a trust verdict** so your agent never acts on a dead
path or a hallucinated match.

## The trust verdict (the differentiator)

Every search result is verified against reality before your agent sees it:

- `STRONG` — path exists on disk, strong lexical coverage, **and** the file's
  actual content answers the query (content-aware scoring)
- `WEAK` — semantic match only; plausible but unverified
- `REBUILT` — file moved; Heimdall found it and re-anchored automatically
- `STALE` / `REMOVED` — dead path, logged and pruned so it stops ranking

An agent acting on a dead path is worse than no answer. Verdicts are what make
the graph trustworthy enough to act on.

## Self-healing under concurrent agents

Forty agents can edit one file at once. The graph still converges to exactly
what is on disk, because Heimdall never tries to infer *what changed*.

- **Level-triggered, not event-driven.** A hook, a watcher, or a script can
  only say "look at this path". It is never believed about *what* happened.
  The reconciler reads the file from disk and makes the graph match it. A
  missed hint, a duplicated hint, or a flatly wrong hint costs one `stat`.
- **Single writer by construction.** Every graph mutation goes through one
  `O_EXCL` lock. Two writers cannot exist, so there is no interleaving to
  race — the old delete-then-insert window where a file briefly vanished from
  the graph is gone.
- **Exact ownership.** Every node and edge belongs to exactly one path. A
  commit deletes and re-inserts all of that path's rows in one transaction, so
  a symbol you deleted cannot survive as a ghost.
- **Content hash is the oracle.** Same bytes, same depth ⇒ same graph. That is
  what makes reconciling twice identical to reconciling once, and it is why
  concurrent edits are harmless rather than merely unlikely to collide.
- **Order independence.** A cross-file edge to a symbol that is not indexed yet
  parks as a pending edge and resolves from either side, so the final graph
  does not depend on which file was reconciled first.
- **Audit as backstop.** `heimdall verify` compares the journal against the
  filesystem and exits non-zero on drift — it is the accuracy claim as a
  command you can put in CI. `--deep` re-hashes and catches even a rewrite that
  preserved size and mtime.

The honest guarantee is **bounded-staleness convergence**, not instantaneous
correctness: between an edit and the next reconcile pass, the graph is behind.
It is never *wrong* in a way that survives a pass.

```bash
heimdall daemon              # the single writer: watch, reconcile, audit on a timer
heimdall reconcile           # converge now (one-shot; takes the same lock)
heimdall reconcile --all     # deep audit + repair everything
heimdall verify --deep       # read-only drift report; exit 1 if any. CI-safe
```

## Depth levels

Nodes are indexed at a depth. The default and the recommendation is **maximum**
— the graph knows not just that a file exists but which functions and classes
live in it, at which lines, and what calls what.

| Depth | Node knows |
|---|---|
| `path` | the file exists |
| `file` | + name, language, size |
| `symbol` | + every function/class/method and its line number |
| `graph` | + the edges between them, within and across files |

`max` resolves to whatever the machine can actually do. Symbol and graph depth
need tree-sitter; without it a path degrades to `file` depth rather than
disappearing, and the next audit upgrades it automatically once tree-sitter
appears. Asking for a depth above the machine's capability is honored as far as
possible and reported as `clamped`.

```bash
heimdall depth                       # what this machine can do, and why
heimdall depth src/server.ts         # requested vs effective depth for one path
```

Extraction is tree-sitter AST parsing, not an LLM call: depth costs CPU, never
tokens.

## Quickstart

```bash
npm i -g heimdall

# one-time: install the graft backend (local semantic-memory daemon)
#   see https://github.com/tinygrad/graft — put the `graft` binary on PATH
#   (e.g. ~/.local/bin/graft) and create ~/.graft/config.yaml:
#   cp "$(npm root -g)/heimdall/config/heimdall.yaml.example" ~/.graft/config.yaml

# wire it into your harness (pi | claude-code | codex | cursor | windsurf | all)
heimdall init --harness claude-code

# verify the backend is healthy
heimdall doctor

# search across every project you've worked in
heimdall search "excel tracker portfolio optimization"

# record reusable work when your agent finishes something
heimdall insert --title "poker jam_opt optimizer" \
  --body "~/Repos/poker-bot/tools — heads-up jam/fold EV optimizer" \
  --keywords poker,optimize
```

`init`, `insert` and the harness wiring work immediately; `search` and
`doctor` need the graft backend installed separately (build from source —
embedding model download included, so not instant). The vendored `vendor/graft/`
is source + attribution, not a prebuilt binary.

## Works with your harness

| Harness | Command | Integration |
|---|---|---|
| **Pi** | `heimdall init --harness pi` | native extensions: `kb_search`/`kb_insert`/`kb_sync` tools, edit autosync, session orientation |
| **Claude Code** | `heimdall init --harness claude-code` | PostToolUse hook emits path hints + memory snippet |
| **Codex CLI** | `heimdall init --harness codex` | `AGENTS.md` search/insert instructions |
| **Cursor** | `heimdall init --harness cursor` | rules file with search-first workflow |
| **Windsurf** | `heimdall init --harness windsurf` | rules file with search-first workflow |

See [docs/adapters.md](docs/adapters.md) for what each adapter installs.

## What it does

| Component | File | Job |
|---|---|---|
| **CLI** | `bin/heimdall.js` | `init` / `search` / `insert` / `doctor` / `daemon` / `reconcile` / `verify` / `depth` / `hint` |
| **Ranked search** | `bin/kb-search.sh` | top-k ranked candidates + graph walk, `--scope` filter |
| **Trust verification** | `bin/kb_search_verify.py` | content-aware `STRONG`/`WEAK`/`STALE`/`REBUILT` verdicts |
| **Reconciler** | `bin/lib/reconcile.mjs` | level-triggered convergence: read disk, make the graph match |
| **Journal** | `bin/lib/journal.mjs` | authoritative index: ownership, hashes, generations, dedup queue |
| **Single-writer lock** | `bin/lib/lock.mjs` | `O_EXCL` lock every graph mutation passes through |
| **Depth ladder** | `bin/lib/depth.mjs`, `bin/lib/extract.mjs` | `path`/`file`/`symbol`/`graph`; tree-sitter extraction |
| **Daemon** | `bin/heimdall-reconciler.mjs` | watch + drain + periodic audit, holding the lock |
| **Edit-log replay** | `bin/sync-edits.sh` | one-shot bootstrap: session edit logs → hints → reconcile |
| **Hint emitter** | `extensions/kb-autosync.ts` | harness hook; appends "look at this path", never writes the graph |
| **Search guard** | `extensions/kb-search-guard.ts` | warns the agent after 3 grep-style searches without consulting memory |
| **Session orientation** | `extensions/kb-orient.ts` | injects relevant prior work into the first prompt of a session |
| **Health & telemetry** | `bin/kb-health.sh`, `bin/telemetry.sh` | daemon health, index freshness, usage stats |
| **Stale pruning** | `bin/kb-stale-scan.py`, `bin/kb-rehome.sh` | dead anchors get rehomed or removed |
| **Backend** | `vendor/graft/` | Graft (Apache 2.0) — local-first semantic memory daemon |

## Architecture

```
agent harness (Pi / Claude Code / Codex / Cursor / Windsurf)
        │  hooks + tools
        ▼
Heimdall orchestration ── trust verification ── self-healing sync
        │ thin CLI contract (insert/retrieve/explore/get/delete/stats)
        ▼
semantic memory backend (Graft, vendored)
```

**Backends are pluggable.** Any store speaking the CLI contract works; Graft is
the vendored reference.

## Requirements

- Node ≥ 22.5 (the journal uses the built-in `node:sqlite`), `bash`, `python3`
- macOS today (launchd daemon management); Linux works with a manual daemon
- Optional, for `symbol`/`graph` depth: tree-sitter and the grammars for the
  languages you care about. Any Python 3 with them importable will do:
  ```bash
  python3 -m venv ~/.heimdall/venv
  ~/.heimdall/venv/bin/pip install tree-sitter tree-sitter-python \
    tree-sitter-javascript tree-sitter-typescript tree-sitter-go tree-sitter-rust
  ```
  Run `heimdall depth` to see what the machine resolved `max` to. Without them
  everything still indexes, at `file` depth.

## Testing

```bash
npm test          # 41 tests: CLI, adapters, trust verdicts, guard, plus the
                  # reconciler invariants — 40 interleaved writers and 6 real
                  # child processes against one file, idempotency, ABA/stale
                  # commits, ownership retraction, order independence,
                  # depth resolution, drift detect+repair, lock exclusivity
npx tsc --noEmit  # typecheck
```

The concurrency tests are the point: if the single-writer or idempotency
properties ever break, those are the tests that go red.

## Status

v0.2.0 — adds the reconciler: a single-writer, level-triggered convergence
loop with a content-hash oracle, exact per-path ownership, and a depth ladder
that indexes symbols and call edges by line. Replaces the previous design,
where hooks inferred changes from commands and wrote the graph directly from
several processes at once.

v0.1.0 shipped the packaged CLI, five harness adapters, content-aware trust
verdicts, and a fresh-install-verified quickstart. Backend (Graft) is a
separate install — see Quickstart.

## License

MIT. Independent project — not affiliated with Graft or its authors.

### Attribution

- **[Graft](https://github.com/tinygrad/graft)** (Apache 2.0) — vendored as the
  default semantic-memory backend (`vendor/graft/`).
- **[Graphify](https://github.com/safishamsi/graphify)** (MIT, © Safi Shamsi) —
  vendored per-repo AST+semantic code graph (`vendor/graphify/`).
