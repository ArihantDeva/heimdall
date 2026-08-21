# Convergent reconciler + depth ladder

**Date:** 2026-08-20
**Status:** approved, implementing
**Supersedes:** the edge-triggered healing path — command inference in
`extensions/kb-autosync.ts`, and direct-to-graft mutation in `bin/sync-edits.sh`
and `bin/kb-stale-scan.py` (both retained as one-shot bootstrap, rewired through
the journal)

## Problem

Heimdall's graph can disagree with the filesystem, and today nothing detects it.
Three independent failure classes:

**1. No writer serialization.** Every mutation is a non-atomic
`SELECT ids -> graft delete -> graft insert`:

- `bin/sync-edits.sh:105-116`
- `extensions/kb-autosync.ts:212-219` (`refresh`)
- `extensions/kb-autosync.ts:298-301` (`bulkRewrite`, per node)

Two processes running that on one path interleave into two duplicate nodes (both
SELECT the same set, both delete, both insert), or — inside the delete window —
a search that returns nothing for a file that exists. There is no lock, no
transaction, no idempotency key. `bin/kb-stale-scan.py:104` deletes concurrently
with all of it.

**2. Per-process debounce.** `extensions/kb-autosync.ts:353-358` keeps timers in
an in-memory `Map`. N agent processes means N independent debouncers and zero
cross-process coalescing, so many agents editing one file is the *worst* case:
N concurrent delete+insert storms on one path, which is exactly the race in (1).
The inventory-TSV guard (`kb-autosync.ts:205-208`, `sync-edits.sh:97-99`) is a
grep-then-append TOCTOU that duplicates rows under the same pressure.

**3. Inference has permanent blind spots.** `classifyCommand`
(`kb-autosync.ts:137`) regex-parses shell text. Anything unrecognised never
reaches the graph: `git checkout/merge/rebase/stash`, a script that writes files,
`make`, an IDE save, a second harness without the hook, multi-source `mv`
(acknowledged at `:146-148`). Nothing ever checks: `kb-stale-scan.py` tests path
existence only, never content, so a file that changed meaning keeps a
confidently stale node.

## Goal and non-goal

**Goal — bounded-staleness convergence.** For every in-scope path P, the graph's
node set for P is a pure function of P's current `(exists, content-hash)` at the
configured depth. Divergence is detected and corrected within a bounded,
measurable window. Concurrency cannot corrupt state. The invariant is checkable
by a command.

**Non-goal — hard real time.** There is a write-to-reconcile window of roughly a
second. The claim is "converges within N seconds and N is measured", never
"instantaneously correct".

**Constraint — zero LLM tokens, no added agent context.** Every mechanism below
is deterministic I/O. Nothing in the healing path calls a model.

## Architecture

Four mechanisms.

### 1. Observe, do not infer

A recursive `fs.watch` over the configured roots replaces command-string
parsing. It cannot miss a write regardless of which agent, which tool, which
harness, or whether a hook fired. This deletes failure class 3 and lets
`classifyCommand` plus the `MOVE`/`REMOVE`/`COPY`/`MODIFY` word-sets — roughly
200 of the 383 lines in `kb-autosync.ts` — be removed. Net: strictly less
intrusive than today, because hooks come off the `tool_result` hot path.

`fs.watch` gives no durable replay across daemon downtime. Mechanism 4 covers
that gap; it is needed anyway.

### 2. One writer, structurally

A Heimdall-owned SQLite database in WAL mode (`~/.heimdall/journal.db`). Exactly
one process — the reconciler daemon — ever writes it and ever invokes `graft`.
Collisions are not locked against; they are unrepresentable, because concurrent
writers do not exist. Agents never touch graft directly.

Single-writer is enforced by an advisory lock: the daemon holds an exclusive
`flock` on `~/.heimdall/reconciler.lock` for its lifetime. A second daemon exits
immediately rather than racing. One-shot `heimdall reconcile` acquires the same
lock, so manual runs serialize against the daemon instead of fighting it.

Schema:

```sql
paths(
  path TEXT PRIMARY KEY,
  hash TEXT,             -- sha256 of content; NULL when absent
  size INTEGER, mtime_ms INTEGER,
  depth TEXT,            -- depth actually applied
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT,            -- present | absent
  reconciled_at INTEGER
)
owned_nodes(path TEXT, node_id TEXT PRIMARY KEY, kind TEXT, symbol TEXT, line INTEGER)
owned_edges(path TEXT, src TEXT, dst TEXT, relation TEXT, line INTEGER)
pending_edges(path TEXT, src TEXT, dst_symbol TEXT, relation TEXT, line INTEGER)
queue(path TEXT PRIMARY KEY, enqueued_at INTEGER, reason TEXT)
```

All access is via bound parameters (`node:sqlite`), not string interpolation.
This is deliberate: the current hand-rolled `LIKE` escaping
(`kb-autosync.ts:178`, `sync-edits.sh:104`) is a recurring bug source, and this
project's entire value proposition is correctness.

### 3. Level-triggered reconcile

A queued path is a hint that *something changed*, never a description of what.
`reconcile(P)`:

1. `stat` P. Absent -> retract every node and edge P owns; mark `state=absent`.
2. Hash P. If `hash` and `depth` both match the journal -> no-op.
3. Otherwise extract the desired node/edge set at depth D.
4. Diff against `owned_nodes`/`owned_edges` for P; apply adds and deletes to
   graft; commit the new `(hash, depth, node ids, generation)` in one
   transaction.

Reconciling twice is identical to reconciling once. Forty agents editing one
file collapses to one dirty row and one hash check.

**Generation guard.** `generation` increments on every enqueue. A reconcile
records the generation it started from and commits only if that value is still
current; otherwise the result is discarded and the path re-queued. This kills
the ABA race where a late refresh lands after a delete and resurrects a node.

**Node ownership.** Every graph node belongs to exactly one path, recorded in
`owned_nodes`. Retraction is therefore exact: a symbol node cannot outlive the
file that declared it, nor the version of the file that declared it.

**Cross-file edges** are owned by the *source* file, so re-reconciling the
source repairs them. An edge whose target symbol is not yet known goes to
`pending_edges` and is resolved when the target's file is reconciled. Without
this, reconcile order would change the outcome, destroying the
converge-from-any-order property the design rests on.

### 4. Hash audit

`heimdall verify` walks the journal, stats every path, and compares content
hash. Mismatch means drift: the path is re-queued. Missing means removal. This
is the backstop for daemon downtime and for anything the watcher missed
(network mounts, `fs.watch` event loss), and it turns the guarantee into a
command that can run in CI. It is `stat`-only for unchanged files, so it is
cheap enough to run on a short timer inside the daemon.

`--strict` exits non-zero on any drift, for CI use.

## Depth ladder

Node granularity is configurable per root. The default is maximum.

| Level | Name | Contents |
|---|---|---|
| L0 | `path` | one node per file: it exists |
| L1 | `file` | L0 plus language, size, and inventory description |
| L2 | `symbol` | L1 plus one node per top-level definition, with `file:line` and signature |
| L3 | `graph` | L2 plus `imports` / `calls` / `inherits` / `uses` edges, intra- and cross-file |

```yaml
depth: max                  # resolves to deepest AVAILABLE level
roots:
  ~/Repos: max              # L3
  ~/Repos/*/vendor: path    # L0
  ~/Desktop: file           # L1
```

`max` resolves to the deepest level whose dependencies are actually present. A
machine without tree-sitter degrades to L1 and `heimdall doctor` reports the
achieved depth, rather than failing to install. This preserves "default is
maximum" without making tree-sitter a hard install blocker.

### Extraction engine

L2/L3 extraction reuses the already-vendored `vendor/graphify/extract.py`
(MIT, Safi Shamsi), which `vendor/graphify/VENDORED.md` already designates as
Heimdall's per-repo code-graph layer. It provides:

- tree-sitter AST extraction across 29 file extensions
  (`extract.py:2574-2604` dispatch table)
- per-file entry point `extract([path])` (`extract.py:2550`)
- nodes carrying `label` and `line`; edges carrying `relation`
- `input_tokens: 0, output_tokens: 0` — fully deterministic, no model calls
- a SHA256 content-keyed cache (`vendor/graphify/cache.py`)

Heimdall calls it through a `python3` subprocess bridge that emits JSON on
stdout. Depth L0/L1 need no Python at all.

Graphify's own cache key is content-hash based, which composes exactly with
mechanism 3: unchanged content means neither Heimdall nor graphify redoes work.

### Retrieval cost

Depth lives in the index, not the output. Search returns file-level hits with
symbol matches rolled up:

```
[STRONG] bin/lib/reconcile.mjs
         3 matching symbols: reconcilePath:41, diffNodes:88, retract:140
```

So 50x the nodes costs 0x the agent context. `heimdall search --depth symbol`
opts into per-symbol rows.

The measured risk is first-build embedding CPU at roughly 20-50x node count.
Mitigations: per-root depth config, graphify's content-hash cache, and the fact
that steady state only re-embeds changed files.

## Components

| File | Purpose |
|---|---|
| `bin/lib/journal.mjs` | schema, bound-parameter accessors, transactional commit |
| `bin/lib/depth.mjs` | depth config parsing, `max` resolution, capability probe |
| `bin/lib/extract.mjs` | desired node/edge set for a path at a depth; graphify bridge |
| `bin/lib/reconcile.mjs` | `reconcilePath`, diff, retract, generation guard, pending edges |
| `bin/heimdall-reconciler.mjs` | daemon: single-writer lock, `fs.watch`, queue drain, audit timer |
| `extensions/kb-autosync.ts` | reduced to a hint emitter: append path to queue, nothing else |
| `bin/lib/cli-main.mjs` | new `reconcile`, `verify`, `daemon` subcommands |

Removed: `classifyCommand`, `firstMutatingSegment`, `shellTokens`,
`extractPaths`, `updateCwd`, `bulkRewrite`, `removeAnchored`, `refresh`, and the
`MOVE`/`REMOVE`/`COPY`/`MODIFY`/`MAYBE_WRITE`/`SKIP_PREFIX` word-sets.

`bin/sync-edits.sh` and `bin/kb-stale-scan.py` are retained only as one-shot
bootstrap/import paths and are rewired to go through the journal rather than
calling graft directly.

## Error handling

- **graft unreachable** — reconcile fails closed: the path stays dirty and
  queued, the journal is not advanced, and the daemon backs off. No partial
  state is committed, because the graft calls and the journal commit are in one
  transaction boundary (graft calls first, journal commit last; a crash between
  them leaves the path dirty and it is redone, which is safe because reconcile
  is idempotent).
- **extraction failure** (syntax error, unsupported language, tree-sitter
  missing) — degrade that path to the highest level that succeeded, record the
  achieved depth in `paths.depth`, and log. A file that cannot be parsed still
  gets an L1 node; it never silently vanishes.
- **watcher death** — daemon exits non-zero so launchd restarts it; the audit
  sweep on startup reconciles everything that drifted while it was down.
- **journal corruption** — `heimdall verify --rebuild` discards the journal and
  reconstructs it from the filesystem. The journal is a cache of derivable
  facts, never the only copy of anything.

## Testing

The invariant is the test target, not the implementation.

1. **N racing writers** — spawn N concurrent processes mutating one path while
   the reconciler runs; assert exactly one node set for that path, no
   duplicates, no gaps.
2. **Idempotency** — `reconcile(P)` twice yields byte-identical journal state.
3. **Generation/ABA** — a reconcile whose generation went stale must not commit.
4. **Ownership retraction** — deleting a file removes every symbol node it
   declared, and nothing else.
5. **Order independence** — reconciling files A then B, and B then A, converge
   to the same edge set (pending-edge resolution).
6. **Depth resolution** — `max` degrades correctly when tree-sitter is absent;
   per-root overrides apply.
7. **Drift detection** — mutate a file behind the daemon's back; `verify`
   reports and repairs it.
8. **Blind-spot regression** — `git checkout` of a branch that changes files is
   picked up, which the old `classifyCommand` path missed by construction.

## Trade-offs accepted

- **`engines` moves from `>=20` to `>=22.5`** for `node:sqlite`. Bound
  parameters materially shrink the injection/escaping bug class that produced
  the current defects, and Node 20 is past end-of-life. Worth the bump.
- **A background daemon becomes required** for live healing. One-shot
  `heimdall reconcile` and `heimdall verify` still work without it, so the
  daemon is a latency optimisation, not a correctness dependency.
- **First-build cost rises** at L3. Bounded by per-root depth config.

## Out of scope

Retrieval ranking changes beyond symbol roll-up; the trust-verdict logic in
`bin/kb_search_verify.py`; adapter changes beyond pointing at the new queue.
