# AGENTS.md — Heimdall (working guide for AI agents)

## Purpose (one line)

Heimdall is a **trust-verified, self-healing knowledge layer for AI coding agents**: it watches what an agent does, keeps a semantic-memory graph fresh across every project, and labels every search hit with a trust verdict (STRONG / WEAK / STALE) so an agent never acts on a dead path or a hallucinated match. It is the code behind the "kb_search before implementing" hard gate and the `~/knowledge-base`/Graft machinery the harness rules reference.

The vendor repo lives at `/Users/arihantdeva/Repos/heimdall`; **live runtime state lives OUTSIDE the repo** under `~/.heimdall/` (journal, lock, hint queue, config) and `~/.graft/` (backend daemon + its sqlite DB), plus the `~/knowledge-base/` TSV/telemetry/stale logs. The repo is the engine; the home-dir files are the data.

## Structure map

| Path | Role |
|---|---|
| `bin/heimdall.js` | npm CLI entrypoint — thin dispatch to `bin/lib/cli-main.mjs` |
| `bin/lib/cli-main.mjs` | CLI dispatch + `init`/`insert`/`hint`/`verify`/`depth` implementations |
| `bin/heimdall-reconciler.mjs` | the **single writer** daemon: watch + hint ingest + drain + periodic audit |
| `bin/lib/journal.mjs` | authoritative index: sqlite (`node:sqlite`) — paths, owned nodes/edges, pending edges, dedup queue, generations |
| `bin/lib/reconcile.mjs` | level-triggered convergence: read disk, make graph match; `audit()` = drift detector |
| `bin/lib/extract.mjs` | desired state per file: hash + L0-L3 node/edge extraction, node-id namespacing, tree-sitter bridge |
| `bin/lib/heimdall_extract.py` | Python bridge: calls graphify per-language extractors directly (never `graphify.extract()`) |
| `bin/lib/depth.mjs` | depth ladder (path/file/symbol/graph), capability probe, config, root matching |
| `bin/lib/lock.mjs` | O_EXCL single-writer lock with stale-PID reclamation |
| `bin/lib/hints.mjs` | the only channel a non-writer may use: append "look at this path" lines |
| `bin/lib/sink.mjs` | projection targets: `MemorySink` (tests) and `GraftSink` (graft CLI) |
| `bin/lib/adapters.mjs` | `heimdall init --harness X` config writers (pi, claude-code, codex, cursor, windsurf) |
| `bin/kb-search.sh` | ranked search: graft retrieve + verify + graft explore walk |
| `bin/kb_search_verify.py` | trust verdicts: STRONG/WEAK/STALE/REBUILT/REMOVED/NOPATH, content-aware, path extraction, stale handling |
| `bin/kb-stale-scan.py` | full-graph stale sweep: rehome via `kb-rehome.sh` or log+delete |
| `bin/kb-rehome.sh` | deterministic rehome of a stale node (bounded basename search) |
| `bin/kb-health.sh` | `heimdall doctor`: daemon up, CLI responsive, search smoke, inventory freshness |
| `bin/kb-rebuild.sh` | full graph rebuild: backup → wipe → parallel restore → re-seed → prune → verify |
| `bin/seed-graft.sh` | load `~/knowledge-base/.inventory.tsv` into Graft (idempotent) |
| `bin/sync-edits.sh` | one-shot bootstrap: replay Pi session edit logs (write/edit/hashline_edit) as hints |
| `bin/telemetry.sh` | `collect`/`view`/`usage` — nodes/day, sync age, kb_* tool-call counts |
| `extensions/kb-tools.ts` | Pi extension: exposes `kb_search`/`kb_insert`/`kb_sync` agent tools |
| `extensions/kb-autosync.ts` | Pi extension: hook that appends path hints (never writes the graph) |
| `extensions/kb-orient.ts` | Pi extension: injects prior-work hits into the first user prompt of a session |
| `extensions/kb-search-guard.ts` | Pi extension: warns after 3 consecutive grep-style actions without kb_search |
| `extensions/lib/kb-guard-core.mjs` | pure guard state machine (testable without the Pi runtime) |
| `vendor/graphify/` | vendored graphify v0.3.17 (MIT) — per-repo code-graph extractors (tree-sitter) |
| `vendor/graft/` | vendored Graft source (Apache 2.0) — backend daemon; **not prebuilt**, build from source |
| `config/heimdall.yaml.example` | example backend config → copy to `~/.graft/config.yaml` |
| `launchd/com.heimdall.backend.plist.example` | launchd template for `graftd` |
| `docs/adapters.md` | what each `heimdall init --harness X` installs |
| `docs/heimdall_compare.{dot,png}` | graphify vs Graft vs Heimdall positioning diagram |
| `types/pi-coding-agent.d.ts` | minimal type stub of the Pi host API so extensions typecheck standalone |
| `tests/*.test.mjs` | node:test suites (44 tests) |
| `.pi-subagents/` | subagent run artifacts (input/output/transcripts/meta) — gitignored, historical record |

## Entry points

- **CLI:** `node bin/heimdall.js <command>` or the installed `heimdall` binary. Subcommands: `init`, `search`, `insert`, `doctor`, `daemon`, `reconcile`, `verify`, `depth`, `hint`.
- **Read the flow here:** `bin/heimdall.js` → `bin/lib/cli-main.mjs` (dispatch) → `bin/heimdall-reconciler.mjs` (daemon loop) → `journal` / `hints` / `reconcile` / `extract` / `depth` / `sink`.
- **Where the trust verdicts happen:** `bin/kb-search.sh` (fetch) + `bin/kb_search_verify.py` (verify/enrich).
- **Where the Pi tools come from:** `extensions/kb-tools.ts` → `bin/kb-search.sh`, graft CLI, `bin/sync-edits.sh`.

## How to run / test

```bash
# tests (Node ≥ 22.5; uses node:sqlite, no native deps)
node --test /Users/arihantdeva/Repos/heimdall/tests/*.test.mjs     # 44 pass
# note: `npm test` (node --test "tests/**/*.test.mjs") matches ZERO files on
# some shells — glob is not expanded; pass the dir or explicit paths instead.

# typecheck (needs node_modules; npx may mis-parse flags, use the local bin)
/Users/arihantdeva/Repos/heimdall/node_modules/.bin/tsc --noEmit -p /Users/arihantdeva/Repos/heimdall/tsconfig.json

# CLI smoke (no backend needed)
node /Users/arihantdeva/Repos/heimdall/bin/heimdall.js --help

# end-to-end (needs graft backend + config)
bash /Users/arihantdeva/Repos/heimdall/bin/kb-health.sh
node /Users/arihantdeva/Repos/heimdall/bin/heimdall.js verify --deep
```

Tests are property-based against invariants (convergence, idempotency, single-writer, ownership, order-independence, ABA guard), not call sequences. The concurrency tests are the point. The L3 end-to-end test self-skips when tree-sitter is absent. The `kb-verify.test.mjs` suite uses a `selftest:` node-id mode that reads file content straight from disk, so verdicts are testable **without a graft daemon**.

Dev-dependency note: `@types/node`, `typebox`, `typescript` are dev-only (the extensions import `typebox`); runtime deps are **zero** (Node built-ins only).

## Conventions observed

- **Single writer everywhere.** Every graph/journal mutation goes through `Lock` (O_EXCL create + liveness check, stale-PID reclamation). Hooks/scripts may only emit **hints** (`hints.mjs` / `kb-autosync.ts`), which are advisory prompts, never descriptions of what changed. If you add a writer, route it through the lock and reconcile path — the codebase treats any second writer as a bug by design.
- **Journal is authoritative; the sink (graft graph) is a rebuildable projection.** Sink writes happen BEFORE the journal commit (crash between → path stays dirty → redone; reverse order could mark clean an unprojected path).
- **Reconcile is idempotent by construction**: desired state = pure function of (bytes, depth). Content hash is the change oracle; generation counter is the ABA guard (a stale commit is rejected, not merged).
- **Exact ownership**: nodes/edges/pending belong to exactly one path; a commit deletes and re-inserts all of that path's rows in one transaction. Cross-file edges to not-yet-indexed symbols park as pending edges resolved from either side (order independence).
- **Bound parameters only** for sqlite — the old hand-rolled LIKE escaping (`likeEsc`, python `escape`) was a recurring correctness bug; never build SQL by string concat here.
- **Skip rules live in exactly one place**: `skipPath()` in `bin/lib/reconcile.mjs` (mirrored conceptually in `kb-autosync.ts`). If you touch skip rules, update both.
- **Never PATH-resolve graft** in scripts: `GRAFT` env or `~/.local/bin/graft` absolute path only (supply-chain guard: a shadowed binary could delete memory nodes from inside a search). Keep it.
- **Bridge calls graphify's per-language extractors directly**, never `graphify.extract()` — that would litter `graphify-out/cache/` next to every indexed file and add a second cache that can disagree with reality.
- Node ids are namespaced by path hash (`nodeIdFor`) because graphify derives ids from file stem (every `index.ts` would collide).
- Bash scripts resolve their own dir (`$(dirname "${BASH_SOURCE[0]}")`) and sibling scripts relative to it — never through `~/knowledge-base` (that silently ran a different copy on other machines; that bug was fixed, don't reintroduce it).
- macOS-first: launchd-managed daemon, `launchctl` restart; Linux is a manual-daemon fallback.
- Harness knowledge gates reference the STRONG/WEAK/STALE verdicts as the search contract — search output is the trust boundary, not just a ranked list.

## Gotchas / warnings

1. **`npm test` glob matches nothing** on common shells (`tests/**/*.test.mjs` is passed literally; node --test does not expand `**` from a quoted arg). Run `node --test tests/` or explicit paths. The `package.json` script is the broken entry — do not rely on it for CI.
2. **Live state is in `~/.heimdall/` and `~/.graft/`, not in the repo.** `journal.db`, `reconciler.lock`, `hints.jsonl`, `~/.heimdall/config.json`, `~/.graft/config.yaml`, `~/.graft/profiles/default/graft.db`. Touching these outside the lock/reconcile machinery can corrupt a running system. Tests deliberately sandbox into temp dirs.
3. **The L3 test self-skips without tree-sitter** (silent green on a box that cannot do L3). If you see "L3: ... skipped", the machine cannot index symbols — not a code failure. `python3` on this machine is 3.9.6; the bridge needs a `tree_sitter`-capable python (see `pythonWithTreeSitter` candidates, `HEIMDALL_PYTHON` env).
4. **`heimdall doctor`/`search` need the graft daemon running** (launchd `com.graft.daemon`, config `~/.graft/config.yaml` from `config/heimdall.yaml.example`). Without it: `search` fails ("graft daemon unreachable"), `doctor` reports SETUP NEEDED. The reconciler/journal still works (projection deferred). `graftd` is launchd-managed — do not `nohup graftd` manually (two daemons → socket storms); `kb-health.sh` reconciles to exactly one.
5. **Old-shell-script naming inconsistency** (see below) — the `kb-*` scripts are the search/health/stale/telemetry layer; `sync-edits.sh`/`seed-graft.sh` are bootstrap. `bin/heimdall.js` and `bin/heimdall-reconciler.mjs` are the CLI/daemon. Several `kb-*` scripts still reference `$HOME/knowledge-base/` paths as the legacy home of copies (with package-relative fallbacks).

## Naming-convention observations (NOT fixed, per docs-only rule)

- Mixed naming families: `kebab-case` core (`heimdall.js`, `heimdall-reconciler.mjs`, `cli-main.mjs`, `sync-edits.sh`) vs `kb-*` legacy layer (`kb-search.sh`, `kb-health.sh`, `kb-rebuild.sh`, `kb-rehome.sh`, `kb-stale-scan.py`, `kb_search_verify.py`) vs `lib/*.mjs` snake/hyphen mix. `kb_search_verify.py` uses an underscore while its siblings use hyphens — it is imported by `kb-stale-scan.py` via `sys.path` insert, so renaming it would break imports.
- Versioning: `package.json` says 0.2.0; README "Status" describes v0.1.0 and v0.2.0 history. `.pi-subagents/` artifacts are gitignored but present (subagent workflow records).
- `types/pi-coding-agent.d.ts` is a stub of `@earendil-works/pi-coding-agent` (the real package ships inside the harness); tsconfig `include` covers `extensions/**/*.ts` + `types/**/*.d.ts` only — `bin/*.mjs` is NOT typechecked (typecheck covers extensions only; `bin/` JS is validated by tests).
- The `README.md`'s "What it does" table is the canonical component map; `AGENTS.md` here adds operational detail.
- `docs/adapters.md` documents harness installs; adapter code lives in `bin/lib/adapters.mjs` (not under `docs/`).
- Directory naming: `bin/lib/` holds the shared modules, but `bin/` itself mixes entrypoints, one-off scripts, and the `lib/` subdir; `extensions/lib/` holds the guard-core shared module. Not normalized.

## Data-protection note (2026-08-20 lessons)

- `~/.graft/profiles/default/graft.db` and `~/knowledge-base/*.tsv`/logs are live data. Never `rm`/`mv`/`ln -sf` over them blindly — the 2026-08-20 `matches.sqlite3` loss came from exactly that pattern. Use `bin/kb-rebuild.sh` (it backs up via the sqlite backup API before wiping) or `bin/safe-move.sh`-style resolution before any destructive move.
- `kb-rebuild.sh` stops the daemon, DROPs graph tables (FTS shadow tables reject DELETE), recreates schema, relaunches — do not run casually; it is a last-resort full rebuild.
