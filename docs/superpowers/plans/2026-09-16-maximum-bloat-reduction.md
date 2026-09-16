# Maximum Bloat Reduction Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
**Goal:** Delete every evidence-backed unused slice of the Heimdall repository — dead internals, approved dormant capabilities, orphan assets/generators, a dangling symlink, redundant manifests — and reconcile package/docs, ending with a reproducible before/after reduction report and zero open high-severity review findings.
**Architecture:** Six isolated worktrees (exactly one writer each) cut disjoint file sets from base `c16b91f8b57408266f7f7116a4e1f5b922a32e21`. Every deletion re-runs its caller/package scans at the lane's current SHA and is deleted only on zero live hits
 every behavior-affecting change gets a sensitivity-proven characterization test first. Lanes merge in dependency order behind focused checks, then full gates, then three independent adversarial review passes on raw evidence only.
**Tech Stack:** Node ≥22.5 (`node --test`, zero runtime deps), ESM `.mjs` libraries, Bash scripts, Python 3 helpers, TypeScript Pi extensions, npm pack, git worktrees.
**Spec:** `docs/superpowers/specs/2026-09-16-maximum-bloat-reduction-design.md` (sha256 `4042921f0fbac019bdc94ada319e418f8425a81dc39839206252599839c33e55`).;## Global Constraints
- Base SHA: `c16b91f8b57408266f7f7116a4e1f5b922a32e21`. Before any write in any worktree: `git rev-parse HEAD` equals the base (or the lane's own branch tip) and `git status --porcelain` is empty. HEAD moved unexpectedly ⇒ stop and report
 do not rebase silently.
- One writer per worktree, worktrees under `/Users/arihantdeva/.pi/worktrees/`, branches `bloat/<lane>`. Never touch the stale dirty worktree `heimdall-c11`, never write in `/Users/arihantdeva/Repos/heimdall` beyond nothing (all lane work happens in worktrees).
- Runtime dependencies stay `0`. Dev-dependency count must not increase.
- Caller proof is mandatory for deletion: `rg --no-ignore -n "<symbol-or-path>" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md package.json mise.toml .github config launchd demo.tape` — zero hits outside the defining file (and outside `docs/superpowers/**` historical records). Any live hit ⇒ STOP, report, replan (spec invariant).
- Behavior/format change ⇒ smallest characterization test written first, with the intended failure recorded (for a characterization test, sensitivity proof by flipping one asserted constant, see Task 8
 for a real behavior change, a genuine RED). Pure deletion of unreachable code ⇒ no invented tests, existing focused/full tests are the gate.
- Every lane: relevant focused tests + `git diff --check` + its own commit. Integration alone runs `npm pack`, `npm test`, `npm run typecheck`.;- Ask-first gates (from spec): deleting a newly discovered public/documented capability outside the approved Rust / agent-tier / `kb-verify.sh` groups
 deleting untracked files or user data
 deployed machine or config changes
 push, merge, release, publish
 destructive history operations.;- Never count ignored local-disk cleanup (`bench/runs`, `bench/data`, `target`, `vendor/**/build`, vendored models) as repository reduction.
- Untouched-by-this-plan personality: `vendor/graft/**`, `vendor/graphify/**`, `assets/demo.gif`, `demo.tape`, `bin/render-demo.py`, `docs/heimdall_compare.dot`, `docs/heimdall_compare.png`, template-emitted `HeimdallPlugin` text, `bin/kb-stale-scan.py` behavior (import of `extract_paths` preserved), `bin/embed-index.py`, `bin/embed_walker.py`, `bin/heimdall.js`, `bin/heimdall-reconciler.mjs`, `bin/heimdall-hook.mjs`, `bin/seed-graft.sh`, `bin/sync-edits.sh`, `bin/telemetry.sh`, `bin/postinstall.mjs`, all `bench/*.py` and `bench/tests/**`, `config/heimdall.yaml.example` except Task 4's `memory.tier` removal.
---;## Lane Map (ownership is exclusive; no two lanes edit the same file);| Lane | Worktree / branch | Owns these files only | Depends on |;|---|---|---|---|
| A1 | `.pi/worktrees/heimdall-bloat-a1` / `bloat/a1-verify-dead-path` | `bin/kb_search_verify.py`, `tests/kb-verify.test.mjs` | — |
| A2 | `.pi/worktrees/heimdall-bloat-a2` / `bloat/a2-dead-exports` | `bin/lib/enforcement-rules.mjs`, `bin/lib/facts-cli.mjs`, plus zero-caller sweep over `bin/lib/depth.mjs`, `bin/lib/sink.mjs`, `bin/lib/hints.mjs`, `bin/lib/extract.mjs`, `bin/lib/lock.mjs`, `bin/lib/facts.mjs`, `bin/lib/health-score.mjs`, `bin/lib/index-bootstrap.mjs`, `bin/lib/ingest-email.mjs`, `bin/lib/mcp-server.mjs` | — |
| B1 | `.pi/worktrees/heimdall-bloat-b1` / `bloat/b1-rust-workspace` | `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, `rs/**`, `mise.toml`, `README.md`, `docs/setup.md`, `CHANGELOG.md` | — |
| B2 | `.pi/worktrees/heimdall-bloat-b2` / `bloat/b2-agent-tier` | `bin/lib/tier.mjs`, `bin/lib/agent-memory.mjs`, `tests/tier.test.mjs`, `config/heimdall.yaml.example`, `docs/adapters.md` | — |
| B3 | `.pi/worktrees/heimdall-bloat-b3` / `bloat/b3-kb-verify` | `bin/kb-verify.sh`, `tests/kbverify_insert_probe.py` | — |
| E1 | `.pi/worktrees/heimdall-bloat-e1` / `bloat/e1-orphans` | `bin/render-explainer.py`, `docs/render-comparison.py`, `docs/render-infrastructure.py`, `docs/render-demo-video.py`, `assets/explainer.png`, `docs/heimdall-comparison.png`, `docs/heimdall-infrastructure.png`, `docs/heimdall-demo.mp4`, `kernels` | — |;| E2 | `.pi/worktrees/heimdall-bloat-e2` / `bloat/e2-manifests` | `package.json`, `.gitignore`, `AGENTS.md` | B1, B2, B3, E1 merged |
| C | `.pi/worktrees/heimdall-bloat-c` / `bloat/c-guard-dedup` | `extensions/kb-search-guard.ts`, `extensions/lib/kb-guard-core.mjs`, `extensions/lib/kb-guard-core.d.mts`, `tests/guard.test.mjs` | — |
| D | `.pi/worktrees/heimdall-bloat-d` / `bloat/d-hotspots` | `bin/lib/setup.mjs`, `bin/lib/cli-main.mjs`, `bin/lib/journal.mjs`, `bin/kb-search.sh`, `bin/lib/graft-build.mjs`, `bin/lib/adapters.mjs`, `bin/lib/reconcile.mjs` | A2 merged (sweep must not pick a D-owned file) |
Lanes A1, A2, B1, B2, B3, E1, C, D may run concurrently. E2 runs after B1/B2/B3/E1 are merged. Integration order: **A1 → A2 → B1 → B2 → B3 → E1 → E2 → C → D**.
---
### Task 0: Baseline capture and worktree creation
**Files:**
- Create (outside the repo): `~/.pi/worktrees/heimdall-bloat-baseline.txt`
- Create: the nine worktrees in the lane map
**Interfaces:**
- Consumes: base SHA `c16b91f8b57408266f7f7116a4e1f5b922a32e21`
- Produces: baseline metric file whose command set Task 12 re-runs verbatim
- [ ] **Step 1: Verify the base and cleanliness**
```bash
cd /Users/arihantdeva/Repos/heimdall
git rev-parse HEAD        # expect c16b91f8b57408266f7f7116a4e1f5b922a32e21
git status --porcelain    # expect empty
```
- [ ] **Step 2: Capture the baseline with the exact metric commands**
```bash
BASE=c16b91f8b57408266f7f7116a4e1f5b922a32e21
{
  echo "M1 tracked_files: $(git ls-files | wc -l | tr -d ' ')"
  echo "M2 tracked_bytes: $(git ls-files -z | xargs -0 wc -c | tail -1 | awk '{print $1}')"
  echo "M3 tracked_lines: $(git ls-files -z | xargs -0 wc -l | tail -1 | awk '{print $1}')"
  echo "M4 lines_ex_vendor_generated_lock: $(git ls-files  | rg --no-ignore -v '^(vendor/ | rs/heimdall-embed/model/ | package-lock\.json$ | Cargo\.lock$ | bench/runs/ | bench/data/)'  |  tr '\n' '\0'  |  xargs -0 wc -l  |  tail -1  |  awk '{print $1}')"
  echo "M5 maintained_source_lines: $(git ls-files 'bin/*' 'extensions/*' | tr '\n' '\0' | xargs -0 wc -l | tail -1 | awk '{print $1}')"
  echo "M6 tests_lines: $(git ls-files 'tests/*' | tr '\n' '\0' | xargs -0 wc -l | tail -1 | awk '{print $1}')"
  echo "M7 npm_pack: $(npm pack --dry-run --json | node -e 'let s=""
process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s)[0]
console.log(JSON.stringify({entryCount:j.entryCount,size:j.size,unpackedSize:j.unpackedSize}))})')"
  echo "M8 deps: $(node -e 'const p=require("./package.json")
console.log(JSON.stringify({runtime:Object.keys(p.dependencies
{}).length,dev:Object.keys(p.devDependencies
{}).length}))')"
  echo "M9 test_count: $(npm test 2>&1 | rg -o '^# pass [0-9]+' | tail -1)"
} | tee ~/.pi/worktrees/heimdall-bloat-baseline.txt
```
Expected: every line prints a number/JSON
 `M8` shows `{"runtime":0,"dev":3}` (spec table says 4 dev deps at the older base — record the live value, never the spec's). `M1` ≈ 326.
- [ ] **Step 3: Create the lane worktrees**
```bash
cd /Users/arihantdeva/Repos/heimdall
for l in a1-verify-dead-path a2-dead-exports b1-rust-workspace b2-agent-tier b3-kb-verify e1-orphans e2-manifests c-guard-dedup d-hotspots
 do
  git worktree add -b "bloat/$l" "/Users/arihantdeva/.pi/worktrees/heimdall-bloat-${l%%-*}" "$BASE"
  done
git worktree add -b bloat/integration /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration "$BASE";```;Expected: ten worktrees reported
 `git worktree list` shows them; the main tree stays clean on its original branch.||- [ ] **Step 4: Commit**||No commit. Task 0 is measurement plus worktree setup only (worktrees are not repository content).
---
### Task 1: Lane A1 — delete the dead `kb_search_verify.py` execution path
**Files:**
- Modify: `bin/kb_search_verify.py`
- Modify: `tests/kb-verify.test.mjs`;**Interfaces:**
- Consumes: `bin/kb-stale-scan.py:20` `from kb_search_verify import extract_paths` (keep this import working)
- Produces: module `kb_search_verify` exporting `extract_paths(text) -> list[str]` and nothing else required
- [ ] **Step 1: Re-run the caller scan at the lane SHA (proof the CLI path is dead)**
```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a1
rg --no-ignore -n "kb_search_verify" bin extensions tests bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github package.json launchd demo.tape | rg -v '^docs/superpowers/';```
Expected: only `bin/kb-stale-scan.py` (import of `extract_paths`), `tests/kb-verify.test.mjs` (import of `extract_paths`), and two comments (`bin/lib/health-score.mjs`, `bin/lib/cli-main.mjs`) that describe `kb-stale-scan.py`. **No execution of the script itself anywhere.** Any invocation hit ⇒ STOP.
- [ ] **Step 2: Delete the dead path in `bin/kb_search_verify.py`**
Rewrite the header docstring to describe the module as "path extraction for stale-node rehoming", then delete, in one edit:
- `STOP` set and `toks()` (lines ~9-19) — used only by `main()`.
- `get_node()` (lines ~22-39) — used only by `main()`.
- `GRAFT` (lines ~52-54) — used only by `get_node()`/`handle_stale()`.;- `handle_stale()` (lines ~103-142).;- `freshness_token()` (lines ~145-166) — and with it the `sqlite3` import.
- `content_score()` (lines ~169-185).
- `main()` (lines ~188-266) and the `if __name__ == "__main__": main()` tail.
- Narrow the import line `import json, os, re, sqlite3, subprocess, sys, tempfile, time` to `import os, re` (the remaining `extract_paths` uses only `os`, `re`, and module constants).
Keep: `HOME`, `_HOME_ABS`, `HOME_RE`, `extract_paths()` in full (including the brace-group and space-extension logic — it is live).
- [ ] **Step 3: Verify the retained surface works**
```bash
python3 -c "import sys
 sys.path.insert(0,'bin')
 from kb_search_verify import extract_paths
 print(extract_paths('see ~/Desktop/Automation/job-automation/resume_tailoring.py')[:1])"
python3 -c "import sys
 sys.path.insert(0,'bin')
 import kb_search_verify as m
 assert not hasattr(m,'main'), 'dead path survived'"
python3 -m py_compile bin/kb-stale-scan.py
 echo "kb-stale-scan compiles"
```
Expected: a one-element list containing an existing home path
 the `assert` passes
 `py_compile` prints `kb-stale-scan compiles`.
- [ ] **Step 4: Delete the tests that exclusively cover the dead behavior**
In `tests/kb-verify.test.mjs`, delete: the `SCRIPT` constant (line ~15), the `verify()` helper (line ~16-23), the `retrieveJson()` helper (line ~25-27), and every `test(...)` whose body calls `verify(` or `retrieveJson(` (the CLI-driven verdict tests: currently `content mismatch downgrades STRONG even with live path` and `content match upgrades to STRONG` plus the remaining CLI tests below line 40). Keep the test that spawns Python and imports `extract_paths`, and keep the file's imports it still needs.
- [ ] **Step 5: Prove the test file no longer references the CLI and still passes**
```bash
rg -n "SCRIPT|retrieveJson\(|verify\(" tests/kb-verify.test.mjs   # expect no hits
node --test tests/kb-verify.test.mjs
rg -c "^test\(" tests/kb-verify.test.mjs
```
Expected: no hits
 `node --test` reports pass with 0 failures
 the remaining test count is ≥1 (the `extract_paths` test).
- [ ] **Step 6: Commit**
```bash
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
- Produces: `enforcement-rules.mjs` exporting exactly `RULES_VERSION` and `ruleBlock(tool = "kb_search")`; `facts-cli.mjs` stdout contract unchanged (one JSON array line for `--file`, one JSON object for `--dir`);- [ ] **Step 1: Caller-proof the two suspicious exports**;```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a2;rg --no-ignore -n "claudeHooksFragment" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github config launchd package.json;rg --no-ignore -n "assetsDir" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github config launchd package.json;```
Expected: each hit list contains only the definition in `bin/lib/enforcement-rules.mjs`. Any call site ⇒ STOP (do not delete that export).&&- [ ] **Step 2: Delete the two dead exports and their now-unused imports**
In `bin/lib/enforcement-rules.mjs`: delete the `claudeHooksFragment` block (the `/** Claude Code hooks fragment ... */` comment plus its `export const claudeHooksFragment = () => ({...})`) and the `assetsDir` block (its comment plus `export const assetsDir = () => join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets")`), then delete the now-unused header imports `import { dirname, join } from "node:path"
` and `import { fileURLToPath } from "node:url"
` and the module comment sentence that claims adapters embed a per-harness tool mapping beyond `ruleBlock`.;- [ ] **Step 3: Verify the module surface and the adapter contract**;```bash
node -e "import('./bin/lib/enforcement-rules.mjs').then(m=>console.log(Object.keys(m).sort().join(',')))"
node --test tests/adapters.test.mjs tests/adapters-mcp-entry.test.mjs tests/init.test.mjs tests/init-e2e.test.mjs
```
Expected: `RULES_VERSION,ruleBlock`
 all four suites pass with 0 failures (they assert the emitted rules text still contains `heimdall:enforcement` and the `kb_search` vocabulary).
- [ ] **Step 4: Delete the empty statement in `bin/lib/facts-cli.mjs`**
Delete the line `const { } = {}
` (line 24) and its blank-line neighbour so the `// Batch mode:` comment follows `const args` parsing directly. Change nothing else — `facts-cli.mjs` is live (consumed by `bench/ingest.py`).
- [ ] **Step 5: Zero-caller private-internal sweep over the ten named library files**
```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-a2
for f in depth sink hints extract lock facts health-score index-bootstrap ingest-email mcp-server
 do
  echo "== $f"; rg -n "^(export )?(async )?function [A-Za-z_]+|^export const [A-Za-z_]+|^const [A-Z_]+ =" "bin/lib/$f.mjs";done
```
For each symbol printed, run the caller scan from Global Constraints. Delete only symbols with zero callers outside their defining file and outside `docs/superpowers/**`. If a file yields nothing deletable, record `no cut` for it and move on — do not force a cut.
- [ ] **Step 6: Focused tests and commit**
```bash
node --test tests/cli-contract.test.mjs tests/graft-build.test.mjs tests/health-score.test.mjs tests/index-bootstrap.test.mjs tests/ingest-email.test.mjs tests/mcp-server.test.mjs
node bin/lib/facts-cli.mjs --file <(printf 'I prefer SQLite.\n')   # expect one JSON array line, exit 0
git diff --check
git add bin/lib/enforcement-rules.mjs bin/lib/facts-cli.mjs
git commit -m "refactor(a2): drop zero-caller exports and empty statement"
```
Expected: suites pass 0 failures
 the smoke line is one JSON array
 `git diff --check` silent. Commit only from lane A2 and only after Step 5 cuts (if Step 5 cut nothing, still commit Steps 1-4 with the same message).
---
### Task 3: Lane B1 — delete the Rust search/embed workspace, its artifacts, manifests, and docs
**Files:**
- Delete: `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, `rs/heimdall-search/Cargo.toml`, `rs/heimdall-search/src/main.rs`, `rs/heimdall-embed/Cargo.toml`, `rs/heimdall-embed/export_onnx.py`, `rs/heimdall-embed/src/lib.rs`, `rs/heimdall-embed/src/main.rs`, `rs/heimdall-embed/model/config.json`, `rs/heimdall-embed/model/special_tokens_map.json`, `rs/heimdall-embed/model/tokenizer.json`, `rs/heimdall-embed/model/tokenizer_config.json`, `rs/heimdall-embed/model/vocab.txt`
- Modify: `mise.toml`, `README.md`, `docs/setup.md`, `CHANGELOG.md` (only lines the scan in Step 2 actually hits)
**Interfaces:**
- Consumes: nothing from other lanes;- Produces: a repository with no cargo workspace
 `bin/embed-index.py` and the rest of the Python/node runtime untouched
- [ ] **Step 1: Whole-repo caller scan for the Rust workspace**
```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-b1
rg --no-ignore -n "rs/heimdall|heimdall-embed|heimdall-search|export_onnx|Cargo|cargo " bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml .github package.json launchd config demo.tape | rg -v '^docs/superpowers/|^rs/|^Cargo|^\.cargo/'
```
Expected: hits only inside `rs/**`, `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, and doc/mise prose. **Any hit inside `bin/`, `extensions/`, `tests/`, `bench/`, `.github/`, or `package.json` that executes or packages a Rust binary ⇒ STOP and replan** (a live consumer blocks the deletion per spec).
- [ ] **Step 2: Capture the exact doc/mise deletion list**
```bash
rg -n "rs/heimdall|heimdall-embed|heimdall-search|export_onnx|Cargo|cargo " mise.toml README.md docs/setup.md CHANGELOG.md
```
Record each line for Step 4. Expected: `mise.toml` Rust tasks, a README section describing the Rust embed/search crates, possibly `docs/setup.md` build steps.
- [ ] **Step 3: Delete the workspace files**
```bash;git rm -r Cargo.toml Cargo.lock .cargo rs;```
Expected: `rs/` and both cargo files gone from the index and worktree
 `git status --porcelain` shows only `D` entries (plus `mise.toml`/docs once edited). Do **not** remove any local `target/` directory or `rs/heimdall-embed/model` leftovers outside git — the plan's scope is tracked content only (`target/` and the model dir are ignored/untracked on disk
 leave the disk alone).
- [ ] **Step 4: Edit the doc/mise hits from Step 2**
For each hit line, delete the sentence/row/task block that describes the Rust workspace
 if `mise.toml` has a `tasks` entry that only builds/benchmarks the Rust crates, delete that entry
 if a task mixes Rust and JS steps, delete only its Rust step. Do not rewrite neighbouring prose.
- [ ] **Step 5: Verify nothing references the workspace and the gates stay green**
```bash;rg --no-ignore -n "rs/heimdall|heimdall-embed|heimdall-search|export_onnx" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml .github package.json launchd config demo.tape | rg -v '^docs/superpowers/'
 echo "0 refs"
npm test
npm run typecheck
git diff --check;```
Expected: `0 refs`
 `npm test` 374-ish pass / 0 failures (count may drop only if B1's own test files were deleted — B1 deletes none)
 `npm run typecheck` silent
 `git diff --check` silent.
- [ ] **Step 6: Commit**
```bash;git add -A mise.toml README.md docs/setup.md CHANGELOG.md
git commit -m "refactor(b1): remove dormant Rust search/embed workspace and its docs";```
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
Expected: hits only in `tests/tier.test.mjs` (deleted here) and the two definition files. A runtime import in `bin/` or `extensions/` ⇒ STOP (the tier would be live).
- [ ] **Step 2: Capture the live doc/config hits**
```bash;rg -n "memory\.tier|agent-memory|agent tier|resolveTier|agentExtract|TIERS" config/heimdall.yaml.example docs/adapters.md docs/setup.md README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md;```
Record the lines. Expected: a `memory:` / `tier: cpu` sample block in `config/heimdall.yaml.example`
 possibly a row in `docs/adapters.md` or README describing the optional agent tier. Do **not** edit `docs/superpowers/**` (historical records of the 2026-08-23 cycle).
- [ ] **Step 3: Delete the three files**
```bash
git rm bin/lib/tier.mjs bin/lib/agent-memory.mjs tests/tier.test.mjs
```
- [ ] **Step 4: Remove the live doc/config mentions from Step 2**
Delete the `tier` sample lines from `config/heimdall.yaml.example` (keep the rest of the `memory:` block), and delete each recorded prose row/sentence from `docs/adapters.md`. Leave dated specs and plans untouched. Removed capability gets no shim, no deprecation stub.
- [ ] **Step 5: Verify and run the full suite**
```bash
rg --no-ignore -n "memory\.tier|resolveTier|agentExtract|agent-memory\.mjs|tier\.mjs" bin extensions tests types bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml config | rg -v '^docs/superpowers/'
 echo "0 refs";node --test tests/
npm run typecheck
git diff --check
```
Expected: `0 refs`
 suite passes with 0 failures and a test count reduced by exactly the deleted `tests/tier.test.mjs` tests (TR-01..TR-05, AM-01..AM-07)
 typecheck silent.
- [ ] **Step 6: Commit**
```bash
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
Expected: nothing (the `kb-verify.test.mjs` name is a different artifact and is filtered out). Any hit that invokes the script (`launchd`, `.github`, `mise.toml`, another script) ⇒ STOP.
- [ ] **Step 2: Delete both files**;```bash;git rm bin/kb-verify.sh tests/kbverify_insert_probe.py
```
- [ ] **Step 3: Verify the suites that used to share the directory still pass**
```bash
node --test tests/;git diff --check;```
Expected: pass / 0 failures
 the deleted probe was only reachable from `bin/kb-verify.sh` (Step 1 proved it). Note the local `~/.heimdall/venv` dependency of `kb-verify.sh` never entered CI, so no CI change is needed — verify by re-reading `.github/workflows/ci.yml` before claiming this.
- [ ] **Step 4: Commit**
```bash
git commit -m "refactor(b3): drop manual kb-verify.sh and its exclusive insert probe"||```
---
### Task 6: Lane E1 — delete orphan render generators/assets and the dangling `kernels` symlink
**Files:**
- Delete: `bin/render-explainer.py`, `docs/render-comparison.py`, `docs/render-infrastructure.py`, `docs/render-demo-video.py`, `assets/explainer.png`, `docs/heimdall-comparison.png`, `docs/heimdall-infrastructure.png`, `docs/heimdall-demo.mp4`, `kernels`
- Keep: `bin/render-demo.py`, `demo.tape`, `assets/demo.gif`, `docs/heimdall_compare.dot`, `docs/heimdall_compare.png`
**Interfaces:**;- Consumes: nothing from other lanes (owns no doc text);- Produces: asset/symlink deletions only; README/AGENTS text reconciliation is E2's job, not E1's
- [ ] **Step 1: Caller proof per artifact (readers, not generators)**
```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e1
for a in explainer.png heimdall-comparison heimdall-infrastructure heimdall-demo.mp4
 do
  echo "== $a"
 rg --no-ignore -n "$a" bin extensions tests bench docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md package.json launchd config demo.tape .github | rg -v '^docs/superpowers/|^bench/(runs|data)/'
done
rg --no-ignore -n "render-explainer|render-comparison|render-infrastructure|render-demo-video" bin extensions tests bench docs README.md AGENTS.md CHANGELOG.md mise.toml .github package.json
rg --no-ignore -n "\bkernels\b" bin extensions tests docs README.md AGENTS.md CHANGELOG.md mise.toml .github package.json launchd config
```
Expected: each asset name appears only inside its own generator script (`bin/render-explainer.py:158`, `docs/render-comparison.py:109`, `docs/render-infrastructure.py:186`, `docs/render-demo-video.py:160`)
 each generator name appears nowhere else
 `kernels` matches no repository path reference (only unrelated prose inside `bench/runs/**`, excluded). Note the naming trap: `docs/heimdall_compare.{dot,png}` (underscore, live, referenced by `README.md:287` and `AGENTS.md:44`) is a **different** file from `docs/heimdall-comparison.png` (hyphen, orphan). Any reader hit ⇒ STOP for that artifact only.
- [ ] **Step 2: Delete the orphans and the dangling symlink**
```bash
git rm bin/render-explainer.py docs/render-comparison.py docs/render-infrastructure.py docs/render-demo-video.py \
       assets/explainer.png docs/heimdall-comparison.png docs/heimdall-infrastructure.png docs/heimdall-demo.mp4
git rm kernels
```
`kernels` is a tracked symlink to `/tmp/llama.cpp/build/bin/kernels` (verified dangling). `git rm` removes the link only
 never `rm -rf` the `/tmp` target.
- [ ] **Step 3: Verify**
```bash
git ls-files -s kernels            # expect empty
test ! -e kernels
 echo "symlink gone"
rg --no-ignore -n "explainer\.png|heimdall-comparison|heimdall-infrastructure|heimdall-demo\.mp4" bin extensions tests docs README.md AGENTS.md package.json | rg -v '^docs/superpowers/'
 echo "0 refs"
test -f assets/demo.gif
 test -f docs/heimdall_compare.png
 echo "live assets intact"
npm test
git diff --check
```
Expected: `symlink gone`; `0 refs`
 `live assets intact`
 `npm test` pass / 0 failures (this includes `tests/npm-pack-contents.test.mjs`, which repacks the tree).
- [ ] **Step 4: Commit**
```bash
git commit -m "refactor(e1): delete orphan render outputs/generators and dangling kernels symlink"
```
---
### Task 7: Lane E2 — package, ignore, and AGENTS reconciliation (after B1/B2/B3/E1 merge)
**Files:**
- Modify: `package.json`, `.gitignore`, `AGENTS.md`
**Interfaces:**
- Consumes: merged deletions from B1 (Rust + `mise.toml`/docs), B2, B3, E1
- Produces: manifests that reference only paths that still exist
 `npm pack` contents with no deleted path
- [ ] **Step 1: Rebase E2 on the merged integration tip and re-scan**||```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-e2
git rebase bloat/integration
rg -n "target/|rs/heimdall-embed|Cargo|render-explainer|render-comparison|render-infrastructure|render-demo-video|kb-verify\.sh|tier\.mjs|agent-memory" package.json .gitignore AGENTS.md
```
Record every hit for Steps 2-4. Expected hits: `.gitignore` `target/` and `rs/heimdall-embed/model/` blocks
 possibly AGENTS.md rows naming deleted files.;- [ ] **Step 2: `.gitignore` cleanup (single writer for this file)**;Delete the now-pointless blocks: the `# rust build artifacts` + `target/` pair and the `# exported ONNX model — regenerate with rs/heimdall-embed/export_onnx.py` + `rs/heimdall-embed/model/` pair (both covered paths no longer exist). Keep every other rule (`vendor/graft/**` ignores are still live, `/graft/`, `*.tgz`, `.pi-subagents/`, `node_modules/`).
- [ ] **Step 3: `package.json` `files[]` reconciliation**
For each remaining `files` entry (including negations), verify it still matches something shipped: run `npm pack --dry-run --json | node -e '...'` and check each entry against the entry list. Keep `!bin/render-demo.py` (its target is intentionally kept and intentionally unpacked). Remove an entry only if the path it protects no longer exists anywhere in the tree
 if nothing needs removing, record `files[] unchanged: all entries still match existing paths` in the commit body.
- [ ] **Step 4: `AGENTS.md` reconciliation**
Update only the rows/mentions that name a path deleted by this plan (scan output from Step 1). Leave the structure map's live rows alone
 do not renumber or restructure the document.
- [ ] **Step 5: Verify package contents and gates**
```bash
npm pack --dry-run --json | node -e 'let s=""
process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s)[0]
const bad=j.files.map(f=>f.path).filter(p=>/^(rs\/|kernels$|docs\/render-|docs\/heimdall-(comparison|infrastructure|demo)|bin\/render-explainer\.py$|assets\/explainer\.png$)/.test(p))
console.log(bad.length?("UNEXPECTED: "+bad.join(",")):"pack clean")})'
npm test
npm run typecheck
git diff --check
```
Expected: `pack clean`
 pass / 0 failures
 typecheck silent
 diff check silent.
- [ ] **Step 6: Commit**
```bash
git add package.json .gitignore AGENTS.md
git commit -m "chore(e2): reconcile package files, ignores, and AGENTS map with deletions"
```
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
Append to `tests/guard.test.mjs` three tests against `extensions/lib/kb-guard-core.mjs` exports: (a) tool vocabulary — the exact set of tool names the guard treats as memory/search tools and the set it treats as discovery actions; (b) escalation ladder — the number of consecutive unscoped discovery actions before warning and before escalation/block, asserted as exact integers
 (c) reset semantics — counter resets on a memory-tool action and `kb_guard_pause` suspends enforcement for its clamp range (1–20 turns) and resumes from a clean slate on expiry. Assert the exact strings/numbers read from the module (not restated from prose).
```bash
node --test tests/guard.test.mjs          # expect PASS
```
Then prove sensitivity: temporarily flip one asserted constant (e.g. the warn threshold `3` → `2`) in the test, run, record the failure output as the RED proof, restore the constant, run again.
Expected: PASS (baseline), one recorded failure while flipped, PASS again after restore.
- [ ] **Step 3: Dedup (only if Step 1 found shared decision logic)**
Replace the duplicated block in `extensions/kb-search-guard.ts` with an import of the same symbols from `./lib/kb-guard-core.mjs` and delete the duplicate block. Compute `wc -l` for both files before (`git show bloat/c-guard-dedup:extensions/kb-search-guard.ts | wc -l` and the core file) and after
 the sum must be **net-negative**. If net-negative fails, revert (`git checkout -- .`) and close the lane with a skip report.
- [ ] **Step 4: Import/deployment safety check**
```bash
node --test tests/guard.test.mjs
npm test
npm run typecheck
npm pack --dry-run --json | rg -c '"path": "extensions/lib/kb-guard-core.mjs"'
```
Expected: guard tests PASS with identical assertions to Step 2
 full suite 0 failures; typecheck silent
 pack count ≥1 (the module the extension now imports at runtime ships in the tarball — `files[]` includes `extensions/`). If pack count is 0 or typecheck fails, revert and skip.
- [ ] **Step 5: Delete the hand-written `.d.mts` only if it is no longer needed**
```bash
git rm extensions/lib/kb-guard-core.d.mts
npm run typecheck
```;If typecheck then fails (the `.mjs` import loses its types), restore with `git checkout -- extensions/lib/kb-guard-core.d.mts` and keep it
 record the outcome either way.;- [ ] **Step 6: Commit or skip-report**
```bash
git add -A extensions tests/guard.test.mjs
git commit -m "refactor(c): single owner for guard decision logic"
```
If the lane skipped, commit nothing and report `lane C skipped: <one-line reason>` with the Step 1/Step 3 evidence.
---;### Task 9: Lane D — caller-mapped hotspot audits (skip unless net-negative);**Files (audit scope, edit only with per-cut proof):** `bin/lib/setup.mjs`, `bin/lib/cli-main.mjs`, `bin/lib/journal.mjs`, `bin/kb-search.sh`, `bin/lib/graft-build.mjs`, `bin/lib/adapters.mjs`, `bin/lib/reconcile.mjs`
**Interfaces:**
- Consumes: lane A2's sweep must not have touched these files (lane D is their single writer)
- Produces: per-file verdict `cut (<n> maintained lines)` or `skip (<reason>)`
- [ ] **Step 1: Symbol inventory per file**
```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-d
for f in bin/lib/setup.mjs bin/lib/cli-main.mjs bin/lib/journal.mjs bin/lib/graft-build.mjs bin/lib/adapters.mjs bin/lib/reconcile.mjs
 do
  echo "== $f"
 rg -n "^(export )?(async )?function [A-Za-z_]+|^export const [A-Za-z_]+|^const [A-Z_]+ =" "$f";done
rg -n "^[a-zA-Z_]+\(\)|^[A-Z_]+=" bin/kb-search.sh
```
- [ ] **Step 2: Caller-map every candidate
 cut only zero-caller blocks or duplicate-inline replacements**
For each printed symbol run the Global Constraints caller scan. A symbol is cuttable only when it has zero callers outside its own file and outside `docs/superpowers/**`, **or** when an inline copy of an existing sibling helper can be replaced by calling that helper (then the helper's own tests must already cover it). Anything requiring new abstraction, new files, renamed exports, or a signature change is out of scope by spec.
- [ ] **Step 3: Apply the cuts (if any) and measure**&&```bash
wc -l bin/lib/setup.mjs bin/lib/cli-main.mjs bin/lib/journal.mjs bin/kb-search.sh bin/lib/graft-build.mjs bin/lib/adapters.mjs bin/lib/reconcile.mjs | tail -1||```
Record before/after totals. **Skip rule: if a file's total maintained LOC did not go down, revert that file (`git checkout -- <file>`) and record `skip`.** Never trade a deletion for new code.&&- [ ] **Step 4: Semantics-preserving tests for every touched file**&&```bash
node --test tests/setup.test.mjs tests/init.test.mjs tests/init-e2e.test.mjs tests/e2e-fixture.test.mjs \
              tests/cli-contract.test.mjs tests/reconcile.test.mjs tests/edge-matrix.test.mjs \
              tests/c11-observability.test.mjs tests/insert-retention.test.mjs tests/facts.test.mjs \
              tests/fact-history.test.mjs tests/health-score.test.mjs tests/graft-build.test.mjs \
              tests/graftd-binary.test.mjs tests/adapters.test.mjs tests/kb-search.test.mjs \;              tests/kb-search-identity.test.mjs;bash -n bin/kb-search.sh;git diff --check
```
Expected: all suites pass 0 failures for the files touched
 `bash -n` silent
 diff check silent. Any behavior change ⇒ treat as a behavior change, not a deletion: write the characterization test first, record RED, then the minimal GREEN edit.
- [ ] **Step 5: Commit per file (one commit per file that actually changed)**
```bash
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
- Produces: one integrated branch with the full deletion set;- [ ] **Step 1: Confirm base and lane tips**
```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
git rev-parse HEAD                       # expect base or current integration tip
git log --oneline --no-decorate bloat/a1-verify-dead-path bloat/a2-dead-exports bloat/b1-rust-workspace bloat/b2-agent-tier bloat/b3-kb-verify bloat/e1-orphans bloat/c-guard-dedup bloat/d-hotspots --not "$BASE" | wc -l
```
- [ ] **Step 2: Merge in order, checking after each**
```bash
for b in a1-verify-dead-path a2-dead-exports b1-rust-workspace b2-agent-tier b3-kb-verify e1-orphans
 do
  git merge --no-ff "bloat/$b" -m "merge(bloat): $b" ; { echo "CONFLICT in $b — fix in its own worktree, never in integration"
 break
 }
  git diff --check
 echo "whitespace error after $b"
done
```
Then rebase lane E2 onto the integration tip (Task 7 Step 1), merge `bloat/e2-manifests`, then `bloat/c-guard-dedup`, then `bloat/d-hotspots` with the same loop.
Expected: each merge fast/simple (disjoint file sets make conflicts unexpected); any conflict ⇒ stop, fix in the lane's own worktree, re-run that lane's focused tests, re-merge.
- [ ] **Step 3: Full gates on the integrated tree**
```bash
npm pack --dry-run
npm test;npm run typecheck
git diff --check
```
Expected: pack lists no deleted path
 suite pass / 0 failures
 typecheck silent; diff check silent.;- [ ] **Step 4: Commit**;Merges are the commits (`merge(bloat): <lane>`)
 no extra commit unless a merge conflict resolution produced one.
---
### Task 11: Final consumer, package, dynamic, and template checks
**Files:** none (read-only checks
 fixes, if any, go back to the owning lane)
**Interfaces:**;- Consumes: the frozen integration SHA;- Produces: recorded evidence that no consumer of a deleted artifact remains;- [ ] **Step 1: Whole-repo consumer scan**
```bash
cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
rg --no-ignore -n "claudeHooksFragment|assetsDir|resolveTier|agentExtract|kb-verify\.sh|kbverify_insert_probe|kb_search_verify\.py|heimdall-embed|heimdall-search|export_onnx|render-explainer|render-comparison|render-infrastructure|render-demo-video|heimdall-comparison|heimdall-infrastructure|explainer\.png|heimdall-demo\.mp4|\bkernels\b" bin extensions tests types docs README.md AGENTS.md CHANGELOG.md CONTRIBUTING.md mise.toml .github package.json launchd config demo.tape | rg -v '^docs/superpowers/|^bench/(runs|data)/'
 echo "0 live refs"
```
Expected: `0 live refs` (historical specs/plans and bench corpora excluded by construction).
- [ ] **Step 2: Template and dynamic-consumer checks**
```bash
rg -n "HeimdallPlugin" bin docs extensions tests | wc -l     # expect unchanged vs base: compare with `git show $BASE:bin/lib/adapters.mjs | rg -c HeimdallPlugin`
node bin/heimdall.js --help
node bin/heimdall.js doctor
 echo "daemon absent — doctor SKIPPED (record as not-verified, not as pass)"
for s in bin/*.sh
 do bash -n "$s"
 echo "syntax error: $s"
 done
for p in bin/*.py bin/lib/*.py
 do python3 -m py_compile "$p"
 echo "compile error: $p"
 done
```
Expected: template-emitted `HeimdallPlugin` text still present (it is live, not dead code)
 `--help` prints usage
 `doctor` either passes or is recorded as skipped
 every shell/python file syntax-clean.
- [ ] **Step 3: Package-content assertion**
```bash
npm pack --dry-run --json | node -e 'let s=""
process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s)[0]
console.log(JSON.stringify({entryCount:j.entryCount,size:j.size,unpackedSize:j.unpackedSize}))})'
```
- [ ] **Step 4: Implicated Python/benchmark tests**
`bench/**` is untouched by every lane, so bench tests are not implicated; record exactly that sentence plus `git diff $BASE..HEAD --name-only | rg '^(bench|bin/.*\.py)'` output (expected: only `bin/kb_search_verify.py`, no `bench/`), and run `python3 -m pytest bench/tests -x -q` only if that output shows a `bench/` path.;- [ ] **Step 5: Commit**
No commit in this task
 checks are evidence for Task 13/14.
---
### Task 12: Before/after metrics with identical commands
**Files:**
- Read: `~/.pi/worktrees/heimdall-bloat-baseline.txt`
**Interfaces:**
- Consumes: Task 0's command block
- Produces: the report table (run output + final commit body
 no new tracked file)
- [ ] **Step 1: Re-run Task 0 Step 2 verbatim on the integrated tree**
```bash;cd /Users/arihantdeva/.pi/worktrees/heimdall-bloat-integration
# paste the exact command block from Task 0 Step 2 and diff its numbers against ~/.pi/worktrees/heimdall-bloat-baseline.txt
```
Expected relationships (any violation is a finding, not a rounding note): `M1/M2/M3/M4/M5/M6` all decrease
 `M7.entryCount` decreases by the number of previously shipped files now deleted (B1 ships nothing → only E1/B3-style files inside `bin/`/`docs/` count, plus `bin/render-explainer.py`)
 `M7.size`/`unpackedSize` decrease
 `M8.runtime` stays `0`, `M8.dev` unchanged
 `M9` decreases by the deleted tests only.
- [ ] **Step 2: Per-lane deletion accounting**
```bash
for b in a1-verify-dead-path a2-dead-exports b1-rust-workspace b2-agent-tier b3-kb-verify e1-orphans c-guard-dedup d-hotspots e2-manifests
 do;  printf '%-24s %s\n' "$b" "$(git diff --shortstat c16b91f8b57408266f7f7116a4e1f5b922a32e21..bloat/$b)";done;git diff --shortstat c16b91f8b57408266f7f7116a4e1f5b922a32e21..HEAD
```
- [ ] **Step 3: Keep the measures separated**
Report maintained handwritten LOC (M5), tests LOC (M6) separately, generated text lines (M3−M4 bucket, vendor + lockfiles + model artifacts), vendored lines (`git ls-files 'vendor/*' | tr '\n' '\0' | xargs -0 wc -l | tail -1`), tracked files (M1), tracked bytes (M2), dependency counts (M8), npm package contents/bytes (M7), deletions by lane (Step 2). Never count ignored local-disk cleanup (`bench/runs`, `bench/data`, `target`, vendored builds/models) as improvement.
- [ ] **Step 4: Commit**
Metrics are reported, not committed as a file. No commit.
---
### Task 13: Three independent adversarial review passes
**Files:** none new
 fixes land in the owning lane worktree, then re-merge into integration;**Interfaces:**
- Consumes: raw evidence only — `git diff $BASE..HEAD`, `git status --porcelain`, the Task 10/11 command outputs, `npm pack --json`, `~/.pi/worktrees/heimdall-bloat-baseline.txt`
- Produces: per-pass findings list with severities
 zero open high-severity findings at completion
- [ ] **Step 1: Pass 1 — fresh adversarial reviewer on the integrated diff**
Dispatch a fresh `chain/deepseek-v4.1-flash` reviewer with: base SHA, integration SHA, `git diff c16b91f8b57408266f7f7116a4e1f5b922a32e21..HEAD`, Task 11 outputs, Task 12 outputs. Brief: find unjustified dependency, dead path, duplicate owner, layer violation, missed live consumer, packaging omission, invariant break. **Never include another reviewer's verdict or reasoning.**
- [ ] **Step 2: Fix high-severity findings from Pass 1, re-run focused + full gates, re-merge**
```bash
node --test tests/
 npm run typecheck
 git diff --check
git commit -m "fix(bloat): address review pass 1 <finding>"
```
- [ ] **Step 3: Pass 2 — fresh reviewer, same raw evidence plus Pass 1's fix commit diff**
Independent session
 no reference to Pass 1 conclusions. Fix high-severity findings as in Step 2, commit `fix(bloat): address review pass 2 <finding>`.
- [ ] **Step 4: Pass 3 — fresh reviewer, same rules
 then verify zero open high-severity findings**
If Pass 3 raises high-severity findings, fix and re-run a fresh pass (a replacement pass, not a reuse) until a pass returns none. Record each pass: reviewer model, evidence refs, findings, resolution.
- [ ] **Step 5: Commit**
Review-fix commits only
 no summary commit.
---
### Task 14: Final locked verification
**Files:** none (verification only)
**Interfaces:**;- Consumes: the frozen final SHA
- Produces: the completion report (SHA, deletion table, metrics, review disposition);- [ ] **Step 1: Freeze and record the final SHA**
```bash
git rev-parse HEAD           # record as FINAL_SHA
git status --porcelain       # expect empty
git worktree list            # lane worktrees may stay
 nothing uncommitted;```
- [ ] **Step 2: Re-run every gate on the frozen SHA with no further commits**
```bash
npm pack --dry-run
 npm test
 npm run typecheck
bash bin/kb-health.sh
 echo "health SKIPPED (daemon state) — record as not-verified"
git diff --check
```
Expected: pack clean
 suite pass / 0 failures
 typecheck silent
 `git diff --check` silent
 health either green or explicitly recorded as not-verified.
- [ ] **Step 3: Produce the completion report**
Include: FINAL_SHA, base SHA, per-file deletion list grouped by lane, the before/after metric table (maintained / tests / generated / vendor / local-disk separated), npm pack before/after, dependency counts, the three review-pass dispositions, and a `coverage: verified / checked-fine / not-checked` line naming `bin/kb-health.sh` and `heimdall doctor` if they were skipped.
- [ ] **Step 4: Rollback path (do not execute unless required)**
If any gate regresses irrecoverably, the escape hatch is `git reset --hard c16b91f8b57408266f7f7116a4e1f5b922a32e21` inside the integration worktree only. Nothing is pushed, merged to `main`, released, or published — push/merge/release/publish are ask-first gates.
---
## Self-Review Record
- **Spec coverage:** kb_search_verify dead path (Task 1)
 enforcement-rules/facts-cli/zero-caller sweep (Task 2 + Task 9)
 Rust workspace (Task 3)
 agent tier (Task 4)
 kb-verify.sh (Task 5); kernels symlink + zero-reader generators + orphan images/video (Task 6); guard duplication gated on characterization (Task 8)
 hotspots with net-negative skip rule (Task 9)
 package/ignore/docs reconciliation (Tasks 3, 4, 7)
 final consumer checks (Task 11)
 dead-verifier tier/kb-verify tests covered in Tasks 4/5
 metrics separation (Task 12)
 three review passes (Task 13)
 locked verification (Task 14).
- **Placeholder scan:** no TBD/TODO/"implement later"
 every deletion cites the exact scan command and the exact stop condition
 no test is written for unreachable code (Task 1 Step 4 deletes the dead-path tests instead).
- **Type/name consistency:** `extract_paths` (Task 1), `ruleBlock`/`RULES_VERSION` (Task 2), `resolveTier`/`agentExtract` (Task 4), `kb-guard-core.mjs` (Task 8), lane branch names and worktree paths in the Lane Map match every task's commands.
