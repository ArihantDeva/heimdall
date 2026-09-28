# Heimdall Retrieval: `--kind`, People Store, Session Facts — Design Spec (2026-09-28)

Status: DRAFT — awaiting user approval before implementation.
Untracked in git; **commit the spec before Phase 0** `[review-2 #14]`, or its
first commit becomes the phase-0 runner commit and the spec is easy to lose.
Supersedes nothing. Reviewed adversarially twice on 2026-09-28 — 20 findings
pass 1 (`[review-fix N]`), 14 more pass 2 (`[review-2 #N]`) — all resolved
inline. Pass-2 blockers were: `bench` as a basename nukeing the project's own
corpus, `--kind all` contradicting the untouched-truncate constraint, and a
SQL alias tiebreak that reproduced the exact defect it claimed to fix.

Baseline evidence: live `~/.heimdall/global.db` (852,340 cards, 4.4 GB) and
`~/.heimdall/journal.db` (`owned_nodes` holds **2** rows of kind `fact`, ever).

## Problem

Three measured gaps, in the order they hurt:

1. **Recent work is buried under old code hits.** `Repos/heimdall/bench/runs/**`
   alone is **162,276** cards (19.1% of the index) — the LongMemEval bench's
   own synthetic session corpus, this project's evaluation fixtures. Not
   foreign, not noise-for-noise's-sake: a rebuildable artifact that competes
   for the same 6 result slots as real decisions. `vendor/**` 23,496,
   `equitylens` 222,255, `job-automation` 119,802.
2. **The fact layer is dead, not broken.** The 2026-08-23 fact-layer spec
   designed capture; `extensions/prompt-capture.ts` was never built.
   `~/.heimdall/prompts/` holds one 123-byte file. `journal.owned_nodes` has
   **2** fact rows, both from it. Retrieval over facts has nothing to retrieve.
3. **No people store exists.** Nothing person-shaped is in the graph;
   `linkedin-engine` (2,822 cards) and the Obsidian vault are ordinary file
   corpora with no entity model.

## Goals / Non-goals

Goals:
1. A `kind` filter on `kb_search`: `person | decision | fact | code | all` —
   with the default query's behaviour provably unchanged.
2. A durable people store with a write path, a read path, and a backup.
3. Real conversational facts, from session logs already on disk, with no new
   capture path and no new extension.
4. A measured, falsifiable recall improvement.
5. Exclusions that stop the noise from being indexed again — **without** a
   4.4 GB rebuild in this change.

Non-goals:
- LLM extraction or entity resolution (2026-08-23 spec: CPU-only at ingest).
- Harvesting people from `linkedin-engine` / the vault (deferred; the store
  ships first so a harvest has somewhere to land).
- Auto-proposing people from conversation text — false entities cost more than
  missed ones.
- Deleting the 162,276 already-indexed `bench/runs` cards. Rebuild deferred.
- Any change to `facts.mjs` pattern set, dedup, or id derivation.
  **Exception `[review-fix 16]`:** exporting `SECRET_RES`/`isSecret` is
  permitted and required — reuse, not a second implementation.

## Measured baseline (2026-09-28, this machine)

Re-measured after the review flagged non-reproducing numbers. Pin the queries:
`sqlite3 'file:$HOME/.heimdall/global.db?mode=ro' "select count(*) from cards"`.
`~/.pi/agent/sessions` is **actively growing** (14,489 → 14,492 files in 20
minutes) — the number is a floor, not a constant.

| Store | Count | Consequence |
|---|---|---|
Every row is `select count(*) from cards where path LIKE '<pattern>'` against
`file:$HOME/.heimdall/global.db?mode=ro`, 2026-09-28.

| Pattern | Count | What it is |
|---|---|---|
| `%/bench/runs/%` | 162,276 | heimdall's own LongMemEval session corpus — **162,268 of it under `Repos/heimdall/`**, 8 elsewhere |
| `%/bench/%` (not runs) | 1,230 | **real source** — `bench/*.py`, `~/.config/harness-truth/bench/`, `~/.bun/.../bench/` |
| `%/vendor/%` | 23,496 | third-party C++ indexed as if it were ours |
| `%.claude/file-history/%` | 303 | superseded copies of real files |
| `%/.audit/%` | 96 | agent review output |
| `%/.claire/%` | 1 | agent worktrees |
| **total cards** | **852,340** | 4.4 GB, bge-m3, one k-NN pool |
| **sum excluded by E1** | **186,172** | 21.8% — and **not** the 187,402 you get from a blanket `bench` name |
| `~/.pi/agent/sessions` | ≥14,492 files / 2.9 GB | the fact source we are not using |
| `owned_nodes` kind=`fact` | 2 | fact retrieval is structurally empty |
| `~/.heimdall/people.db` | does not exist | to be created |

## Decisions

| # | Decision | Rejected alternative | Why |
|---|----------|---------------------|-----|
| K1 | Extend `kb_search` with `kind`: `person \| decision \| fact \| code \| all`; default `all` == today's two legs | Separate `kb_people` tool; overload `--scope` | One tool the agent already calls. `--scope` is a path substring; a kind is a different axis, and overloading makes both worse. |
| K2 | `kind` is a **filter**, not a ranking tier. Pure global score sort truncated to `n` | Round-robin quota; strict person>fact>code tiers | The caller asked for people; a quota would inject code into a person query. Tiers would change the default query's output, which K1 forbids. |
| K3 | People/fact legs execute **only when `kind` names them** | Always run, filter at the end | Default-path latency and output stay exactly as measured. |
| K4 | `--recency` flag, **default off**. `weight = 0.5 ** (age_days / 180)`, `score' = score * weight`, applied **post-merge, pre-`[:n]`**, to hits that have a card mtime in `global.db` | Always-on decay; decay on facts | Default output must be byte-identical. Facts/people are timeless (P5). |
| K5 | `decision` = `assertion ∪ declaration` over existing `facts.mjs` kinds | New `decision` pattern | A user utterance is classified at most once by design (first-match-wins). Splitting needs no extractor change. |
| K6 | People hits are **always STRONG** and **bypass the verdict pass entirely** | Route them through the merge/verdict loop | `[review-fix 1]` **BLOCKER found:** the loop hardcodes `os.path.exists(p)` (`kb-search.sh:318`), `os.lstat(p)` + `S_ISREG` (`:371`), and emits `NOPATH / "anchor is gone from disk"` (`:397`) for a non-path string. A person hit routed through it renders NOPATH. `[review-2 #6]` the **rationale is corrected**: the first draft blamed `kb-search-guard.ts`, which has no verdict awareness at all — `:79-85` only rewrites `event.content` with a canned warning, it never parses `STRONG`/`NOPATH`. The real consumers that would misread NOPATH are `bin/lib/mcp-server.mjs:80` (stdout passthrough) and the agent-facing line format. The fix is the same: a separate emission path, not a flag. |
| K7 | Default output reuses the existing numbered-hit line; `--long` prints full person rows | A separate people block | Every existing consumer (MCP server, `kb-search-guard.ts`, agents) keeps parsing one format. |
| P1 | `~/.heimdall/people.db` — a **separate** store, not a `journal.db` migration | Table on the journal | A migration on the hot single-writer journal risks the reconciler for a workload with no reconcile semantics. |
| P2 | 12 columns: `id, name, aliases, org, role, url, relationship, last_contact, notes, source, created_at, updated_at` | Flat notes-only card; normalized interactions tables | CRM-lite per user decision. No `interactions` table — not a stated need; `notes` holds that detail until it is. |
| P3 | Match = `LIKE` over `name, aliases, org, role, notes`; the exact-match tiebreak is applied **in JS after the fetch**, not in SQL | FTS5; any SQL alias-list tiebreak | `[review-2 #3]` **BLOCKER found.** Both SQL attempts were wrong. `name = ?2` ignored aliases entirely; the `[review-fix 13]` repair `COALESCE(NULLIF(aliases,''), name) = ?2` compares the *whole comma-joined string* to the query, so it fires only when a person has **no aliases at all** — the reviewer reproduced the inverted ordering. A comma-list element match needs `(','||replace(aliases,' ','')||',') LIKE '%,'||?2||',%'`, which is one more string expression per row to save nothing. Rows are few (P3 ceiling); sorting in JS after the fetch is shorter, exact, and testable. |
| P4 | Write via **both** `heimdall person add/rm` and `kb_insert --kind person` | One or the other | `[review-fix 20]` `runInsert` (`cli-main.mjs:52-62`) **requires** `--title`/`--body` and unconditionally materializes a fact card. Dispatch rule: `--kind person` short-circuits **before** the title/body check, writes the people row, and returns without touching `~/heimdall-notes/facts/`. The existing insert path is unchanged for every other kind. |
| P5 | No recency on people or facts | `last_contact` as a rank signal | `last_contact` is user-maintained data, not a fact about the code. Ranking on it makes a true-but-stale person sink. |
| P6 | Build a backup for `people.db` **from scratch** (sqlite backup API, mirroring `bin/kb-rebuild.sh:23-32`) | "Parity with journal.db" | `[review-fix 12]` **FALSE PREMISE**, `[review-2 #8]` **citation corrected:** `rg 'journal.db' bin/` returns 2 hits (`depth.mjs:25` `journalPath()`, `journal.mjs:106`) — neither a backup. The honest citation is `rg 'journal.db' bin/ \| rg -i backup` → **0 hits**, and `~/.heimdall/backup/` holds only `global.db.*`. The precedent to copy is `kb-rebuild.sh:23-32` (`con.backup(dst)`), not the journal. |
| S1 | Session logs become **watched files in the existing reconciler**. No new capture extension | Build `prompt-capture.ts`; a one-shot `import-sessions` | 14k+ files already exist. Writing a second copy of every prompt into `~/.heimdall/prompts/` duplicates the corpus and adds a per-turn write path. |
| S2 | `facts.mjs` gains a session-log shape probe + a `role == "user"` filter, and `parsePlain` is **disabled** for detected session files | Unchanged extractor; index sessions as plain files | **Measured blocker:** `parseJsonl` reads a top-level `rec.text`; real records are `{"type":"message","message":{"role":…,"content":[{"type":"text","text":…}]}}`. Unchanged, extraction returns **zero** facts from every session file. `[review-fix 10]` the `parsePlain` fallback (`facts.mjs:127`) fires only when *no* line parsed, so a session file whose first record is torn runs every raw JSON line through the English patterns and emits garbage facts. Session shape is therefore detected structurally (`rec.type === "message"`), and once detected `parsePlain` never runs. |
| S3 | User messages only; assistant output never becomes a fact | Both directions | Self-referential memory: the agent's own conclusions re-enter as "what the user said". |
| S4 | Ingest is incremental via the reconciler's hash/mtime gate; every session, forever, no retention | Full re-extract each pass; 90-day retention | Reconcile collapses unchanged paths to one hash comparison. |
| E1 | **Split exclusion rule.** A new `PRUNE_PREFIXES` tuple matched against the **absolute path** takes `/bench/runs/` and `/.claude/file-history/`; `PRUNE_DIRS` (basename, any depth) gains only `vendor`, `.audit`, `.claire`. **No rebuild in this change.** | Adding `bench` to `PRUNE_DIRS`; rebuilding now | `[review-2 #1]` **BLOCKER found.** `embed_walker.py:136` tests `name not in PRUNE_DIRS` — the **basename**, at every depth from `$HOME`. `"bench"` therefore also prunes `~/.bun/install/cache/@protobufjs/float@1.0.2@@@1/bench/`, `~/.config/harness-truth/bench/`, and heimdall's own `bench/*.py` — 1,230 real source cards. A prefix rule cannot do that. |
| A1 | `--kind all` = **per-leg truncate to `n`, then union, sort, truncate again** | A single shared truncate after the union | `[review-2 #2]` **BLOCKER found.** `kb-search.sh:272` already truncates to `[:n]` **before** the verdict pass, and K1 requires that path untouched. "One shared sort/truncate" for `all` is therefore impossible as drawn. Per-leg truncation bounds the union at ≤3n candidates and changes the default path by nothing. |
| T1 | Gate: `npm test && npm run typecheck` plus a **new** runnable recall harness, 3 scored slices, each with its own bar | Existing `bench/recall.py`; one mixed run | `[review-fix 2,3,4]` see below. |
| T2 | New tests, one per new contract | Existing suite only | Each has a distinct failure mode. |

### The recall gate, fixed `[review-fix 2, 3, 4]`

Three defects made T1 unfalsifiable. All three are now specified as work:

1. `bench/recall.py` **has no CLI** — no `__main__`, no `argparse`; it exports
   `recall_report(results, ks)` taking LongMemEval-shaped
   `[(question, ranked_titles)]`. Naming it a done-criteria command named a
   file that cannot be executed. → **New** `bench/kinds_recall.py` with
   `argparse`, committed in phase 0/4. It loads the query file, shells
   `kb-search.sh` per query, scores, and prints JSON.
2. `bench/queries/` and `bench/baselines/` **do not exist**. → created in
   phase 0.
3. The metric was undefined and `--kind` is a filter, so a mixed `recall@10`
   barely moves. → **The gate is three separately-scored slices**, not one
   number:

   | Slice | n | Query shape | Gold | Scored as |
   |---|---|---|---|---|
   | `code` | 10 | an old-code question | `golds: [expected path…]` committed with the query | `hit@10` = gold path in top 10 |
   | `fact` | 10 | "what did I say about X" | `golds: [expected fact title substring…]` | `hit@10` |
   | `person` | 10 | "who is <name>" | `golds: [expected people id…]` | `hit@3` (a person list has no tail) |

   The bar is **per slice**, not aggregate: `code` must not regress, `fact`
   and `person` must each reach **hit ≥ 0.80** post-change. The pre-change
   numbers for `fact` and `person` are **0.00 by construction** (no people.db
   exists; 2 fact rows exist) — the baseline records that, it is not inferred.
4. Baseline capture is **phase 0, before any code change**, and the query file
   + baseline JSON are committed in the same commit as the phase-0 runner. A
   baseline recorded after phases 1–3 would measure against whatever the tree
   happened to be.

## Architecture

```
  query ──► kb_search(query, n, scope, kind, recency, long)
              │
              ├─ kind absent or "code"  ──► EXISTING PATH, UNTOUCHED
              │     graft ask (per-repo, thread pool)  ─┐
              │     embed-index.py query (bge-m3)      ─┴─► merge ─► recency ─► sort ─► verdict ─► [:n]
              │
              ├─ kind == "person"  ──► people.db LIKE scan ──► EMIT DIRECTLY, verdict hardcoded
              │                        STRONG. NEVER enters the merge/verdict loop (K6).
              │                        Truncated to n in JS (P3).
              ├─ kind == "fact"|"decision" ─► journal.db owned_nodes WHERE kind='fact'
              │                            + fact_kind ∈ (assertion, declaration) for decision
              │                            (fact_kind is a NEW column — see below)
              └─ kind == "all"      ──► each leg truncated to n INDEPENDENTLY (A1), then
                                        union → one sort → one truncate to n. The default
                                        path (no kind / "code") never reaches this branch.

  ingest ─► ~/.pi/agent/sessions/**/*.jsonl
              │  (reconciler hints; THREE gates widened — see below)
              ▼
      extract.mjs desiredState → facts.mjs (NEW: session probe + role=user, parsePlain off)
              ▼
      journal.commit → owned_nodes(kind='fact', fact_title, fact_body) → sink → graft

  write  ──► heimdall person add --name N [--org …]  ─┐
           └─► kb_insert --kind person …            ─┴─► people.db (WAL) → backup (P6)

  hygiene ─► embed_walker: PRUNE_PREFIXES (path) + PRUNE_DIRS (basename). Code only, no rebuild.
```

### `--kind all` is not one shared truncate `[review-2 #2]`

`kb-search.sh:272` — `merged = sorted(seen.values(), key=...)[:n]` — runs
**before** the verdict pass and is unconditional. K1 forbids touching it, so
"union then one truncate" is unimplementable for `all`. The rule (A1): each leg
truncates to `n` on its own, the union holds ≤3n candidates, then one sort and
one truncate to `n`. The default path (`--kind code`, or no `--kind`) is
byte-identical because it still takes the single upstream `[:n]`.

### The fact kind is not a stored column `[review-2, verified]`

`journal.owned_nodes` columns are exactly: `node_id, path, kind, symbol, line,
label, sink_id, fact_title, fact_body` (measured via `PRAGMA table_info`).
There is **no `fact_kind`**. The extractor's
`preference|assertion|declaration|negation` classification reaches the journal
only as the row's `kind`, whose value is the literal string `"fact"` — and
`extract.mjs:53` builds the id as `${f.id}@${nsFor(path)}` where
`f.id = "fact-" + sha256(...)`, so the kind is **not** recoverable from
`node_id` either.

K5 therefore has nothing to filter on, and a `--kind decision` implemented
against today's schema would silently return *every* fact. The decision: **add
`fact_kind TEXT` as journal schema v4**, written by `extract.mjs` from `f`'s
kind, NULL for the 2 existing rows. This rides the existing v3 migration path
(`journal.mjs:135-142` does exactly this for v3), costs one `ALTER TABLE`, and
needs no backfill — the 2 existing rows are both under `~/.heimdall/prompts/`
and are re-derived by the next reconcile.

```sql
this.db.exec("ALTER TABLE owned_nodes ADD COLUMN fact_kind TEXT");  // v4
```

`--kind fact` and `--kind decision` both depend on this. It belongs to
**Phase 1**, not Phase 3: without the column, the fact leg is a no-op.

### The three gates on session facts `[review-fix 11]`

Phase 1 owns the schema; Phase 3 owns the ingestion.
Missing any one yields **zero** facts, silently:

1. `skipPath()` (`bin/lib/reconcile.mjs:16-30`) returns true for any
   `${home}/.` path except `${home}/.heimdall/prompts/`. Sessions are
   `${home}/.pi/agent/sessions/` — skipped before extraction.
2. `promptsDir()` (`bin/lib/extract.mjs:43`) is the second carve-out in the
   predicate.
3. **`opts.facts === true`** — the third gate, and the one the first draft of
   this spec missed. `reconcile.mjs:70` passes
   `facts: ctx.config?.facts === true`, and `~/.heimdall/config.json` on this
   machine is `{"version":1,"harness":"pi"}` — **no `facts` key**. Widening
   only 1 and 2 ships a feature that produces nothing.

Phase 3 widens all three, and its test asserts a non-zero fact count from a
real session file.

**Churn, stated honestly `[review-fix 11]`:** "one-time backfill then near-zero"
is wrong for actively-appended sessions. Every turn changes a session's hash,
and `journal.mjs:362` does `DELETE FROM owned_nodes WHERE path = ?` then
re-inserts — so fact nodes churn per turn, and `FACT_HISTORY_CAP = 50`
(`journal.mjs:103`) truncates supersession history per path. The 50-row cap is
the binding constraint on long sessions, not disk. Accepted, ponytail-marked:
raising the cap trades journal size for history depth and is not this change.

### The walker rule `[review-2 #1]`

`embed_walker.py:136` is `if name not in PRUNE_DIRS: stack.append(e.path)` —
`name` is `e.name`, the **basename**, tested at every depth below the `$HOME`
walk root. So a single `bench` entry prunes any `bench` directory on the
volume. The split:

```python
# PRUNE_DIRS stays basename/any-depth — build artifacts have no unique path.
# New: PRUNE_PREFIXES is matched against the ABSOLUTE path, so it can carve
# out one subdirectory of a real project without touching its siblings.
PRUNE_PREFIXES = ("/bench/runs/", "/.claude/file-history/")
```
Applied at the same `stack.append` site, on `e.path`:
`if name not in PRUNE_DIRS and not any(p in e.path for p in PRUNE_PREFIXES)`.

`PRUNE_DIRS` gains only `vendor`, `.audit`, `.claire` — names that are
genuinely artifacts at any depth.

Verified consequences on the live index: `Repos/heimdall/bench/runs/` (162,268
cards) goes; `Repos/heimdall/bench/*.py` stays; `~/.bun/install/cache/
@protobufjs/float@1.0.2@@@1/bench/` stays; `~/.config/harness-truth/bench/`
stays. A blanket `bench` entry would have deleted all three.

### people.db shape

```sql
PRAGMA journal_mode = WAL;           -- same durability posture as journal.db
CREATE TABLE IF NOT EXISTS people (
  id            TEXT PRIMARY KEY,     -- 'person-' || sha256(name|org)[0:12]
  name          TEXT NOT NULL,
  aliases       TEXT,                  -- comma-separated
  org           TEXT,
  role          TEXT,
  url           TEXT,
  relationship  TEXT,
  last_contact  TEXT,                  -- ISO date, user-maintained, NOT ranked (P5)
  notes         TEXT,
  source        TEXT,                  -- provenance path or 'manual'
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```
Id is a pure function of the **normalized** (name, org), so re-adding upserts
instead of duplicating — the determinism property `facts.mjs` relies on for
reconcile idempotence. Normalization is not optional `[review-2 #4]`: the
reviewer showed `('Jane Doe', NULL)`, `('Jane Doe', '')`, and
`('Jane Doe', '   ')` yield three different ids — and
`heimdall person add --name N` **with no `--org` is the documented default**,
so NULL-vs-`''` is the common case, not an edge case.

```js
const idFor = (name, org) =>
  "person-" + createHash("sha256")
    .update(`${norm(name).toLowerCase()}\u0000${norm(org ?? "").toLowerCase()}`)
    .digest("hex").slice(0, 12);
```
`norm` is `facts.mjs`'s NFKC + whitespace-collapse, reused for the same reason
the secret screen is: one implementation, no drift. `\u0000` separates the two
halves so `("ab","c")` cannot collide with `("a","bc")`.

`--kind person` query — one statement, no FTS, **no ordering in SQL**:

```sql
SELECT * FROM people
WHERE name LIKE ?1 OR aliases LIKE ?1 OR org LIKE ?1 OR role LIKE ?1 OR notes LIKE ?1;
```
`?1` is `'%' || q || '%'`. No `LIMIT` and no `ORDER BY`: P3's tiebreak runs in
JS after the fetch, and the final truncation to `n` happens there.

### Output

Default (`--kind person`, compact) — the same shape every other hit has:

```
== retrieve (people):
 1. [STRONG] cov100%  people.db:person-4f2a9c1b7e30
      Jane Doe · Staff Engineer @ Stripe · linkedin.com/in/janedoe
```

`--long` adds aliases, relationship, last_contact, source, created_at,
updated_at verbatim. The existing default line is **not** touched. `people.db:<id>`
is a display token only — it is never `os.path.exists`'d, because person hits
never reach the verdict loop (K6).

## Edge cases (explicit)

Empty query → usage error, **exit 2** (new). `[review-fix 8]` the current
`${1:?}` at `kb-search.sh:17` exits **1** in both cases — measured:
`kb-search.sh "" -n 2` → 1, `kb-search.sh` → 1. `[review-2 #9]` the reviewer's
claim that the empty-string case returns 0 does not reproduce; both are 1. The
replacement must test the **unshifted** `$1` with `-z`, because `${1:-}`-style
guards do not distinguish "set but empty" from "set and non-empty" in a way
that catches `""`.
Unknown flag → **exit 2** with the allowed list. `[review-fix 7]` `runSearch`
(`cli-main.mjs:49-51`) has **no** `checkFlags` — unlike `reconcile:193`,
`verify:241`, `score:276`, `history:364`, `depth:398`. The `*) shift ;;` at
`kb-search.sh:27` silently swallows unknown flags today. Phase 1 adds
validation in the shell (where parsing lives) and does not add `checkFlags` to
the search path.
Exit codes are **not uniform across consumers** `[review-2 #5]`: the shell
returns 2, but `mcp-server.mjs:34` pre-validates the query itself and returns
`code: 1`, and `:114` collapses `isError: code !== 0`. An MCP caller therefore
sees `isError: true` for both 1 and 2 — it cannot distinguish them. The spec
does not attempt to make them uniform. It requires **one** test asserting the
MCP `isError` path for a `--kind` misuse, so the collapse is a recorded
behaviour rather than a surprise.
Unknown `kind` → error listing the valid enum, exit 2.
`--kind person` with no `people.db` → own `exit 0` with one setup line, placed
**before** the graft legs. `[review-fix 15]` `--kind all` must **not** take
this branch — it tolerates a missing `people.db` silently (one stderr WARN).
`--kind fact` with zero fact rows → valid empty result, exit 0.
`--recency` on a hit with **no card mtime** (every graft-only hit) → weight 1.0
(unchanged). `[review-fix 5]` the first draft's "mtime 0/absent → weight 0"
would have silently demoted **every** graft hit to zero.
`--recency` + `--kind person` → accepted, ignored (K4: code cards only).
`--long` without `--kind person` → usage error, exit 2.
`--half-life` → **no such flag** `[review-fix 14]`. The 180-day constant is
fixed (K4), so the "half-life ≤ 0" edge case is unreachable and is removed
rather than kept as dead spec. Tuning is a code constant, not a CLI knob.
`people.db` locked by a writer → WAL readers never block. Unwritable DB →
`WARN: people leg failed …` on stderr, code legs still return. Never a bare
traceback, never a silent drop (2026-08-25 lesson).
Secret-shaped text in `--notes`/`--title` → screened by `SECRET_RES`/`isSecret`
**imported from `facts.mjs`** `[review-fix 16]`. They are module-private today;
exporting them is the fix, since the 2026-08-23 spec's D3 ("two implementations
drift") rules out a copy.
Session file deleted → reconciler retracts exactly its owned fact nodes
(existing `fact_history` path, no new code).
Torn record **mid-file** in a session jsonl → that line skipped, the rest parse.
Torn **first** record → the file is not detected as a session and is skipped
whole, never `parsePlain`'d (S2).
Non-English session content → zero facts (pre-existing, deliberate ceiling).
Global index unreadable → existing `INDEX_ERROR` line; a person hit is
unaffected (it never consults `cards`).

## Deliberate ceilings (ponytail-marked)

- `LIKE` people scan is O(rows) over 12 columns. Upgrade path: an FTS5 virtual
  table over the same columns, created by a migration that does not change the
  query contract.
- 186,172 excluded cards stay in `global.db` until a deferred rebuild (E1).
  `[review-fix 9]` Until that build, `global.db` is a **strict superset of
  discovery** — the exclusion is not inert. `heimdall verify` audits the
  *journal*, not `global.db` (`reconcile.mjs:194-231`), so **no existing check
  surfaces that state**. Stated, not hidden. `[review-2 #10]` with E1 now a
  prefix rule the sum is 186,172, not the 187,402 a blanket `bench` basename
  would have produced.
- `--recency` can be a **complete no-op** `[review-2 #11]`: `card_mtimes` is
  only populated for paths present in `merged` and only when `global.db` opens
  (`:296-306`). On a graft-only machine every hit is graft-only, every hit gets
  weight 1.0, and the flag changes nothing. Correct per K4, but the recency
  test must be built on a fixture that **has** cards, or it passes vacuously.
- `assertion ∪ declaration` for `decision` means a preference-classified
  utterance is invisible to `--kind decision`. First-match-wins working as
  designed, not a bug.
- Fact extraction remains English-pattern-only.
- Fact node churn per turn on active sessions is accepted; `FACT_HISTORY_CAP`
  bounds it at 50 rows per path.

## Test strategy

RED first, per component. Baseline verified green at 365/365 (`npm test`,
23.3 s) on the pre-change tree.

- `tests/kinds-flag.test.mjs` — `kind` enum validation, `decision` union,
  people/fact legs skipped when unrequested, **unknown flag → exit 2**,
  **empty query → exit 2** (both new).
- `tests/journal-v4-fact-kind.test.mjs` — the `fact_kind` column exists after
  a v3→v4 migration, existing rows read NULL (no backfill), and
  `extract.mjs` writes the extractor's kind into it. A fake graft
- `tests/kinds-default-identical.test.mjs` — **golden stdout.** A fake graft
  on `PATH` returning fixed hits; assert the full stdout of
  `kb-search.sh <query> -n 3` equals a committed golden byte-for-byte, with no
  new flag passed. `[review-fix 6]` the existing `tests/kb-search.test.mjs`
  only asserts `/GraftRan/` — a substring. It proves nothing about
  byte-identity, which is what K1/K4/A1 promise.
- `tests/journal-v4-fact-kind.test.mjs` — the `fact_kind` column exists after
  a v3→v4 migration, existing rows read NULL (no backfill), and `extract.mjs`
  writes the extractor's kind into it.
- `tests/people-store.test.mjs` — schema, **normalized** id determinism
  (`NULL` / `''` / `'   '` org all collapse to one id; case + spacing
  collapse), upsert, LIKE across all 5 columns, the **JS** alias tiebreak
  (`'Liz, B'` promotes the alias hit for query `B`), secret screen via the
  imported `isSecret`, WAL open, no-DB empty result, person hits emit STRONG
  **without** an `os.path.exists` call.
- `tests/mcp-kind-misuse.test.mjs` — `--kind` misuse surfaces as
  `isError: true` through the MCP path (exit 2 collapses to 1 there).
- `tests/session-facts.test.mjs` — the S2 shape regression (a real session
  record yields facts), `role != "user"` yields none, **all three gates
  asserted** with a non-zero fact count, torn-first-record skipped whole,
  `parsePlain` not reached, determinism.
- `tests/recency-flag.test.mjs` — default byte-identical with the flag off;
  `0.5 ** (age/180)` ordering on a fixed clock; **graft-only hit keeps weight
  1.0**; `--recency` + `--kind person` is a no-op.
- `tests/long-output.test.mjs` — `--long` field set; `--long` without
  `--kind person` rejected.
- `tests/insert-kind-person.test.mjs` — `kb_insert --kind person` writes a row
  and does **not** create a fact card; the title/body-less path works.
- `tests/embed-walker-exclusions.test.mjs` — a **`.mjs` test that shells out
  to python** `[review-fix 19]`: `package.json` runs
  `node --test "tests/**/*.test.mjs"`, so a Python test placed in `tests/` never
  executes. Asserts: `/bench/runs/**` yields no card; **`bench/*.py` still
  does** (the regression `[review-2 #1]` was found by); `vendor/**`,
  `.audit/**` yield no card.

Gates: `npm test && npm run typecheck`, then
`python3 bench/kinds_recall.py --queries bench/queries/retrieval-30.jsonl --out <run.json>`.

## Plan (phases, in order)

- **Phase 0 — the gate, before any code.** Create `bench/queries/retrieval-30.jsonl`
  (30 queries + gold lists), `bench/baselines/`, and `bench/kinds_recall.py`
  (argparse CLI). Run it on the **pre-change** tree, commit
  `bench/baselines/retrieval-30.json`. Nothing else lands before this.
  `[review-2 #7]` **`--kind` does not exist until Phase 1**, so the pre-change
  run cannot pass it: the runner treats an unknown-flag rejection as
  **"this slice scores 0 by construction"** — which is exactly the claim the
  `fact` and `person` baselines assert. The pre-change run therefore produces
  a real `code` number and a structural 0 for the other two. That is the
  baseline, and it is honest about *why* it is zero.
- **Phase 1 — kinds filter + recency + exclusions + journal v4.**
  `kb-search.sh` flag parsing and validation (exit 2), people/fact query SQL,
  the direct-emission people path (K6), per-leg truncation for `all` (A1),
  `--recency` post-merge weighting, `--long` gating, the
  `PRUNE_PREFIXES` split (E1), the `fact_kind TEXT` v4 migration,
  `kb-tools.ts` typebox param + description update.
  Verifiable alone: kinds/default-identical/recency/long/exclusions/v4 tests green.
- **Phase 2 — people.db.** Schema, `heimdall person add/rm`,
  `kb_insert --kind person` dispatch (P4), backup (P6).
  Verifiable alone: people-store + insert-kind-person tests green.
- **Phase 3 — session facts.** `facts.mjs` session probe + role filter +
  `parsePlain` suppression; **all three** gates widened; one-time backfill.
  Verifiable alone: session-facts test green **and** a non-zero fact count
  from a real session file.
- **Phase 4 — proof.** Post-change `kinds_recall` run; per-slice bars met
  (`code` no regression, `fact` and `person` hit ≥ 0.80).

Phases 1 and 2 are independent. 3 depends on neither but is useless without 1.
4 depends on all. 0 depends on nothing and must precede all.

## Open items carried forward (not this change)

- The `global.db` rebuild that actually drops the 186,172 excluded cards.
- Whether `bench/` belongs in a *default* install at all, vs a bench profile.
- Harvest from `linkedin-engine` / Obsidian vault into `people.db`.
- `zg`/`zvec-grep` already solves meaning-based search inside a repo; whether
  `--kind code` should delegate rather than duplicate it.
- `FACT_HISTORY_CAP = 50` vs long-running sessions.
