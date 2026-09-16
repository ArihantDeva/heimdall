# Maximum Bloat Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete every evidence-backed unused slice of the Heimdall repository — dead internals, approved dormant capabilities, orphan assets/generators, a dangling symlink, redundant manifests — and reconcile package/docs, ending with a reproducible before/after reduction report and zero open high-severity review findings.

**Architecture:** Nine disjoint implementation lanes (A1, A2, B1, B2, B3, E1, E2, C, D) plus one integration worktree — one writer per worktree, each cutting a disjoint file set from base `c16b91f8b57408266f7f7116a4e1f5b922a32e21`. Every deletion re-runs its caller/package scans at the lane's current SHA and is deleted only on zero live consumers; every behavior-affecting change gets a sensitivity-proven characterization test first. Lanes merge in dependency order behind focused checks, then full gates, then three independent adversarial review passes on raw evidence only.

**Tech Stack:** Node ≥22.5 (`node --test`, zero runtime deps), ESM `.mjs` libraries, Bash scripts, Python 3 helpers, TypeScript Pi extensions, npm pack, git worktrees.

**Spec:** `docs/superpowers/specs/2026-09-16-maximum-bloat-reduction-design.md` (sha256 `4042921f0fbac019bdc94ada319e418f8425a81dc39839206252599839c33e55`).

## Global Constraints

- Base SHA: `c16b91f8b57408266f7f7116a4e1f5b922a32e21`. Before any write in any worktree: `git rev-parse HEAD` equals the base (or the lane's own branch tip) and `git status --porcelain` is empty. HEAD moved unexpectedly ⇒ stop and report; do not rebase silently.
- One writer per worktree. Worktrees live at absolute paths `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-<lane>`, branches `bloat/<lane>`. Every standalone command block that needs the base defines it inline (`BASE=c16b91f8b57408266f7f7116a4e1f5b922a32e21`) or spells the literal SHA; no block relies on shell state from an earlier step. Never touch the stale dirty worktree `heimdall-c11`; no lane writes inside `/Users/arihantdeva/Repos/heimdall` (all lane work happens in worktrees).
- Runtime dependencies stay `0`. Dev-dependency count must not increase.
- Caller proof for deletion means **zero live execution consumers**, not zero textual hits.
- Scan command (textual pass):
  ```bash
  rg --no-ignore -n "<symbol-or-path>" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md package.json mise.toml .github config launchd demo.tape | rg -v '^docs/superpowers/'
  ```
- Beyond the textual pass, require zero live execution/caller/dynamic/template/package consumers: no runtime import, no script or package invocation, no dynamic/template reference (`HeimdallPlugin`-style emitted text), no package `files[]` entry.
- Every remaining textual hit must be enumerated and classified `keep | rewrite | delete` in the lane report.
- Any hit that is an unexplained live consumer ⇒ STOP, report, replan (spec invariant). Historical hits under `docs/superpowers/**` are excluded by construction.
- Behavior/format change ⇒ smallest characterization test written first, with the intended failure recorded (for a characterization test, sensitivity proof by flipping one asserted constant; see Task 8). For a real behavior change, a genuine RED. Pure deletion of unreachable code ⇒ no invented tests; existing focused/full tests are the gate.
- Every lane: relevant focused tests + `git diff --check` + its own commit. Integration alone runs the canonical gate pair `npm test && npm run typecheck` plus `npm pack --dry-run` (Task 10 Step 3).
- Test baseline: `npm test` (chosen command; do not replace it with `node --test tests/` and do not change the `package.json` test script — the DeepSeek baseline executed `npm test` and observed 374 passing). Record the live `npm test` count before and after every deleting lane; the final count need NOT stay 374, because tasks 1, 4, 5 delete tests exclusively covering removed behavior.
- Ask-first gates (from spec):
  - deleting any newly discovered public/documented capability outside the approved Rust / agent-tier / `kb-verify.sh` groups,
  - deleting untracked files or user data; untracked/ignored paths (`target/`, ignored model artifacts, build outputs, caches, data, `bench/runs`, `bench/data`) are never deleted by any lane — any newly required untracked/user-data deletion means STOP and ask,
  - deployed machine or config changes,
  - push, merge, release, publish,
  - destructive history operations (including any `git reset --hard`).
- Review severity scale (defined once, used by tasks 13/14): **HIGH** = invariant / public-behavior / data-safety break, missing live-caller proof, or failing required gate; **MEDIUM** = verification or process gap able to mask a defect; **LOW** = cosmetic/docs. Completion requires zero open HIGH. Every accepted MEDIUM fix also reruns the gates it affects (focused suite + `npm test` + `npm run typecheck` + `git diff --check`).
- Never count ignored local-disk cleanup (`bench/runs`, `bench/data`, `target`, `vendor/**/build`, vendored models) as repository reduction.
- Untouched by this plan (stay live, do not edit or delete):
  - `vendor/graft/**`, `vendor/graphify/**`
  - `assets/demo.gif`, `demo.tape`, `bin/render-demo.py`, `docs/heimdall_compare.dot`, `docs/heimdall_compare.png` — these have live readers (`README.md:287`, `AGENTS.md:44`); only the four zero-reader sibling render generators and the proven-orphan outputs are deleted
  - template-emitted `HeimdallPlugin` text
  - `bin/kb-stale-scan.py` behavior (its `extract_paths` import is preserved)
  - `bin/embed-index.py`, `bin/embed_walker.py`
  - `bin/heimdall.js`, `bin/heimdall-reconciler.mjs`, `bin/heimdall-hook.mjs`
  - `bin/seed-graft.sh`, `bin/sync-edits.sh`, `bin/telemetry.sh`, `bin/postinstall.mjs`
  - all `bench/*.py` and `bench/tests/**`
  - `config/heimdall.yaml.example` except Task 4's tier-specific line removal

---

## Lane Map (ownership is exclusive; no two concurrent writers edit the same file)

| Lane | Worktree / branch | Owns these files only | Depends on |
|---|---|---|---|
| A1 | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-a1` / `bloat/a1-verify-dead-path` | `bin/kb_search_verify.py`, `tests/kb-verify.test.mjs` | — |
| A2 | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-a2` / `bloat/a2-dead-exports` | `bin/lib/enforcement-rules.mjs`, `bin/lib/facts-cli.mjs`, plus zero-caller sweep over `bin/lib/depth.mjs`, `bin/lib/sink.mjs`, `bin/lib/hints.mjs`, `bin/lib/extract.mjs`, `bin/lib/lock.mjs`, `bin/lib/facts.mjs`, `bin/lib/health-score.mjs`, `bin/lib/index-bootstrap.mjs`, `bin/lib/ingest-email.mjs`, `bin/lib/mcp-server.mjs` (must exclude every D-owned file) | — |
| B1 | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-b1` / `bloat/b1-rust-workspace` | `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, `rs/**`, `mise.toml`, `README.md`, `docs/setup.md`, `CHANGELOG.md` | — |
| B2 | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-b2` / `bloat/b2-agent-tier` | `bin/lib/tier.mjs`, `bin/lib/agent-memory.mjs`, `tests/tier.test.mjs`, `config/heimdall.yaml.example`, `docs/adapters.md` | — |
| B3 | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-b3` / `bloat/b3-kb-verify` | `bin/kb-verify.sh`, `tests/kbverify_insert_probe.py` | — |
| E1 | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-e1` / `bloat/e1-orphans` | `bin/render-explainer.py`, `docs/render-comparison.py`, `docs/render-infrastructure.py`, `docs/render-demo-video.py`, `assets/explainer.png`, `docs/heimdall-comparison.png`, `docs/heimdall-infrastructure.png`, `docs/heimdall-demo.mp4`, `kernels` | — |
| C | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-c` / `bloat/c-guard-dedup` | `extensions/kb-search-guard.ts`, `extensions/lib/kb-guard-core.mjs`, `extensions/lib/kb-guard-core.d.mts`, `tests/guard.test.mjs` | — |
| E2 | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-e2` / `bloat/e2-manifests` | `package.json`, `.gitignore`, `AGENTS.md` | B1, B2, B3, E1, C, D merged (serialized final reconciliation) |
| D | `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-d` / `bloat/d-hotspots` | `bin/lib/setup.mjs`, `bin/lib/cli-main.mjs`, `bin/lib/journal.mjs`, `bin/kb-search.sh`, `bin/lib/graft-build.mjs`, `bin/lib/adapters.mjs`, `bin/lib/reconcile.mjs` | A2 frozen sweep target list (A2 must exclude every D-owned file) |

Concurrency rules that hold exactly as written:

- A1, A2, B1, B2, B3, E1, C may run concurrently.
- D may start only after A2 freezes its sweep target list, and A2's sweep must exclude every D-owned file. A2 and D are therefore **not** fully concurrent: A2's target list freezes first; D starts on that frozen list.
- E2 is the serialized final reconciliation. It runs after B1, B2, B3, E1, C, and D are merged, and also runs one mandatory post-D pass (Task 7 Step 7) because C and D can add or remove files.
- Integration order: **A1 → A2 → B1 → B2 → B3 → E1 → C → D → E2**.

---

### Task 0: Baseline capture and worktree creation

**Files:**
- Create (outside the repo): `~/.pi/worktrees/heimdall-bloat-baseline.txt`
- Create: the nine lane worktrees plus the integration worktree
- [ ] **Step 1: Verify the base and cleanliness**

```bash
BASE=c16b91f8b57408266f7f7116a4e1f5b922a32e21
cd /Users/arihantdeva/Repos/heimdall
git rev-parse HEAD        # expect c16b91f8b57408266f7f7116a4e1f5b922a32e21
git status --porcelain    # expect empty
```

- [ ] **Step 2: Record the historical spec baseline (context only)**

The spec's table (tracked files 326, tracked bytes 7,880,901, reported tracked lines 88,702, lines excluding vendor/generated/lockfiles 25,853, handwritten ≈10.9k, runtime deps 0, dev deps 4, Node tests 374) was measured at base `e35acbbea58bf96073320743bd669e9c43a9b562`, which is older than this plan's base and is **context only**. The final report uses freshly captured plan-base metrics from Step 3, never the spec's numbers.

- [ ] **Step 3: Capture the baseline with the exact metric commands**

```bash
BASE=c16b91f8b57408266f7f7116a4e1f5b922a32e21
cd /Users/arihantdeva/Repos/heimdall
{
  echo "M1 tracked_files: $(git ls-files | wc -l | tr -d ' ')"
  echo "M2 tracked_bytes: $(git ls-files -z | xargs -0 wc -c | rg -v '\btotal$' | awk '{s+=$1} END {print s}')"
  echo "M3 tracked_lines: $(git ls-files -z | xargs -0 wc -l | rg -v '\btotal$' | awk '{s+=$1} END {print s}')"
  echo "M4 lines_ex_vendor_generated_lock: $(git ls-files -z | xargs -0 wc -l | rg -v '\btotal$' | awk '{n=$0; sub(/^[ \t]+/,"",n); print n}' | rg -v '^(vendor/|rs/heimdall-embed/model/|package-lock\.json$|Cargo\.lock$|bench/runs/|bench/data/)' | awk '{s+=$1} END {print s}')"
  echo "M5 maintained_source_lines: $(git ls-files 'bin/*' 'extensions/*' | tr '\n' '\0' | xargs -0 wc -l | rg -v '\btotal$' | awk '{s+=$1} END {print s}')"
  echo "M6 tests_lines: $(git ls-files 'tests/*' | tr '\n' '\0' | xargs -0 wc -l | rg -v '\btotal$' | awk '{s+=$1} END {print s}')"
  echo "M7 npm_pack: $(npm pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s)[0];console.log(JSON.stringify({entryCount:j.entryCount,size:j.size,unpackedSize:j.unpackedSize}))})')"
  echo "M8 deps: $(node -e 'const p=require("./package.json");console.log(JSON.stringify({runtime:Object.keys(p.dependencies||{}).length,dev:Object.keys(p.devDependencies||{}).length}))')"
  echo "M9 test_count: $(npm test 2>&1 | rg -o '^# pass [0-9]+' | tail -1)"
} | tee ~/.pi/worktrees/heimdall-bloat-baseline.txt
```

Metric conventions (identical before/after, robust across `xargs` batches):

- Every `wc` measure sums per-file rows and excludes **every** `total` row (`rg -v '\btotal$'`), never `tail -1`. `xargs` splits large file lists into multiple `wc` invocations, each emitting its own `total` row, so `tail -1` would report one batch's total rather than the tree total.
- The exclusion regex is exactly `^(vendor/|rs/heimdall-embed/model/|package-lock\.json$|Cargo\.lock$|bench/runs/|bench/data/)` — no stray spaces inside the alternation.
- Maintained handwritten LOC uses one exact path/extension boundary, `git ls-files 'bin/*' 'extensions/*'` (M5), and the identical command is re-run verbatim after integration (Task 12). Tests LOC is kept separate and never folded into M5 (M6).
- Sanity assertion: `M4 < M3` must hold (non-vendor/generated LOC below total LOC). If it does not, the exclusion filter is broken — fix the filter before recording any baseline.

Expected: every line prints a number or JSON. `M1` ≈ 326 (plan base, e35a-era spec said 326, but this base is newer — record the live value); `M8.runtime` is `0`; record the live dev count rather than any historical value; `M4 < M3` holds.

- [ ] **Step 4: Create the lane worktrees**

```bash
BASE=c16b91f8b57408266f7f7116a4e1f5b922a32e21
cd /Users/arihantdeva/Repos/heimdall
for l in a1-verify-dead-path a2-dead-exports b1-rust-workspace b2-agent-tier b3-kb-verify e1-orphans e2-manifests c-guard-dedup d-hotspots; do
  git worktree add -b "bloat/$l" "/Users/arihantdeva/.pi/worktrees/heimdall-bloat-${l%%-*}" "$BASE"
done
git worktree add -b bloat/integration /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration "$BASE"
```

Expected: `git worktree list` shows ten worktrees; the main tree stays clean on its original branch.

- [ ] **Step 5: Commit**

No commit. Task 0 is measurement plus worktree setup only (worktrees are not repository content).

---

### Task 1: Lane A1 — delete the dead `kb_search_verify.py` execution path

**Files:**
- Modify: `bin/kb_search_verify.py`
- Modify: `tests/kb-verify.test.mjs`

**Interfaces:**
- Consumes: `bin/kb-stale-scan.py:20` `from kb_search_verify import extract_paths` (keep this import working)
- Produces: module `kb_search_verify` exporting `extract_paths(text) -> list[str]` and nothing else required

- [ ] **Step 1: Re-run the caller scan at the lane SHA (proof the CLI path is dead)**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a1
rg --no-ignore -n "kb_search_verify" bin extensions tests bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github package.json launchd demo.tape | rg -v '^docs/superpowers/'
```

Expected textual hits: only `bin/kb-stale-scan.py` (import of `extract_paths`), `tests/kb-verify.test.mjs` (import of `extract_paths`), and two comments (`bin/lib/health-score.mjs`, `bin/lib/cli-main.mjs`) that describe `kb-stale-scan.py`. Classify each hit `keep | rewrite | delete` in the lane report. Required proof is zero live execution consumers: **no execution of the script itself anywhere** (no `python3 bin/kb_search_verify.py`, no `__main__` invocation from a script/package/launchd/CI/dynamic template). Any invocation hit ⇒ STOP.

- [ ] **Step 2: Delete the dead path in `bin/kb_search_verify.py`**

Rewrite the header docstring to describe the module as "path extraction for stale-node rehoming", then delete, in one edit:
- `STOP` set and `toks()` (lines ~9-19) — used only by `main()`.
- `get_node()` (lines ~22-39) — used only by `main()`.
- `GRAFT` (lines ~52-54) — used only by `get_node()`/`handle_stale()`.
- `handle_stale()` (lines ~103-142).
- `freshness_token()` (lines ~145-166) — and with it the `sqlite3` import.
- `content_score()` (lines ~169-185).
- `main()` (lines ~188-266) and the `if __name__ == "__main__": main()` tail.
- Narrow the import line `import json, os, re, sqlite3, subprocess, sys, tempfile, time` to `import os, re` (the remaining `extract_paths` uses only `os`, `re`, and module constants).

Keep: `HOME`, `_HOME_ABS`, `HOME_RE`, `extract_paths()` in full (including the brace-group and space-extension logic — it is live).

- [ ] **Step 3: Verify the retained surface works**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a1
printf 'see %s/heimdall-fixture-target.py\n' "$PWD" > /tmp/heimdall-extract-arg.txt
python3 -c "import sys; sys.path.insert(0,'bin'); from kb_search_verify import extract_paths; print(extract_paths(open('/tmp/heimdall-extract-arg.txt').read())[:1])"
python3 -c "import sys; sys.path.insert(0,'bin'); import kb_search_verify as m; assert not hasattr(m,'main'), 'dead path survived'"
python3 -m py_compile bin/kb-stale-scan.py && echo "kb-stale-scan compiles"
```

Expected: a one-element list containing the in-repo absolute path; the `assert` passes; `py_compile` prints `kb-stale-scan compiles`. The fixture path is `$PWD`-relative inside the worktree and the argument lives in `/tmp` — no personal external path is used.

- [ ] **Step 4: Delete the tests that exclusively cover the dead behavior**

In `tests/kb-verify.test.mjs`, delete: the `SCRIPT` constant (line ~15), the `verify()` helper (lines ~16-23), the `retrieveJson()` helper (lines ~25-27), and every `test(...)` whose body calls `verify(` or `retrieveJson(` (the CLI-driven verdict tests: currently `content mismatch downgrades STRONG even with live path` and `content match upgrades to STRONG`, plus the remaining CLI tests below line 40). Keep the test that spawns Python and imports `extract_paths`, and keep the file's imports it still needs.

- [ ] **Step 5: Prove the test file no longer references the CLI and still passes**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a1
rg -n "SCRIPT|retrieveJson\(|verify\(" tests/kb-verify.test.mjs   # expect no hits
node --test tests/kb-verify.test.mjs
rg -c "^test\(" tests/kb-verify.test.mjs
```

Expected: no hits; `node --test` reports pass with 0 failures; the remaining test count is ≥1 (the `extract_paths` test).

- [ ] **Step 6: Commit**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a1
git add bin/kb_search_verify.py tests/kb-verify.test.mjs
git commit -m "refactor(a1): drop dead kb_search_verify CLI path, keep extract_paths"
```

---

### Task 2: Lane A2 — dead exports in `enforcement-rules.mjs`, empty statement in `facts-cli.mjs`, zero-caller sweep

**Files:**
- Modify: `bin/lib/enforcement-rules.mjs`
- Modify: `bin/lib/facts-cli.mjs`
- Modify (only if Step 5 proves zero callers): `bin/lib/depth.mjs`, `bin/lib/sink.mjs`, `bin/lib/hints.mjs`, `bin/lib/extract.mjs`, `bin/lib/lock.mjs`, `bin/lib/facts.mjs`, `bin/lib/health-score.mjs`, `bin/lib/index-bootstrap.mjs`, `bin/lib/ingest-email.mjs`, `bin/lib/mcp-server.mjs`

**Interfaces:**
- Consumes: `bin/lib/adapters.mjs:11` `import { ruleBlock, RULES_VERSION } from "./enforcement-rules.mjs"`
- Produces: `enforcement-rules.mjs` exporting exactly `RULES_VERSION` and `ruleBlock(tool = "kb_search")`; `facts-cli.mjs` stdout contract unchanged (one JSON array line for `--file`, one JSON object for `--dir`)

- [ ] **Step 1: Caller-proof the two suspicious exports**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a2
rg --no-ignore -n "claudeHooksFragment" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github config launchd package.json
rg --no-ignore -n "assetsDir" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github config launchd package.json
```

Expected: each hit list contains only the definition in `bin/lib/enforcement-rules.mjs`. Enumerate every textual hit and classify it `keep | rewrite | delete`. Zero live execution/caller/dynamic/template/package consumers is the delete condition; any call site ⇒ STOP (do not delete that export).

- [ ] **Step 2: Delete the two dead exports and their now-unused imports**

In `bin/lib/enforcement-rules.mjs`: delete the `claudeHooksFragment` block (the `/** Claude Code hooks fragment ... */` comment plus its `export const claudeHooksFragment = () => ({...})`) and the `assetsDir` block (its comment plus `export const assetsDir = () => join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets")`), then delete the now-unused header imports `import { dirname, join } from "node:path"` and `import { fileURLToPath } from "node:url"` and the module comment sentence that claims adapters embed a per-harness tool mapping beyond `ruleBlock`.

- [ ] **Step 3: Verify the module surface and the adapter contract**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a2
node -e "import('./bin/lib/enforcement-rules.mjs').then(m=>console.log(Object.keys(m).sort().join(',')))"
node --test tests/adapters.test.mjs tests/adapters-mcp-entry.test.mjs tests/init.test.mjs tests/init-e2e.test.mjs
```

Expected: `RULES_VERSION,ruleBlock`; all four suites pass with 0 failures (they assert the emitted rules text still contains `heimdall:enforcement` and the `kb_search` vocabulary).

- [ ] **Step 4: Delete the empty statement in `bin/lib/facts-cli.mjs`**

Delete the line `const { } = {}` (line 24) and its blank-line neighbour so the `// Batch mode:` comment follows `const args` parsing directly. Change nothing else — `facts-cli.mjs` is live (consumed by `bench/ingest.py`).

- [ ] **Step 5: Zero-caller private-internal sweep over the ten named library files**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a2
for f in depth sink hints extract lock facts health-score index-bootstrap ingest-email mcp-server; do
  echo "== $f"
  rg -n "^(export )?(async )?function [A-Za-z_]+|^export const [A-Za-z_]+|^const [A-Z_]+ =" "bin/lib/$f.mjs"
done
```

Frozen-target rule (holds the A2/D dependency exactly): the sweep target list above excludes every D-owned file (`bin/lib/setup.mjs`, `bin/lib/cli-main.mjs`, `bin/lib/journal.mjs`, `bin/kb-search.sh`, `bin/lib/graft-build.mjs`, `bin/lib/adapters.mjs`, `bin/lib/reconcile.mjs`). Freeze this list and record it in the lane report **before** lane D starts; D must not begin until that record exists.

For each symbol printed, run the caller scan from Global Constraints and apply the zero-live-consumer proof plus keep/rewrite/delete classification. Delete only symbols with zero callers outside their defining file and outside `docs/superpowers/**`. If a file yields nothing deletable, record `no cut` for it and move on — do not force a cut.

- [ ] **Step 6: Focused tests and commit**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a2
node --test tests/cli-contract.test.mjs tests/graft-build.test.mjs tests/health-score.test.mjs tests/index-bootstrap.test.mjs tests/ingest-email.test.mjs tests/mcp-server.test.mjs
node bin/lib/facts-cli.mjs --file <(printf 'I prefer SQLite.\n')   # expect one JSON array line, exit 0
git diff --check
git add bin/lib/enforcement-rules.mjs bin/lib/facts-cli.mjs
git commit -m "refactor(a2): drop zero-caller exports and empty statement"
```

Expected: suites pass 0 failures; the smoke line is one JSON array; `git diff --check` silent. Commit only from lane A2 and only after Step 5 cuts (if Step 5 cut nothing, still commit Steps 1-4 with the same message).

---

### Task 3: Lane B1 — delete the Rust search/embed workspace, its artifacts, manifests, and docs

**Files:**
- Delete: `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, `rs/heimdall-search/Cargo.toml`, `rs/heimdall-search/src/main.rs`, `rs/heimdall-embed/Cargo.toml`, `rs/heimdall-embed/export_onnx.py`, `rs/heimdall-embed/src/lib.rs`, `rs/heimdall-embed/src/main.rs`, `rs/heimdall-embed/model/config.json`, `rs/heimdall-embed/model/special_tokens_map.json`, `rs/heimdall-embed/model/tokenizer.json`, `rs/heimdall-embed/model/tokenizer_config.json`, `rs/heimdall-embed/model/vocab.txt`
- Modify: `mise.toml`, `README.md`, `docs/setup.md`, `CHANGELOG.md` (only lines the scan in Step 2 actually hits)

**Interfaces:**
- Consumes: nothing from other lanes
- Produces: a repository with no cargo workspace; `bin/embed-index.py` and the rest of the Python/node runtime untouched

- [ ] **Step 1: Whole-repo caller scan for the Rust workspace**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b1
rg --no-ignore -n "rs/heimdall|heimdall-embed|heimdall-search|export_onnx|Cargo|cargo " bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml .github package.json launchd config demo.tape | rg -v '^docs/superpowers/|^rs/|^Cargo|^\.cargo/'
```

Expected: hits only inside `rs/**`, `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, and doc/mise prose. Enumerate every hit and classify `keep | rewrite | delete`. **Any hit inside `bin/`, `extensions/`, `tests/`, `bench/`, `.github/`, or `package.json` that executes or packages a Rust binary — or any dynamic/template/package consumer — ⇒ STOP and replan** (a live consumer blocks the deletion per spec).

- [ ] **Step 2: Inspect `mise.toml` and capture the exact doc/mise deletion list**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b1
rg -n "rs/heimdall|heimdall-embed|heimdall-search|export_onnx|Cargo|cargo " mise.toml README.md docs/setup.md CHANGELOG.md
sed -n '1,200p' mise.toml
```

Record each hit for Step 4. Expected: `mise.toml` Rust tasks, a README section describing the Rust embed/search crates, possibly `docs/setup.md` build steps. Inspect `mise.toml` in full and remove **only** Rust-specific stanzas; preserve every Node, Bun, and Python task and any task that mixes languages (delete only its Rust step).

- [ ] **Step 3: Delete the workspace files**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b1
git rm -r Cargo.toml Cargo.lock .cargo rs
```

Expected: `rs/` and both cargo files gone from the index and worktree; `git status --porcelain` shows only `D` entries (plus `mise.toml`/docs once edited). `git rm` removes tracked Rust/model files only. Do **not** remove any ignored/untracked local `target/` directory or any ignored model artifacts on disk — the plan's scope is tracked content only; leave the disk alone and never delete untracked or ignored paths.

- [ ] **Step 4: Edit the doc/mise hits from Step 2**

For each hit line, delete the sentence/row/task block that describes the Rust workspace; if `mise.toml` has a `tasks` entry that only builds/benchmarks the Rust crates, delete that entry; if a task mixes Rust and JS steps, delete only its Rust step. Do not rewrite neighbouring prose.

- [ ] **Step 5: Verify nothing references the workspace and the gates stay green**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b1
rg --no-ignore -n "rs/heimdall|heimdall-embed|heimdall-search|export_onnx" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml .github package.json launchd config demo.tape | rg -v '^docs/superpowers/' && echo "0 refs"
npm test
npm run typecheck
git diff --check
```

Expected: `0 refs`; `npm test` passes with 0 failures and a live count recorded (B1 deletes no test files, so the count should match the pre-lane live count, not necessarily 374); `npm run typecheck` silent; `git diff --check` silent.

- [ ] **Step 6: Commit**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b1
git add -A mise.toml README.md docs/setup.md CHANGELOG.md
git commit -m "refactor(b1): remove dormant Rust search/embed workspace and its docs"
```

---

### Task 4: Lane B2 — delete the parked agent tier and its exclusive docs

**Files:**
- Delete: `bin/lib/tier.mjs`, `bin/lib/agent-memory.mjs`, `tests/tier.test.mjs`
- Modify: `config/heimdall.yaml.example`, `docs/adapters.md` (only the lines the Step 2 scan hits)

**Interfaces:**
- Consumes: nothing from other lanes
- Produces: no `memory.tier` config surface and no `resolveTier`/`agentExtract` symbols anywhere in live code

- [ ] **Step 1: Caller proof (runtime imports)**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b2
rg --no-ignore -n "resolveTier|agentExtract|agent-memory\.mjs|tier\.mjs" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github config launchd package.json | rg -v '^docs/superpowers/'
```

Expected: hits only in `tests/tier.test.mjs` (deleted here) and the two definition files. Enumerate every hit and classify `keep | rewrite | delete`; zero live execution/caller/dynamic/template/package consumers is the condition. A runtime import in `bin/` or `extensions/` ⇒ STOP (the tier would be live).

- [ ] **Step 2: Capture the live doc/config hits**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b2
rg -n "memory\.tier|agent-memory|agent tier|resolveTier|agentExtract|TIERS" config/heimdall.yaml.example docs/adapters.md docs/setup.md README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md
```

Record the lines. Expected: a `memory:` / `tier: cpu` sample block in `config/heimdall.yaml.example`; possibly a row in `docs/adapters.md` or README describing the optional agent tier. Do **not** edit `docs/superpowers/**` (historical records of the 2026-08-23 cycle).

Scope rule: `config/heimdall.yaml.example` and `docs/adapters.md` stay live. Remove only the tier-specific lines; keep every other key in the `memory:` block, keep the rest of the sample config, and keep every non-tier row in `docs/adapters.md`.

- [ ] **Step 3: Characterize `memory.tier` handling before deleting it (compatibility check)**

This change removes a documented config surface, so it needs a characterization test written first.

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b2
rg -n "memory|tier|validate|parse|unknown" bin/lib/setup.mjs bin/lib/adapters.mjs bin/lib/cli-main.mjs | rg -i "tier|unknown|valid"
```

Write the smallest characterization test (extend the existing closest test file; do not create a new harness) that feeds a config containing a `memory.tier` key through the same validation/parse path the setup and CLI code uses, and assert the observable outcome. Record the current outcome before deleting anything. If removal of the documented key would turn an existing config file into a hard parse/validation failure, preserve tolerant handling (ignore unknown key) or STOP and replan — do not ship a config that breaks existing user files.

- [ ] **Step 4: Delete the three files and the live doc/config mentions**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b2
git rm bin/lib/tier.mjs bin/lib/agent-memory.mjs tests/tier.test.mjs
```

Then delete the `tier` sample lines from `config/heimdall.yaml.example` (keep the rest of the `memory:` block) and delete each recorded prose row/sentence from `docs/adapters.md`. Leave dated specs and plans untouched. Removed capability gets no shim, no deprecation stub.

- [ ] **Step 5: Verify and run the full suite**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b2
rg --no-ignore -n "memory\.tier|resolveTier|agentExtract|agent-memory\.mjs|tier\.mjs" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml config | rg -v '^docs/superpowers/' && echo "0 refs"
node --test tests/tier.test.mjs 2>/dev/null || echo "tier suite removed as expected"
npm test
npm run typecheck
git diff --check
```

Expected: `0 refs`; `npm test` passes with 0 failures and the live count reduced by exactly the tests that `tests/tier.test.mjs` actually contained. **Derive that number from the file itself before deletion** — run `rg -c "^test\(|^\s+test\(" tests/tier.test.mjs` (or count the `test(` declarations) on the pre-deletion file and record the number; never hardcode 12 or any other figure. Typecheck silent; diff check silent.

- [ ] **Step 6: Commit**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b2
git add -A config/heimdall.yaml.example docs/adapters.md
git commit -m "refactor(b2): remove parked agent-memory tier and its docs"
```

---

### Task 5: Lane B3 — delete zero-caller `kb-verify.sh` and its exclusive probe

**Files:**
- Delete: `bin/kb-verify.sh`, `tests/kbverify_insert_probe.py`

**Interfaces:**
- Consumes: nothing from other lanes
- Produces: no repository reference to `kb-verify.sh` or `kbverify_insert_probe`

- [ ] **Step 1: Caller proof**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b3
rg --no-ignore -n "kb-verify\.sh|kbverify_insert_probe" bin extensions tests bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml .github package.json launchd config demo.tape | rg -v '^docs/superpowers/|kb-verify\.test\.mjs'
```

Expected: nothing (the `kb-verify.test.mjs` name is a different artifact and is filtered out). Enumerate any hit and classify `keep | rewrite | delete`. Any hit that invokes the script — `launchd`, `.github`, `mise.toml`, another script, or a dynamic/template/package reference — ⇒ STOP.

- [ ] **Step 2: Delete both files**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b3
git rm bin/kb-verify.sh tests/kbverify_insert_probe.py
```

- [ ] **Step 3: Verify the suites that used to share the directory still pass**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b3
node --test tests/
git diff --check
```

Expected: pass / 0 failures. The deleted probe was only reachable from `bin/kb-verify.sh` (Step 1 proved it). Note the local `~/.heimdall/venv` dependency of `kb-verify.sh` never entered CI, so no CI change is needed — verify by re-reading `.github/workflows/ci.yml` before claiming this.

- [ ] **Step 4: Commit**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b3
git commit -m "refactor(b3): drop manual kb-verify.sh and its exclusive insert probe"
```

---

### Task 6: Lane E1 — delete orphan render generators/assets and the dangling `kernels` symlink

**Files:**
- Delete: `bin/render-explainer.py`, `docs/render-comparison.py`, `docs/render-infrastructure.py`, `docs/render-demo-video.py`, `assets/explainer.png`, `docs/heimdall-comparison.png`, `docs/heimdall-infrastructure.png`, `docs/heimdall-demo.mp4`, `kernels`
- Keep: `bin/render-demo.py`, `demo.tape`, `assets/demo.gif`, `docs/heimdall_compare.dot`, `docs/heimdall_compare.png` — these stay because they have live readers (`README.md:287`, `AGENTS.md:44`). Delete only the four zero-reader sibling render generators and the proven-orphan outputs; do not touch the live renderer or its assets.

**Interfaces:**
- Consumes: nothing from other lanes (owns no doc text)
- Produces: asset/symlink deletions only; README/AGENTS text reconciliation is E2's job, not E1's

- [ ] **Step 1: Caller proof per artifact (readers, not generators)**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e1
for a in explainer.png heimdall-comparison heimdall-infrastructure heimdall-demo.mp4; do
  echo "== $a"
  rg --no-ignore -n "$a" bin extensions tests bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md package.json launchd config demo.tape .github | rg -v '^docs/superpowers/|^bench/(runs|data)/'
done
rg --no-ignore -n "render-explainer|render-comparison|render-infrastructure|render-demo-video" bin extensions tests bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github package.json
rg --no-ignore -n "\bkernels\b" bin extensions tests docs README.md AGENTS.md CHANGELOG.md mise.toml .github package.json launchd config
```

Expected: each asset name appears only inside its own generator script (`bin/render-explainer.py:158`, `docs/render-comparison.py:109`, `docs/render-infrastructure.py:186`, `docs/render-demo-video.py:160`); each generator name appears nowhere else; `kernels` matches no repository path reference (only unrelated prose inside `bench/runs/**`, excluded). Enumerate every hit and classify `keep | rewrite | delete`. Naming trap: `docs/heimdall_compare.{dot,png}` (underscore, live, referenced by `README.md:287` and `AGENTS.md:44`) is a **different** file from `docs/heimdall-comparison.png` (hyphen, orphan). Any reader hit — a live execution/dynamic/package consumer — ⇒ STOP for that artifact only.

- [ ] **Step 2: Scan for `examples/` (scope check)**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e1
git ls-files 'examples/*' | wc -l
ls -d examples 2>/dev/null || echo "no examples/ directory"
```

If no `examples/` directory or no tracked files under it exist, record the approved "obsolete examples" scope item as **vacuous** in the lane report (nothing to delete). Do not create or delete anything based on this check.

- [ ] **Step 3: Delete the orphans and the dangling symlink**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e1
git rm bin/render-explainer.py docs/render-comparison.py docs/render-infrastructure.py docs/render-demo-video.py \
       assets/explainer.png docs/heimdall-comparison.png docs/heimdall-infrastructure.png docs/heimdall-demo.mp4
git rm kernels
```

`kernels` is a tracked symlink to `/tmp/llama.cpp/build/bin/kernels` (verified dangling). `git rm` removes the link only; never `rm -rf` the `/tmp` target.

- [ ] **Step 4: Verify**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e1
git ls-files -s kernels            # expect empty
test ! -e kernels && echo "symlink gone"
rg --no-ignore -n "explainer\.png|heimdall-comparison|heimdall-infrastructure|heimdall-demo\.mp4" bin extensions tests docs README.md AGENTS.md package.json | rg -v '^docs/superpowers/' && echo "0 refs"
test -f assets/demo.gif && test -f docs/heimdall_compare.png && test -f bin/render-demo.py && test -f docs/heimdall_compare.dot && echo "live assets intact"
npm test
git diff --check
```

Expected: `symlink gone`; `0 refs`; `live assets intact`; `npm test` pass / 0 failures (this includes `tests/npm-pack-contents.test.mjs`, which repacks the tree).

- [ ] **Step 5: Commit**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e1
git commit -m "refactor(e1): delete orphan render outputs/generators and dangling kernels symlink"
```

---

### Task 7: Lane E2 — package, ignore, and AGENTS reconciliation (serialized final reconciliation)

**Files:**
- Modify: `package.json`, `.gitignore`, `AGENTS.md`

**Interfaces:**
- Consumes: merged deletions from B1 (Rust + `mise.toml`/docs), B2, B3, E1, C, D
- Produces: manifests that reference only paths that still exist; `npm pack` contents with no deleted path

- [ ] **Step 1: Rebase E2 on the merged integration tip and re-scan**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e2
git rebase bloat/integration
rg -n "target/|rs/heimdall-embed|Cargo|render-explainer|render-comparison|render-infrastructure|render-demo-video|kb-verify\.sh|tier\.mjs|agent-memory|kb-guard-core" package.json .gitignore AGENTS.md
```

Record every hit for Steps 2-4. Expected hits: `.gitignore` `target/` and `rs/heimdall-embed/model/` blocks; possibly AGENTS.md rows naming deleted files.

- [ ] **Step 2: `.gitignore` cleanup (single writer for this file)**

Delete the now-pointless blocks: the `# rust build artifacts` + `target/` pair and the `# exported ONNX model — regenerate with rs/heimdall-embed/export_onnx.py` + `rs/heimdall-embed/model/` pair (both covered paths no longer exist). Keep every other rule (`vendor/graft/**` ignores are still live, `/graft/`, `*.tgz`, `.pi-subagents/`, `node_modules/`). Removing an ignore rule is a repository change only — never delete the ignored files those rules cover.

- [ ] **Step 3: `package.json` `files[]` reconciliation**

For each remaining `files` entry (including negations), verify it still matches something shipped:

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e2
git ls-files | rg '^(bin|extensions|docs|assets|bin/lib)/' | head -50
npm pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s)[0];console.log(j.files.map(f=>f.path).join("\n"))})'
```

Check each entry against both the tracked-file list and the pack entry list. Keep `!bin/render-demo.py` (its target is intentionally kept and intentionally unpacked). Remove an entry only if the path it protects no longer exists anywhere in the tree; if nothing needs removing, record `files[] unchanged: all entries still match existing paths` in the commit body. Also confirm `extensions/lib/kb-guard-core.mjs` still ships (lane C made the extension import it at runtime).

- [ ] **Step 4: `AGENTS.md` reconciliation**

Update only the rows/mentions that name a path deleted by this plan (scan output from Step 1). Leave the structure map's live rows alone; do not renumber or restructure the document.

- [ ] **Step 5: Verify package contents and gates**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e2
npm pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s)[0];const bad=j.files.map(f=>f.path).filter(p=>/^(rs\/|kernels$|docs\/render-|docs\/heimdall-(comparison|infrastructure|demo)|bin\/render-explainer\.py$|assets\/explainer\.png$)/.test(p));console.log(bad.length?("UNEXPECTED: "+bad.join(",")):"pack clean")})'
npm test
npm run typecheck
git diff --check
```

Expected: `pack clean`; pass / 0 failures; typecheck silent; diff check silent.

- [ ] **Step 6: Commit**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e2
git add package.json .gitignore AGENTS.md
git commit -m "chore(e2): reconcile package files, ignores, and AGENTS map with deletions"
```

- [ ] **Step 7: Mandatory post-D reconciliation pass (if any lane added or removed a file after Step 5)**

E2 is the serialized final reconciliation for **every** lane that adds or removes files, including C and D. If `bloat/c-guard-dedup` or `bloat/d-hotspots` was merged after Step 5 ran, re-run Steps 1-6 on the new integration tip and commit the follow-up with the same message plus a body line naming the lanes reconciled. Confirm at the final integrated SHA that:

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e2
npm pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s)[0];console.log(JSON.stringify({entryCount:j.entryCount,size:j.size,unpackedSize:j.unpackedSize}))})'
git ls-files | rg '^(bin|extensions|docs|assets)/' | wc -l
```

Expected: no deleted path in the pack list, `files[]`/`.gitignore`/`AGENTS.md` consistent with the final tree, and (when lane C landed) `extensions/lib/kb-guard-core.mjs` present in the pack entry list. Record the SHA this pass ran against.

---

### Task 8: Lane C — guard dedup, gated on characterized vocabulary/escalation/reset

**Files:**
- Modify: `extensions/kb-search-guard.ts`, `extensions/lib/kb-guard-core.mjs`, `tests/guard.test.mjs`
- Optionally delete: `extensions/lib/kb-guard-core.d.mts` (only if typecheck still passes without it)

**Interfaces:**
- Consumes: existing `tests/guard.test.mjs` suite
- Produces: one owner of the guard decision logic (the `kb-guard-core` module), extension behavior byte-identical on the characterized surface

- [ ] **Step 1: Map the duplication before touching anything**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-c
rg -n "^export |^function |^const [A-Za-z_]+ =|TOOL|ESCALAT|PAUSE|WARN|BLOCK" extensions/lib/kb-guard-core.mjs
rg -n "^import |^function |^const [A-Za-z_]+ =|TOOL|ESCALAT|PAUSE|WARN|BLOCK|kb-guard-core" extensions/kb-search-guard.ts
```

Record the decision logic present in **both** files (state machine, thresholds, tool-name sets). If the two files share no decision logic (only types/config), close the lane with `no cut: no shared decision logic` and skip Steps 3-5 — that is an allowed outcome.

- [ ] **Step 2: Characterize the current behavior (sensitivity-proven)**

Append to `tests/guard.test.mjs` three tests against `extensions/lib/kb-guard-core.mjs` exports:

- (a) tool vocabulary — the exact set of tool names the guard treats as memory/search tools and the set it treats as discovery actions;
- (b) escalation ladder — the number of consecutive unscoped discovery actions before warning and before escalation/block, asserted as exact integers;
- (c) reset semantics — counter resets on a memory-tool action and `kb_guard_pause` suspends enforcement for its clamp range (1-20 turns) and resumes from a clean slate on expiry.

Assert the exact strings/numbers read from the module (not restated from prose).

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-c
node --test tests/guard.test.mjs          # expect PASS
```

Then prove sensitivity: temporarily flip one asserted constant (e.g. the warn threshold `3` → `2`) in the test, run, record the failure output as the RED proof, restore the constant, run again.

Expected: PASS (baseline), one recorded failure while flipped, PASS again after restore.

- [ ] **Step 3: Dedup (only if Step 1 found shared decision logic)**

Replace the duplicated block in `extensions/kb-search-guard.ts` with an import of the same symbols from `./lib/kb-guard-core.mjs` and delete the duplicate block. Compute `wc -l` for both files before (`git show bloat/c-guard-dedup:extensions/kb-search-guard.ts | wc -l` and the core file) and after; the sum must be **net-negative**. If net-negative fails, revert (`git checkout -- .`) and close the lane with a skip report.

- [ ] **Step 4: Import/deployment safety check**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-c
node --test tests/guard.test.mjs
npm test
npm run typecheck
npm pack --dry-run --json | rg -c '"path": "extensions/lib/kb-guard-core.mjs"'
```

Expected: guard tests PASS with identical assertions to Step 2; full suite 0 failures; typecheck silent; pack count ≥1 (the module the extension now imports at runtime ships in the tarball — `files[]` includes `extensions/`). If pack count is 0 or typecheck fails, revert and skip.

- [ ] **Step 5: Delete the hand-written `.d.mts` only if it is no longer needed**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-c
git rm extensions/lib/kb-guard-core.d.mts
npm run typecheck
```

If typecheck then fails (the `.mjs` import loses its types), restore with `git checkout -- extensions/lib/kb-guard-core.d.mts` and keep it; record the outcome either way.

- [ ] **Step 6: Commit or skip-report**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-c
git add -A extensions tests/guard.test.mjs
git commit -m "refactor(c): single owner for guard decision logic"
```

If the lane skipped, commit nothing and report `lane C skipped: <one-line reason>` with the Step 1/Step 3 evidence.

---

### Task 9: Lane D — caller-mapped hotspot audits (start after A2 freezes its sweep list; skip unless net-negative)

**Files (audit scope, edit only with per-cut proof):** `bin/lib/setup.mjs`, `bin/lib/cli-main.mjs`, `bin/lib/journal.mjs`, `bin/kb-search.sh`, `bin/lib/graft-build.mjs`, `bin/lib/adapters.mjs`, `bin/lib/reconcile.mjs`

**Interfaces:**
- Consumes: lane A2's frozen sweep target list, which must exclude every D-owned file (lane D is their single writer; A2 and D are not concurrent)
- Produces: per-file verdict `cut (<n> maintained lines)` or `skip (<reason>)`

- [ ] **Step 0: Confirm the A2 frozen sweep list excludes all D-owned files**

Do not start lane D until lane A2's report contains the frozen sweep target list from Task 2 Step 5. Verify that list names none of the seven D-owned files above. If any D-owned file appears in A2's sweep, A2 must exclude it before D starts; otherwise STOP and replan.

- [ ] **Step 1: Symbol inventory per file**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-d
for f in bin/lib/setup.mjs bin/lib/cli-main.mjs bin/lib/journal.mjs bin/lib/graft-build.mjs bin/lib/adapters.mjs bin/lib/reconcile.mjs; do
  echo "== $f"
  rg -n "^(export )?(async )?function [A-Za-z_]+|^export const [A-Za-z_]+|^const [A-Z_]+ =" "$f"
done
rg -n "^[a-zA-Z_]+\(\)|^[A-Z_]+=" bin/kb-search.sh
```

- [ ] **Step 2: Caller-map every candidate; cut only zero-caller blocks or duplicate-inline replacements**

For each printed symbol run the Global Constraints caller scan and apply the zero-live-consumer proof with keep/rewrite/delete classification. A symbol is cuttable only when it has zero callers outside its own file and outside `docs/superpowers/**`, **or** when an inline copy of an existing sibling helper can be replaced by calling that helper (then the helper's own tests must already cover it). Anything requiring new abstraction, new files, renamed exports, or a signature change is out of scope by spec.

- [ ] **Step 3: Apply the cuts (if any) and measure**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-d
wc -l bin/lib/setup.mjs bin/lib/cli-main.mjs bin/lib/journal.mjs bin/kb-search.sh bin/lib/graft-build.mjs bin/lib/adapters.mjs bin/lib/reconcile.mjs
```

Record before/after totals. **Skip rule: if a file's total maintained LOC did not go down, revert that file (`git checkout -- <file>`) and record `skip`.** Never trade a deletion for new code.

- [ ] **Step 4: Semantics-preserving tests for every touched file**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-d
node --test tests/setup.test.mjs tests/init.test.mjs tests/init-e2e.test.mjs tests/e2e-fixture.test.mjs \
              tests/cli-contract.test.mjs tests/reconcile.test.mjs tests/edge-matrix.test.mjs \
              tests/c11-observability.test.mjs tests/insert-retention.test.mjs tests/facts.test.mjs \
              tests/fact-history.test.mjs tests/health-score.test.mjs tests/graft-build.test.mjs \
              tests/graftd-binary.test.mjs tests/adapters.test.mjs tests/kb-search.test.mjs \
              tests/kb-search-identity.test.mjs
bash -n bin/kb-search.sh
git diff --check
```

Expected: all suites pass 0 failures for the files touched; `bash -n` silent; diff check silent. Any behavior change ⇒ treat as a behavior change, not a deletion: write the characterization test first, record RED, then the minimal GREEN edit.

- [ ] **Step 5: Commit per file (one commit per file that actually changed)**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-d
git add bin/lib/<file>
git commit -m "refactor(d): drop zero-caller internals in <file>"
```

If the lane cut nothing, commit nothing and report `lane D: audited 7 hotspots, 0 net-negative cuts` with the per-file skip reasons.

---

### Task 10: Integration — merge lanes in dependency order

**Files:**
- Worktree: `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration`, branch `bloat/integration`

**Interfaces:**
- Consumes: all lane branches
- Produces: one integrated branch with the full deletion set

- [ ] **Step 1: Confirm base and lane tips**

```bash
BASE=c16b91f8b57408266f7f7116a4e1f5b922a32e21
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
git rev-parse HEAD                       # expect base or current integration tip
git log --oneline --no-decorate bloat/a1-verify-dead-path bloat/a2-dead-exports bloat/b1-rust-workspace bloat/b2-agent-tier bloat/b3-kb-verify bloat/e1-orphans bloat/c-guard-dedup bloat/d-hotspots --not "$BASE" | wc -l
```

- [ ] **Step 2: Merge in order, checking after each**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
for b in a1-verify-dead-path a2-dead-exports b1-rust-workspace b2-agent-tier b3-kb-verify e1-orphans; do
  if git merge --no-ff "bloat/$b" -m "merge(bloat): $b"; then
    git diff --check || echo "whitespace error after $b"
  else
    echo "CONFLICT in $b — fix in its own worktree, never in integration"
    break
  fi
done
```

Then rebase lane E2 onto the integration tip (Task 7 Step 1), merge `bloat/e2-manifests`, then `bloat/c-guard-dedup`, then `bloat/d-hotspots` with the same loop, and run Task 7's post-D reconciliation pass.

Expected: each merge fast/simple (disjoint file sets make conflicts unexpected); any conflict ⇒ stop, fix in the lane's own worktree, re-run that lane's focused tests, re-merge.

- [ ] **Step 3: Full gates on the integrated tree**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
npm pack --dry-run
npm test
npm run typecheck
git diff --check
```

Expected: pack lists no deleted path; suite pass / 0 failures; typecheck silent; diff check silent.

- [ ] **Step 4: Commit**

Merges are the commits (`merge(bloat): <lane>`); no extra commit unless a merge conflict resolution produced one.

---

### Task 11: Final consumer, package, dynamic, and template checks

**Files:** none (read-only checks; fixes, if any, go back to the owning lane)

**Interfaces:**
- Consumes: the frozen integration SHA
- Produces: recorded evidence that no consumer of a deleted artifact remains

- [ ] **Step 1: Whole-repo consumer scan**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
rg --no-ignore -n "claudeHooksFragment|assetsDir|resolveTier|agentExtract|kb-verify\.sh|kbverify_insert_probe|kb_search_verify\.py|heimdall-embed|heimdall-search|export_onnx|render-explainer|render-comparison|render-infrastructure|render-demo-video|heimdall-comparison|heimdall-infrastructure|explainer\.png|heimdall-demo\.mp4|\bkernels\b" bin extensions tests types docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml .github package.json launchd config demo.tape | rg -v '^docs/superpowers/|^bench/(runs|data)/' && echo "0 live refs"
```

Expected: `0 live refs` (historical specs/plans and bench corpora excluded by construction).

- [ ] **Step 2: Template and dynamic-consumer checks**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
BASE=c16b91f8b57408266f7f7116a4e1f5b922a32e21
rg -n "HeimdallPlugin" bin docs extensions tests | wc -l
git show "$BASE:bin/lib/adapters.mjs" | rg -c HeimdallPlugin
node bin/heimdall.js --help
node bin/heimdall.js doctor || echo "daemon absent — doctor SKIPPED (record as not-verified, not as pass)"
for s in bin/*.sh; do bash -n "$s" || echo "syntax error: $s"; done
for p in bin/*.py bin/lib/*.py; do python3 -m py_compile "$p" || echo "compile error: $p"; done
```

Expected: template-emitted `HeimdallPlugin` text still present (it is live, not dead code); `--help` prints usage; `doctor` either passes or is recorded as skipped; every shell/python file syntax-clean.

- [ ] **Step 3: Package-content assertion**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
npm pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s)[0];console.log(JSON.stringify({entryCount:j.entryCount,size:j.size,unpackedSize:j.unpackedSize}))})'
```

- [ ] **Step 4: Implicated Python/benchmark tests**

`bench/**` is untouched by every lane, so bench tests are not implicated; record exactly that sentence plus `git diff $BASE..HEAD --name-only | rg '^(bench|bin/.*\.py)'` output (expected: only `bin/kb_search_verify.py`, no `bench/`), and run `python3 -m pytest bench/tests -x -q` only if that output shows a `bench/` path.

- [ ] **Step 5: Commit**

No commit in this task; checks are evidence for Tasks 13 and 14.

---

### Task 12: Before/after metrics with identical commands

**Files:**
- Read: `~/.pi/worktrees/heimdall-bloat-baseline.txt`

**Interfaces:**
- Consumes: Task 0 Step 3's command block
- Produces: the report table (run output + final commit body; no new tracked file)

- [ ] **Step 1: Re-run Task 0 Step 3 verbatim on the integrated tree**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
# Re-run the exact M1-M9 command block from Task 0 Step 3 (same wc|rg -v '\btotal$'|awk sums,
# same exclusion regex, same maintained-LOC boundary) and diff its numbers against
# ~/.pi/worktrees/heimdall-bloat-baseline.txt.
```

Expected relationships (any violation is a finding, not a rounding note): `M1/M2/M3/M4/M5/M6` all decrease; `M7.entryCount` decreases by the number of previously shipped files now deleted (B1 ships nothing → only E1/B3-style files inside `bin/`/`docs/` count, plus `bin/render-explainer.py`); `M7.size`/`unpackedSize` decrease; `M8.runtime` stays `0`, `M8.dev` unchanged; `M9` decreases only by the tests the deleted suites actually contained (Task 1, Task 4, Task 5 counted from their files, not from a hardcoded figure). Both M4 values must also satisfy `M4 < M3`.

- [ ] **Step 2: Per-lane deletion accounting**

```bash
BASE=c16b91f8b57408266f7f7116a4e1f5b922a32e21
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
for b in a1-verify-dead-path a2-dead-exports b1-rust-workspace b2-agent-tier b3-kb-verify e1-orphans c-guard-dedup d-hotspots e2-manifests; do
  printf '%-24s %s\n' "$b" "$(git diff --shortstat "$BASE..bloat/$b")"
done
git diff --shortstat "$BASE..HEAD"
```

- [ ] **Step 3: Keep the measures separated**

Report maintained handwritten LOC (M5 boundary: `git ls-files 'bin/*' 'extensions/*'`, re-run verbatim after integration), tests LOC (M6) separately, generated text lines (M3−M4 bucket: vendor + lockfiles + model artifacts), vendored lines (`git ls-files 'vendor/*' | tr '\n' '\0' | xargs -0 wc -l | rg -v '\btotal$' | awk '{s+=$1} END {print s}'`), tracked files (M1), tracked bytes (M2), dependency counts (M8), npm package contents/bytes (M7), deletions by lane (Step 2). Never count ignored local-disk cleanup (`bench/runs`, `bench/data`, `target`, vendored builds/models) as improvement.

- [ ] **Step 4: Commit**

Metrics are reported, not committed as a file. No commit.

---

### Task 13: Three independent adversarial review passes

**Files:** none new; fixes land in the owning lane worktree, then re-merge into integration

**Interfaces:**
- Consumes: raw evidence only — `git diff $BASE..HEAD`, `git status --porcelain`, the Task 10/11 command outputs, `npm pack --json`, `~/.pi/worktrees/heimdall-bloat-baseline.txt`
- Produces: per-pass findings list with severities (`HIGH` / `MEDIUM` / `LOW` per the Global Constraints scale); zero open HIGH at completion

- [ ] **Step 1: Pass 1 — fresh adversarial reviewer on the integrated diff**

Dispatch a fresh `chain/deepseek-v4.1-flash` reviewer with: base SHA, integration SHA, `git diff c16b91f8b57408266f7f7116a4e1f5b922a32e21..HEAD`, Task 11 outputs, Task 12 outputs. Brief: find unjustified dependency, dead path, duplicate owner, layer violation, missed live consumer, packaging omission, invariant break. **Never include another reviewer's verdict or reasoning.**

- [ ] **Step 2: Fix any HIGH or accepted MEDIUM findings from Pass 1, then re-run enabled gates**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
node --test tests/
npm test
npm run typecheck
git diff --check
git commit -m "fix(bloat): address review pass 1 <finding>"
```

- [ ] **Step 3: Pass 2 — fresh reviewer, same raw evidence plus Pass 1's fix commit diff**

Independent session; pass no reference to Pass 1 conclusions. Fix HIGH and accepted MEDIUM findings as in Step 2, commit `fix(bloat): address review pass 2 <finding>`.

- [ ] **Step 4: Pass 3 — fresh reviewer, same rules; then verify zero open findings**

If Pass 3 raises HIGH findings, fix and re-run a fresh pass (a replacement pass, not a reuse) until a pass returns none. Record each pass: reviewer model, evidence refs, findings with severity, resolution.

- [ ] **Step 5: Commit**

Review-fix commits only; no summary commit.

---

### Task 14: Final locked verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: the frozen final SHA and the review dispositions from Task 13
- Produces: the completion report (SHA, deletion table, metrics, review disposition, rollback path)

- [ ] **Step 1: Freeze and record the final SHA**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
git rev-parse HEAD           # record as FINAL_SHA
git status --porcelain       # expect empty; nothing uncommitted
git worktree list            # lane worktrees may stay
```

- [ ] **Step 2: Re-run every gate on the frozen SHA with no further commits**

```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
npm pack --dry-run
npm test
npm run typecheck
bash bin/kb-health.sh || echo "health SKIPPED (daemon state) — record as not-verified"
git diff --check
```

Expected: pack clean; suite pass / 0 failures; typecheck silent; `git diff --check` silent; health either green or explicitly recorded as not-verified.

- [ ] **Step 3: Produce the completion report**

Include: FINAL_SHA, base SHA, per-file deletion list grouped by lane, the before/after metric table (maintained / tests / generated / vendor / local-disk separated, using freshly captured plan-base numbers rather than the older spec baseline), npm pack before/after, dependency counts, the three review-pass dispositions (zero open HIGH), and a `coverage: verified / checked-fine / not-checked` line naming `bin/kb-health.sh` and `heimdall doctor` if they were skipped.

- [ ] **Step 4: Rollback path (do not execute unless required)**

No destructive reset is part of this plan. The supported escapes are: (a) revert commits with `git revert <sha>` at commit granularity (integration is an isolated branch, nothing pushed), or (b) discard the isolated unmerged worktree with `git worktree remove <path>` when its branch was never merged. Any destructive history or reset operation — including `git reset --hard` — requires explicit user approval. Nothing is pushed, merged to `main`, released, or published; push/merge/release/publish are ask-first gates.

---

## Self-Review Record

- **Spec coverage:** kb_search_verify dead path (Task 1); enforcement-rules/facts-cli/zero-caller sweep (Task 2 + Task 9); Rust workspace (Task 3); agent tier (Task 4); `kb-verify.sh` (Task 5); `kernels` symlink + zero-reader generators + orphan images/video (Task 6) + vacuous `examples/` scope item (Task 6 Step 2); guard duplication gated on characterization (Task 8); hotspots with net-negative skip rule (Task 9); package/ignore/docs reconciliation (Tasks 3, 4, 7); final consumer checks (Task 11); dead-verifier tier/kb-verify tests covered in Tasks 4/5; metrics separation (Task 12); three review passes (Task 13); locked verification (Task 14).
- **Placeholder scan:** no TBD/TODO/"implement later"; every deletion cites the exact scan command and the exact stop condition.
- **Path/name consistency:** lane worktrees use absolute `/Users/arihantdeva/.pi/worktrees/heimdall-bloat-<lane>`; branches `bloat/<lane>`; base SHA `c16b91f8b57408266f7f7116a4e1f5b922a32e21` is defined inline in every command block that needs it.
- **Command independence:** every standalone command block re-establishes its own directory and `BASE`, or spells the literal SHA; no block depends on shell state from an earlier step.
- **No contradiction between maximal deletion and the invariants;** no promise to delete a candidate whose final caller check fails; no local-cache bytes counted.
