# Heimdall bloat reduction — before/after evidence report

**Date:** 2026-09-16
**Base (before):** `4eed2564bebb4ce2255d5af47598d696fc275ef6`
**Final (after):** `4805db6c7ad8874b3e65a530c062a5a50383d4f8` (branch `bloat/integration`, 21 commits)
**Spec:** `docs/superpowers/specs/2026-09-16-maximum-bloat-reduction-design.md` (sha256 `4042921f…`)
**Plan:** `docs/superpowers/plans/2026-09-16-maximum-bloat-reduction.md` (sha256 `0d7f0f97…`)

## Headline

| Measure | Before | After | Delta |
|---|---|---|---|
| Tracked files (M1) | 328 | 301 | **−27** |
| Tracked content bytes (M2) | 7,912,346 | 6,262,584 | **−1,649,762 (−20.9%)** |
| Tracked lines (M3) | 178,927 | 112,683 | **−66,244** |
| Maintained source lines (M4) | 14,319 | 11,171 | **−3,148 (−22.0%)** |
| Tests lines (M5) | 7,888 | 7,870 | −18 |
| Vendored lines (M6) | 89,954 | 89,954 | 0 |
| `npm pack` entries | 205 | 201 | −4 |
| `npm pack` bytes | 620,573 | 612,916 | −7,657 |
| `npm pack` unpacked bytes | 3,408,823 | 3,387,381 | −21,442 |
| Runtime dependencies | 0 | 0 | 0 |
| Dev dependencies | 3 | 3 | 0 |
| Passing tests | 374 | 365 | see reconciliation |

Generated text (M3 − M4 − M5 − M6): 66,766 → 3,688 lines.
**Net diff:** `git diff --shortstat 4eed256..4805db6` → **48 files changed, 183 insertions(+), 64,418 deletions(-)**

## Honesty note on the headline

The −64,418 line figure is dominated by ~61k lines of **tracked generated tokenizer/vocab JSON** inside the removed Rust workspace — text the repo's own `.gitignore` already treated as regenerable. Hand-written reduction is the M4 delta: **−3,148 maintained lines (−22.0%)**. The two are reported separately so generated bulk is never mistaken for code.

## Lanes

| Lane | Commit | Change | Net |
|---|---|---|---|
| A1 | `b755eb7` | deleted dead `kb_search_verify.py` CLI/verdict path; kept live `extract_paths` | −247 |
| A2 | `4ba1901` | deleted dead exports `claudeHooksFragment`/`assetsDir`, empty statement, unused import, 3 needless exports | −25 |
| B1 | `c0f5580` | removed unused Rust search/embed workspace + tracked generated model artifacts + stale CHANGELOG noun | −63,216 |
| B2 | `4b4ad93` | removed parked agent tier (`tier.mjs`, `agent-memory.mjs`, exclusive tests) + config compat contract test | −185 |
| E1 | `caaad75` | removed 4 orphan render generators, 3 orphan images, 1 orphan mp4, dangling `kernels` symlink | −625 |
| C | `09892b2` | guard dedup **refused on evidence** (behavior would change); shipped only the redundant `.d.mts` | −29 |
| D | 5 commits | removed unused imports/indirection in `adapters.mjs`, `cli-main.mjs`, `graft-build.mjs`, `kb-search.sh`; 3 files honestly skipped | −15 |
| E2 | `22d44dc` | reconciled `.gitignore`, `README.md`, `AGENTS.md` with removed paths | docs |
| 3R | `49c2446`, `4805db6` | review-pass fixes: refreshed `heimdall_compare.{dot,png}`; changelog `### Removed` entry; dropped dead `id_hex` fallback | docs + −1 |

## Verification (final, on frozen SHA `4805db6`, clean tree)

| Gate | Command | Output |
|---|---|---|
| Full suite | `npm test` | `ℹ tests 365`, `ℹ pass 365`, `ℹ fail 0`, rc 0 |
| Typecheck | `npm run typecheck` | `tsc --noEmit`, rc 0 |
| Whitespace | `git diff --check` | silent |
| Packaging | `npm pack --dry-run --json` | 201 entries, 612,916 B; guard core shipped; **no deleted path present** |

Test-count reconciliation, verified by running each file in both trees:
374 − 12 (`tests/tier.test.mjs` deleted whole) − 3 (content-verdict tests in `tests/kb-verify.test.mjs`; its 3 `extract_paths` tests kept) + 5 (new guard characterization tests) + 1 (`tests/init.test.mjs` stale-`memory.tier` config contract) = **365**.

## Adversarial reviews (fresh reviewers, raw evidence only)

- **Pass 1 (bounded, 3 angles):** correctness, safety, simplicity — no HIGH, no MEDIUM defect. One real accounting error found in this report (test arithmetic) and one stale doc reference; both corrected.
- **Pass 2 (3 angles):** reverse attack, claims verification, leftovers hunt — no HIGH, no MEDIUM. Two LOW leftovers, both fixed in `4805db6`: (a) `CHANGELOG.md` had rewritten a shipped release entry instead of recording a removal; (b) `extensions/kb-orient.ts` still fell back to `id_hex`, a key `kb-search.sh` no longer emits.
- Reviewer independence: each pass received only the diff, gate outputs, metric files, and the repository — never another reviewer's verdict.

## Deliberate non-cuts (evidence-backed refusals)

- **Guard dedup (lane C).** `bin/heimdall-hook.mjs` and `extensions/lib/kb-guard-core.mjs` are not one ladder with two front-ends: tool vocabularies differ, escalation timing differs (3/9 never-block vs 3/4/5-block), and the scope gate is core-only. Merging would change behavior either way, so it was refused and characterized instead.
- **`bin/kb-verify.sh` (B3).** 64 LOC, zero automated callers, but a manual end-to-end gate needing a live graft daemon. **User decision: keep it.** Deferred, not deleted.
- **Test-helper `sandbox()` triplication (~13 LOC net).** Would need a new `tests/lib/` module; marginal, test-only gain. Recorded, not done.
- **Vendored subtrees, `assets/demo.gif`, `demo.tape`, `bin/render-demo.py`, `docs/heimdall_compare.*`, ignored local data.** Untouched by design.

## Coverage statement

- **Verified:** full suite, typecheck, pack contents, `.dot`→`.png` render equality, metric capture (identical commands, git objects only), every deleted name's zero live references, caller proof for each deleted symbol, per-file test counts in both trees.
- **Checked and fine:** no untracked or ignored file was deleted or staged; `.gitignore` rules were removed only with their covered paths; `kb-stale-scan.py` still imports `extract_paths` (python smoke); stale `memory.tier` configs still load (executed); `.github/`, `launchd/`, `config/`, `mise.toml`, `bin/postinstall.mjs` hold zero references to removed names.
- **Not checked / not claimed:** live end-to-end retrieval against a running graft daemon; `bench/tests` pytest suites (need local `~/.heimdall` venv); no CI run and no push — CI parity with Node 22 was reasoned about, not executed. Nothing was pushed, merged to `main`, released, or published.
