# Changelog

## 0.12.2 — 2026-09-18

### Fixed

- Gallery `video`/`image` preview fields moved **inside the `pi` manifest**
  (where the pi.dev gallery reads them per docs/packages.md) — the 0.12.1
  top-level placement was ignored.

## 0.12.1 — 2026-09-18

### Added

- **Gallery preview**: `video` + `image` fields in `package.json` pointing at the
  demo capture (`docs/assets/demo.mp4`, `demo.png`), so the pi.dev package
  gallery renders an autoplaying preview for @arihantdeva/heimdall. Assets also
  embedded in the README.

## 0.12.0 — 2026-09-18

### Added

- **Pi native package**: `package.json` now carries a `pi` manifest
  (`extensions: ["./extensions"]`) and the `pi-package` keyword, so pi loads the
  four kb extensions straight from the npm/git package (`pi install
  npm:@arihantdeva/heimdall`) with no file copying. `@earendil-works/pi-coding-agent`
  and `typebox` declared as `peerDependencies` with `"*"` (pi bundles/aliases both).
- `heimdall init --harness pi` now detects a package-managed install
  (`~/.pi/agent/npm` / `.pi/npm` containing a heimdall `package.json` with a `pi`
  manifest) and wires only the rules block — previously it would copy the same
  extension files pi already loads from the package, double-registering tools.

## 0.11.0 — 2026-09-16

Deletions, not features. Five fixes reported against 0.10.0 (each with a
regression test that failed on 0.10.0 and passes now) plus a code-reduction
pass. No published API is removed: everything deleted below was either
unreachable, never shipped in the tarball, or duplicated.

### Removed

- **Rust hybrid search/embed workspace** (`rs/heimdall-search`,
  `rs/heimdall-embed`, `Cargo.toml`/`Cargo.lock`/`.cargo/`, and the tracked
  generated tokenizer/model artifacts under `rs/heimdall-embed/model/`).
  Nothing invoked the crates, and `files[]` never shipped them — the
  `--hybrid` mode and RRF fusion described under 0.10.0 lived only inside that
  unpublished binary. Retrieval is the per-repo graft + global-semantic merge
  in `bin/kb-search.sh`.
- **Parked agent tier** (`bin/lib/tier.mjs`, `bin/lib/agent-memory.mjs`). No
  runtime ever constructed the LLM the tier required, so the memory-variant
  selection was unreachable. A config still carrying `memory.tier` keeps
  loading (unknown keys pass through untouched); `tests/init.test.mjs` pins
  that contract.
- **Dead `kb_search_verify.py` CLI/verdict path** (~220 lines). Its
  `extract_paths` helper stays live for `bin/kb-stale-scan.py`; the retired
  graft-retrieve CLI it wrapped had no callers.
- **Orphan generators and assets** — four zero-reader render scripts, three
  unreferenced images, one unreferenced video, and a dangling `kernels`
  symlink that pointed at a nonexistent `/tmp` path.
- **Dead exports, unused imports, and indirection** across `bin/lib` and
  `bin/kb-search.sh`, plus a redundant `extensions/lib/kb-guard-core.d.mts`.

Code reduction: **−3,148 maintained source lines (−22%)**, 27 fewer tracked
files, −20.9% tracked bytes.

### Fixed

- **Generated MCP configs could never start the server.** Every adapter wrote
  `args: ["…/heimdall.js"]`, but the CLI serves JSON-RPC only for the explicit
  `mcp` subcommand — so the entry point printed `usage: heimdall <command>` and
  exited. Affected Claude Code, Codex, Cursor, Gemini CLI, DeepSeek, and
  OpenCode. The MCP protocol tests missed it because they spawn
  `heimdall.js mcp` directly instead of launching the config the adapters
  write; `tests/adapters-mcp-entry.test.mjs` now does the latter. Existing
  installations are repaired by re-running
  `heimdall init --harness <name>`: the Codex writer now replaces its own TOML
  table rather than skipping it when present, which previously left the broken
  args in place forever while the other adapters overwrote theirs.
- **The npm package could not do AST extraction.** `files[]` omitted
  `vendor/graphify/`, which `bin/lib/heimdall_extract.py` imports at runtime,
  so every installed copy silently settled at file depth. Related: `capability()`
  probed only `tree_sitter`, so a machine with tree-sitter and no graphify was
  told it could reach graph depth while nothing ever did — and because `cap_max`
  is stamped into the journal, the missing upgrade stopped being re-reported.
  It now probes the real bridge import.
- **STRONG did not mean what the README said.** The verdict came from path
  existence plus query-token overlap, and a semantic hit's body is synthesized
  as `semantic hit [<path>]` — so the path alone scored full coverage and a
  stale card could still label a live-but-changed file STRONG. STRONG now
  requires card-to-file identity: the file is a regular file (not a directory
  or symlink) whose size and mtime still match the `cards` row in
  `~/.heimdall/global.db`. That is two stats per hit and opens nothing, and the
  mtime comparison is symmetric and exact — the same test `embed-index.py` uses
  to decide a file is unchanged. The mnemosyne backend, which has no cards to
  check, now reports WEAK with the reason instead of claiming STRONG from a
  path plus matching tokens, so one word no longer means two things depending
  on which backend answered. Hits that cannot be verified are WEAK and carry
  the reason on their own line.
- **`capability()` reported AST depth it could not deliver.** The probe
  imported `graphify.extract` — a stdlib-only module — while every language
  grammar is imported lazily inside the extractors and its failure is turned
  into error rows that settle at file depth. A python with tree-sitter and no
  language binding was therefore told `graph` while every non-Python file fell
  back, and because `cap_max` is stamped into the journal the missing upgrade
  stopped being re-reported. The probe now extracts a real file and requires
  symbol nodes back. Note the ceiling it documents: `max` is per-python, not
  per-language — only the grammars you install produce symbol depth.
- **Documents promised a `windsurf` harness that does not exist.** The README,
  `AGENTS.md`, `docs/adapters.md` and the CLI usage string all listed
  `--harness windsurf`, but no writer is registered, so the documented command
  threw. The claims are removed rather than satisfied with an unverifiable
  config format; `docs/adapters.md` records why and what adding it back needs.
- **Declaration facts lost their predicate.** The `declaration` pattern put the
  subject in capture group 1 and the predicate in group 2, while the extractor
  read only `m[1]` — so `X is allowed` and `X is not allowed` both became
  `X` and deduplicated into one truncated fact. Declarations are now captured
  as complete propositions.
- **`kb-health.sh` required GNU `timeout`.** Not part of the default macOS
  userland, so the search smoke test failed before it ran a command — on the
  primary supported platform. It now prefers `timeout`, then `gtimeout`, then a
  `perl -e 'alarm …'` fallback (perl ships with macOS and Linux), and runs
  unguarded if none exist.

## 0.10.0 — 2026-09-10

### Added

- **Per-hit freshness in search output** — final hits carry `as_of=<age>` and
  `fresh`/`possibly_stale`, anchored to the indexed snapshot's card mtime vs
  the file on disk (1s tolerance; read-only lookup; suppressed when the path
  is dead). Available in `kb-search.sh` output and
  `kb_search_verify.py::freshness_token()`. (Ported from zvec-grep.)
- **Machine-readable semantic degradation** — when the semantic embedding leg
  fails, `kb-search.sh` emits `SEMANTIC_ERROR: <reason>` plus the
  `LEXICAL-ONLY (sem_coverage=degraded)` banner: one greppable token for
  callers, no raw tracebacks, no silent garbage fallback. (Ported from
  zvec-grep.)
- **RRF fusion + adaptive recall** — reciprocal-rank
  fusion `Σ 1/(60+rank)` across lexical and vector recall (fused over full
  recall width before capping), doubling recall ladder (200 → cap 2000) until
  the fused top-k stabilizes, new `--hybrid` CLI mode, and `HEIMDALL_DB` env
  replaces the hardcoded absolute DB path. (Ported from zvec-grep. Shipped in
  0.10.0; the `heimdall-search` implementation was removed — see Unreleased.)
- **Type-aware index size caps** — `embed_walker.py` admits known-text files
  by family: code 1 MiB, data 16 MiB, docs 256 MiB (flat 128 KB retained as
  the unknown-ext content-sniff window). Oversize machine-generated dumps no
  longer pollute the semantic index; large docs still index via preview.
  (Ported from zvec-grep.)
- **rg-vs-kb_search routing doctrine** — harness rule blocks now route exact
  symbol/string/regex lookup to `rg --no-ignore` and cross-repo discovery to
  `kb_search` (doc-only; zvec-grep steering doctrine).

### Changed

- `kb-search.sh` not-configured warning now uses the same `SEMANTIC_ERROR:`
  marker as hard failures, so consumers need only one pattern.

## 0.9.0 — 2026-09-02

### Added

- **`heimdall setup`** — hardware-fitted configuration: detects accelerator
  (Metal/CUDA/CPU) + physical cores, generates annotated `~/.graft/config.yaml`
  (existing file backed up, never clobbered), downloads an embedding model
  from a built-in catalog (bge-m3 default; bge-small-en-v1.5,
  snowflake-arctic-embed-s, nomic-embed-text-v1.5) or accepts BYO `--model-path`,
  and installs/repairs the launchd daemon (`com.graft.daemon`). Flags:
  `--model --model-path --threads --instances --accel --graftd --skip-daemon
  --detect-only`. See `docs/setup.md`.
- **Doctor expansion** — `heimdall doctor` now also validates: config present,
  `graftd --check-config` passes, embedding model file present + sane size,
  plist valid, daemon running — each with SETUP NEEDED guidance.
- **graft-cpp fork + subtree** — `vendor/graft/` is now a git subtree of the
  `graft-cpp` fork (pinned `v0.1.0-heimdall.2`). Fork delta: daemon config
  fallback chain (`--config` > `$GRAFT_CONFIG` > `~/.graft/config.yaml` >
  defaults, source logged) and `graftd --check-config [PATH]` (side-effect-free
  resolved-config dump). Update via `git subtree pull` — see
  `vendor/graft/VENDORED.md`.
- **Self-contained `graftd` build** — llama.cpp fetched via CMake
  `FetchContent` at pinned tag `b10760` and compiled as static libraries.
  `graftd` has no dynamic `libllama`/`libggml` dependency and no
  RPATH/LC_RPATH. Metal shader library embedded on Apple
  (`GGML_METAL_EMBED_LIBRARY`). CUDA passthrough: `-DGGML_CUDA=ON`.
- **npm postinstall auto-build** — `npm i -g` builds `graftd` when the
  toolchain is present; prints a SETUP NEEDED block (what failed + log path
  + retry instructions) on any failure and exits 0 — install never breaks.
  `HEIMDALL_NO_BUILD=1` skips the build in postinstall and `heimdall setup`.
- **`bin/lib/graft-build.mjs`** — probe (`graftd --check-config`, exit 0 +
  `model_path:` in stdout; missing `configPath` returns error immediately),
  canonical-first find/install (`~/.local/bin/graftd` probed first; if
  broken/absent and another candidate works — build cache or
  `~/Repos/graft-cpp/build/graftd` — it is copied atomically into
  `~/.local/bin/graftd`, broken canonical kept as `graftd.bak-<timestamp>`;
  only if no candidate works does it fall through to build), build (cmake
  configure + incremental build, timeout-bounded), install (atomic copy to
  `~/.local/bin/graftd`; `graft` CLI copied to `~/.local/bin/graft` only if
  absent).
- **`heimdall setup` binary handling** — finds a working `graftd` or builds
  and installs one when none exists; `--graftd PATH` probed before copying
  (broken binary = one-line error, nothing written).
- **`tests/graftd-binary.test.mjs`** — asserts the built `graftd` has no
  dynamic llama/ggml deps, no RPATH/LC_RPATH, and runs after being copied
  elsewhere.

### Changed

- bge-m3.gguf relocated from `vendor/graft/models/` to `~/.graft/models/`
  (models no longer live inside the source tree; setup downloads on demand).
- **Setup default instances** — always 2 (was 2 only when cores ≥ 8, else 1).
- **Linux thread detection** — physical cores counted from `/proc/cpuinfo`
  (unique physical-id × core-id pairs), falling back to `lscpu -p=CORE,SOCKET`,
  `nproc`, then `os.cpus()`.
- **`vendor/graft/` in the npm tarball** — `vendor/graft/` source, CMake, and
  `third_party/{BLAKE3,mpack,sqlite-vec}` are shipped; `third_party/llama.cpp/`,
  `build/`, `models/`, `*.db` are excluded; llama.cpp is fetched at first build
  (network needed once).
- **C++ runtime linkage** — `graftd` links `stdc++` on Linux, `c++` on Apple
  (was `c++` unconditionally, which fails to link on Linux/gcc).

### Fixed

- **`dyld: Library not loaded: @rpath/libllama.0.dylib`** — pre-0.9.0 `graftd`
  linked llama.cpp dynamically with build-tree RPATHs; the binary broke when
  moved out of the build tree. The static build has no RPATH/LC_RPATH and no
  dynamic llama/ggml dependency.
- **Hardcoded `third_party/llama.cpp/build` dependency** — replaced by CMake
  `FetchContent`; llama.cpp is fetched at configure time from the pinned tag
  and built in place.
- **`vendor/graft` subtree missing 61 source files** (`src/**`,
  `include/graft/*.h`, `VERSION`): commit b7845ef's conflict resolution
  deleted them; restored verbatim from the v0.1.0-heimdall.2 squash
  (b4a51de). `src/daemon/main.c` keeps the heimdall fork delta.
- **Tracked dangling symlink removed** — `vendor/graft/third_party/llama.cpp`
  → `/tmp/llama-master` was tracked in git; removed. The path is now the
  gitignored FetchContent checkout.

## 0.8.0 — 2026-08-26

Community-feedback release: five additions adopted from u/perseus-computing's
review of Heimdall on r/LLMDevs and an analysis of their Perseus Vault project.
Each addition was independently adversarially reviewed before landing; reviews
live in the repo history and PR description.

### Added

- **Fact near-duplicate suppression** (C1, dedup half only): char-trigram
  Jaccard gate inside `extractFacts` collapses near-identical utterances within
  one file before they reach the journal. Cross-file dedup remains deliberately
  rejected (breaks per-path exact ownership). Thresholds in `facts.mjs`.
- **Fact history + supersession trail** (C3): `fact_history` journal table
  snapshots outgoing fact rows with `invalidated_at`/`superseded_by` when a
  watched file's facts change; bounded retention; new `heimdall history`
  verb. History rows are marked invalidated and are never served as current
  advice.
- **Graded health score** (C4, scoring half): `100 − (10·error + 3·warning +
  1·info)` over `verify --json` drift counts plus stale-scan counters, exposed
  via `bin/lib/health-score.mjs` and a CLI verb. Repair-gating explicitly NOT
  included (no aggressive auto-repair loop exists to gate).
- **Semantic-layer availability telemetry** (C11): embed-index records
  busy/ok transitions (bounded 200-event tail) to
  `~/.heimdall/semantic-state.json`; `kb-health.sh` reports availability
  streaks and warns when the layer was last seen busy. Telemetry is
  best-effort and can never break a query. Auto-retry deferred until the
  single-writer lock design is revisited.
- **Content-verified rehome for ambiguous moves** (C2, narrow version): when a
  stale anchor's basename matches multiple files, candidates are compared to
  a pre-delete snapshot of the node body by trigram Jaccard — ≥0.70 rehomes
  with a provenance note, ≤0.30 removes, in between stays stale+reported.

### Fixed

- (carried from 0.7.x working tree) kb-search verdict pass: semantic hits no
  longer blanket-upgrade to STRONG; zero lexical corroboration stays WEAK.
- Extraction bridge accepts `.mjs`/`.cjs` (`unsupported-extension` on all ESM
  files before); `.mts/.cts` deliberately excluded until the vendored JS
  extractor learns the TS/JS suffix split.

### Not adopted (with reasons)

- Contradiction lane / ruling ladder / efficacy ranking weight / Markdown
  export / capture-ordering guarantee — see PR description; each fails a
  premise in the current architecture or defers until the fact corpus is
  non-trivial.
