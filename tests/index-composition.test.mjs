// index-composition.test.mjs — the semantic index must not be 84% machine noise.
//
// Measured 2026-10-15 on the live index (99,302 cards):
//
//   cards under ~/Repos                0
//   cards under ~/projects             0
//   cards under ~/arihantdeva-content  0
//
//   .pi/agent                 19,322      Desktop        1,319
//   .local/share              11,682      Documents        913
//   .claude/telemetry          9,258      Obsidian Vault   892
//   .bun/install               6,183
//   .vscode/extensions         5,904
//   .local/lib                 5,587
//   .claude/plugins            5,481
//   .codex/.tmp                4,977
//   .pi-subagents/artifacts    4,146
//   .openhands                 3,359
//   .claude/archive            2,618
//   .nvm                       2,613
//   .claude/jobs               2,020
//   ---------------------------------
//   NOISE SUBTOTAL            83,150   (84% of everything searchable)
//
// The user's own source code was effectively unsearchable while the index was
// dominated by toolchain caches, plugin marketplaces, telemetry and vendored
// dependency trees. discover_files(HOME_ROOT) walks all of $HOME and had no
// exclusion for any of it.
//
// A .mjs test, not a .py one: package.json runs `node --test "tests/**/*.test.mjs"`,
// so a .py test in tests/ never executes. Exercises the REAL discover_files in a
// real temp tree rather than asserting on the module's source text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hasSqliteVec, sqliteVecPython, sqliteVecSkipReason } from "./lib/python.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// ONLY the destructive-schema test needs the sqlite_vec extension; everything
// else here imports embed_walker, which is stdlib-only and runs under any
// python3. So the gate is per-test, not per-file: gating the whole file would
// throw away real exclusion coverage on a machine that can run it.
const canProbeSchema = hasSqliteVec();
const PY = canProbeSchema ? sqliteVecPython() : null;

/** Run the real discover_files over a synthetic tree; return relative paths + rules. */
function walk(relPaths) {
  const root = mkdtempSync(join(tmpdir(), "heimdall-comp-"));
  try {
    for (const rel of relPaths) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `content for ${rel}\n${"x".repeat(80)}\n`);
    }
    const script = `
import json, pathlib, sys
sys.path.insert(0, sys.argv[1])
import embed_walker
text_files, _dataless = embed_walker.discover_files(pathlib.Path(sys.argv[2]))
print(json.dumps({
  "paths": [str(p)[len(sys.argv[2])+1:] for p in text_files],
  "prune_dirs": sorted(embed_walker.PRUNE_DIRS),
  "home_prunes": list(getattr(embed_walker, "HOME_PRUNE_PREFIXES", [])),
}))
`;
    return JSON.parse(execFileSync("python3", ["-c", script, join(repoRoot, "bin"), root], { encoding: "utf8" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("toolchain and telemetry trees are not indexed", () => {
  const r = walk([
    // 12 of the 13 measured noise trees, one representative file each.
    // .pi/agent is absent here on purpose: it is excluded EXCEPT its sessions/
    // fact source (spec P3), and that carve-out is asserted separately below.
    ".local/share/thing.py",
    ".claude/telemetry/events.json",
    ".bun/install/cache/pkg/index.js",
    ".vscode/extensions/pub.ext/file.js",
    ".codex/.tmp/plugins/skill.md",
    ".pi-subagents/artifacts/brief.md",
    ".openhands/conversations/c.json",
    ".nvm/versions/node/v20/README.md",
    ".claude/jobs/job.json",
    ".claude/plugins/marketplace/skill.md",
    ".claude/archive/old/thing.md",
    ".local/lib/graft/src/main.c",
    // Authored content, must survive.
    "Repos/myproject/src/main.ts",
  ]);
  const noise = r.paths.filter((f) => !f.startsWith("Repos/"));
  assert.deepEqual(noise, [],
    `toolchain/telemetry files reached the index (the 84%-noise defect):\n  ${noise.join("\n  ")}`);
});

test("the .pi/agent exclusion keeps its sessions/ fact source (spec P3)", () => {
  // P3 made session logs the second fact source, so ~/.pi/agent/sessions/*.jsonl
  // must stay ingestible while the REST of ~/.pi/agent (19,322 of the 83,150
  // noise cards) is excluded. Getting this backwards in either direction is a
  // real failure: pruning sessions kills fact extraction, indexing all of
  // ~/.pi/agent puts harness internals back at the top of retrieval.
  const r = walk([
    ".pi/agent/sessions/run.jsonl",
    ".pi/agent/config/misc.json",
    ".pi/agent/other/thing.md",
  ]);
  assert.ok(r.paths.includes(".pi/agent/sessions/run.jsonl"),
    "session logs are the P3 fact source and must stay indexed");
  const leaked = r.paths.filter((p) => p.startsWith(".pi/agent/") && !p.startsWith(".pi/agent/sessions/"));
  assert.deepEqual(leaked, [], `the rest of ~/.pi/agent is tool internals:\n  ${leaked.join("\n  ")}`);
});

test("the user's own source IS indexed (positive control)", () => {
  const r = walk([
    "Repos/myproject/src/main.ts",
    "Repos/myproject/lib/util.py",
    "projects/personal-website/src/index.md",
    "Desktop/notes/idea.md",
  ]);
  for (const want of [
    "Repos/myproject/src/main.ts",
    "Repos/myproject/lib/util.py",
    "projects/personal-website/src/index.md",
    "Desktop/notes/idea.md",
  ]) {
    assert.ok(r.paths.includes(want), `${want} must be indexed — it is the user's own work`);
  }
});

test("real projects with dirs named like tool trees are NOT pruned", () => {
  // Path-anchored, not basename-anchored. A rule like "prune any dir named
  // install" would delete real source; vendor/worktrees keep their deliberate
  // basename trade from the 2026-09-28 spec, but these names must not.
  const r = walk([
    "Repos/monitor/telemetry/metrics.py",
    "Repos/deploy/install/setup.sh",
    "Repos/tools/artifacts/report.md",
    "Repos/app/plugins/loader.ts",
    "Repos/app/cache/store.py",
  ]);
  for (const want of [
    "Repos/monitor/telemetry/metrics.py",
    "Repos/deploy/install/setup.sh",
    "Repos/tools/artifacts/report.md",
    "Repos/app/plugins/loader.ts",
    "Repos/app/cache/store.py",
  ]) {
    assert.ok(r.paths.includes(want), `${want} must not be pruned — only the $HOME tool tree is noise`);
  }
});

test("every measured noise tree is covered (no partial fix)", () => {
  // Guards against dropping one entry and silently regressing toward 84% noise.
  // .pi/agent is listed as its excluded sub-paths rather than the whole tree,
  // because sessions/ is the deliberate P3 carve-out.
  const measured = [
    ".pi/agent/config", ".local/share", ".claude/telemetry", ".bun/install",
    ".vscode/extensions", ".local/lib", ".claude/plugins", ".codex/.tmp",
    ".pi-subagents", ".openhands", ".claude/archive", ".nvm", ".claude/jobs",
  ];
  const r = walk(measured.map((m) => `${m}/probe.txt`).concat(["Repos/keep/probe.txt"]));
  const leaked = measured.filter((m) => r.paths.some((p) => p.startsWith(`${m}/`)));
  assert.deepEqual(leaked, [],
    `these measured noise trees still reach the index:\n  ${leaked.join("\n  ")}`);
  assert.ok(r.home_prunes.length > 0, "HOME_PRUNE_PREFIXES must be declared as data");
});

test("generated-data classes are excluded (measured 2026-10-15)", () => {
  // The walk discovers 432,523 files under $HOME but the previous index held
  // only 99,303 cards, so the earlier build never finished its walk — that, not
  // a filter rule, is why ~/Repos had 0 cards. Six generated classes accounted
  // for 232k files (54% of everything discoverable) and are excluded now. Each
  // is derived data, evidenced by volume vs. tracked-file count: the prospector
  // data/ subtree alone is 119,530 files with exactly ONE tracked in git.
  const r = walk([
    "go/pkg/mod/github.com/x/y@v1/z.go",
    "backups/agent-state/20261011-041211/thing.json",
    "Documents/curseforge/minecraft/Instances/a/config.txt",
    "Desktop/Code Projects/Lumina/_work/b3_vc1/corpus/page.md",
    "equitylens/research/hyperagent-sales-prospector/data/llm_queue/a.response.json",
    "equitylens/data/vendor/some/lib.py",
    "arihantdeva-content/.pi/workflows/wf_1/index.json",
    "arihantdeva-content/.pi/workflow-subagents/sa_1/log.md",
    "equitylens/.worktrees/doc-gen/src/main.py",
    // authored content that must survive
    "Repos/app/src/main.ts",
    "Desktop/Code Projects/Lumina/src/real.py",
    "go/personal/notes.md",
  ]);
  const leaked = r.paths.filter((p) => !/^(Repos\/|Desktop\/Code Projects\/Lumina\/src\/|go\/personal\/)/.test(p));
  assert.deepEqual(leaked, [],
    `generated-data classes still reach the index:\n  ${leaked.join("\n  ")}`);
  for (const want of ["Repos/app/src/main.ts", "Desktop/Code Projects/Lumina/src/real.py", "go/personal/notes.md"]) {
    assert.ok(r.paths.includes(want), `${want} must survive — exclusions must be path-anchored`);
  }
});

test(".worktrees is pruned as a basename like its worktrees sibling", () => {
  // The existing PRUNE_DIRS entry is `worktrees` (no dot). Membership is exact,
  // so `.worktrees` slipped through and 5,920 generated files were indexed.
  const r = walk([
    "Repos/app/.worktrees/feature/src/a.py",
    "Repos/app/worktrees/feature/src/b.py",
    "Repos/app/src/keep.py",
  ]);
  assert.deepEqual(
    r.paths.filter((p) => p.includes("worktrees")), [],
    "both worktrees and .worktrees are generated and must be pruned");
  assert.ok(r.paths.includes("Repos/app/src/keep.py"), "real source must survive");
});

test(".pi/tmp scratch is excluded but .pi/agent/sessions survives", () => {
  // Measured 2026-10-15: ~/.pi/tmp/sim1 was a stale Sep-16 SNAPSHOT OF THE
  // HEIMDALL REPO itself — 289 cards — and retrieval for "reconciler single
  // writer" ranked .pi/tmp/sim1/bin/heimdall-reconciler.mjs ABOVE the live file
  // it was copied from (sha 397f7010cd58 vs the real e067de392797). A stale
  // duplicate of a repo is worse than a miss: it returns a plausible path whose
  // content is not what the user is editing. The exclusion must be `.pi/tmp/`
  // specifically — a bare `.pi/` would drop the P3 session fact source.
  const r = walk([
    ".pi/tmp/sim1/bin/heimdall-reconciler.mjs",
    ".pi/tmp/sim1/.github/workflows/ci.yml",
    ".pi/agent/sessions/run.jsonl",
    "Repos/heimdall/bin/lib/reconcile.mjs",
  ]);
  const leaked = r.paths.filter((p) => p.startsWith(".pi/tmp/"));
  assert.deepEqual(leaked, [], `harness scratch reached the index:\n  ${leaked.join("\n  ")}`);
  assert.ok(r.paths.includes(".pi/agent/sessions/run.jsonl"),
    "the P3 session fact source must survive a .pi/tmp exclusion");
  assert.ok(r.paths.includes("Repos/heimdall/bin/lib/reconcile.mjs"),
    "live source must survive");
});

test("stale duplicate copies of the repo are excluded", () => {
  // Two stale copies of heimdall itself were competing with the live source in
  // retrieval, and one of them WON:
  //   ~/.pi/tmp/sim1/                       (Sep-16 snapshot, 289 cards)
  //   ~/heim-build-check/package/           (unpacked arihantdeva-heimdall-0.12.2.tgz,
  //                                          mtimes stamped 1985-10-26 by npm, 680
  //                                          cards, identical bytes -> sha 397f7010cd58)
  // The live file is sha e067de392797. Search for "reconciler single writer"
  // returned the 1985-dated copy at rank 1 and the live source at rank 2, with
  // the stale one reporting as_of=14963.9d.
  const r = walk([
    ".pi/tmp/sim1/bin/heimdall-reconciler.mjs",
    "heim-build-check/package/bin/heimdall-reconciler.mjs",
    "heim-build-check/package/vendor/graft/VERSION",
    "heim-build-check/arihantdeva-heimdall-0.12.2.tgz",
    "Repos/heimdall/bin/heimdall-reconciler.mjs",
  ]);
  const stale = r.paths.filter((p) => p.startsWith(".pi/tmp/") || p.startsWith("heim-build-check/package/"));
  assert.deepEqual(stale, [], `stale repo copies reached the index:\n  ${stale.join("\n  ")}`);
  assert.ok(r.paths.includes("Repos/heimdall/bin/heimdall-reconciler.mjs"),
    "the live working copy must be indexed");
});

test("tool state found by post-rebuild audit is excluded", () => {
  // Found by asking, AFTER the rebuild, "what is still large and clearly not
  // authored work?" — i.e. by auditing the result rather than assuming the
  // first exclusion list was complete. Both are tool state outside the dotdirs
  // earlier rules already covered:
  //   equitylens/.hypothesis   pytest example DB   (1,207 + 1,318 files)
  //   ~/.lunarclient/shared    Minecraft launcher (jre, game-cache,
  //                                                assets/skins/*, jit; 2,504 cards)
  const r = walk([
    "equitylens/.hypothesis/examples/abc.hash",
    "equitylens/.hypothesis/unicode_data/14.0.0/charmap.json.gz",
    ".lunarclient/shared/assets/skins/ff/ffe5344",
    ".lunarclient/shared/jre/bin/java",
    "Repos/app/src/main.ts",
  ]);
  const leaked = r.paths.filter((p) => p.includes(".hypothesis") || p.startsWith(".lunarclient/"));
  assert.deepEqual(leaked, [], `tool state reached the index:\n  ${leaked.join("\n  ")}`);
  assert.ok(r.paths.includes("Repos/app/src/main.ts"), "real source must survive");
});

test("agent scratch dirs are excluded at ANY depth, not just under $HOME", () => {
  // Measured 2026-10-15: `.pi-subagents` was excluded only as a $HOME-anchored
  // prefix, so 1,935 files / 2,386 cards survived in PER-PROJECT copies that a
  // prefix rule cannot reach — .claude/.pi-subagents (1,073 in one Desktop
  // project alone), arihantdeva-content/.pi-subagents (193),
  // Repos/shepherd-mvo-engine (104), Repos/Pi-Bolt/.work/plugins (102).
  // Content is subagent transcripts and *_input.md/*_output.md briefs: the
  // agent's own scratch, never authored source. The directory NAME is the
  // artifact marker, so basename matching is the right instrument here.
  const r = walk([
    ".pi-subagents/artifacts/a_transcript.jsonl",
    ".claude/.pi-subagents/artifacts/b_input.md",
    "Repos/proj/.pi-subagents/artifacts/c_output.md",
    "Repos/proj/src/real.ts",
  ]);
  const leaked = r.paths.filter((p) => p.includes(".pi-subagents"));
  assert.deepEqual(leaked, [], `agent scratch reached the index:\n  ${leaked.join("\n  ")}`);
  assert.ok(r.paths.includes("Repos/proj/src/real.ts"),
    "the project's real source must be indexed — only the scratch dir is noise");
});

test("the walker does not index the heimdall package's own dependency trees", () => {
  const r = walk([
    "Repos/heimdall/node_modules/pkg/index.js",
    "Repos/heimdall/vendor/graft/src/main.c",
    "Repos/heimdall/.venv/lib/python3.12/site-packages/x.py",
    "Repos/heimdall/bin/lib/reconcile.mjs",
  ]);
  for (const bad of [
    "Repos/heimdall/node_modules/pkg/index.js",
    "Repos/heimdall/.venv/lib/python3.12/site-packages/x.py",
  ]) {
    assert.ok(!r.paths.includes(bad), `${bad} is a dependency tree, not authored source`);
  }
  assert.ok(r.paths.includes("Repos/heimdall/bin/lib/reconcile.mjs"),
    "heimdall's own source must stay indexed");
});

// ---------------------------------------------------------------------------
// Retroactivity + authored-source collateral (adversarial review 2026-10-15).
// ---------------------------------------------------------------------------

test("should_exclude_path agrees with the walk on real paths", () => {
  // The walk prunes DIRECTORIES as it descends, so it can never answer "is this
  // already-indexed row excluded?". should_exclude_path() can, and it exists so
  // an exclusion can be applied to existing rows without a 4-hour walk.
  // CONFIRMED-DEFECT it fixes: _prune_stale runs only at the TAIL of a build, so
  // adding a rule left 4,680 rows serving until the next completed build.
  const script = `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
import embed_walker as w
h = str(pathlib.Path.home())
cases = [
  (h + "/.local/share/x.py", True), (h + "/.nvm/v20/README.md", True),
  (h + "/.pi/tmp/sim1/bin/x.mjs", True), (h + "/.claude/.pi-subagents/a/b.md", True),
  (h + "/Repos/proj/.pi-subagents/artifacts/c.md", True),
  (h + "/equitylens/.hypothesis/examples/x", True),
  (h + "/.lunarclient/shared/jre/bin/java", True),
  (h + "/go/pkg/mod/x/y.go", True),
  (h + "/heim-build-check/package/bin/x.mjs", True),
  (h + "/Repos/heimdall/bin/lib/reconcile.mjs", False),
  (h + "/Repos/app/src/main.ts", False),
  (h + "/Desktop/Automation/job-automation/evidence/a.json", False),
  (h + "/.pi/agent/sessions/run.jsonl", False),
]
print(json.dumps([[p, bool(w.should_exclude_path(p)), exp] for p, exp in cases]))
`;
  const r = execFileSync("python3", ["-c", script], { encoding: "utf8" });
  const rows = JSON.parse(r);
  const wrong = rows.filter(([, got, exp]) => got !== exp).map(([p, got, exp]) => `${p} got=${got} exp=${exp}`);
  assert.deepEqual(wrong, [], `should_exclude_path disagrees with the walk:\n  ${wrong.join("\n  ")}`);
});

test("the policy predicate keeps a repo's authored source", () => {
  // CONFIRMED-DEFECT (synthetic collateral, adversarial review 2026-10-15): the
  // any-depth basename rules CAN exclude authored work placed inside a matching
  // directory — the reviewer's fixture showed fixtures/.pi-subagents/expected.md
  // and .worktrees/unmerged/src/main.py excluded. This test records what the real
  // rules actually do, measured, because my first version asserted the wrong
  // facts: I assumed `vendor` was pruned, and it is NOT in PRUNE_DIRS at all
  // (which is exactly why 3,615 real cards survive under /vendor/).
  const script = `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
import embed_walker as w
h = str(pathlib.Path.home())
prune = sorted(w.PRUNE_DIRS)
print(json.dumps({
  "real_src": bool(w.should_exclude_path(h + "/Repos/app/src/main.ts")),
  "own_vendor": bool(w.should_exclude_path(h + "/Repos/app/vendor/own_patch.py")),
  "worktree_src": bool(w.should_exclude_path(h + "/Repos/app/.worktrees/unmerged/src/main.py")),
  "vendor_pruned": "vendor" in prune,
  "data_pruned": "data" in prune,
  "_work_pruned": "_work" in prune,
}))
`;
  const r = JSON.parse(execFileSync("python3", ["-c", script], { encoding: "utf8" }));
  assert.equal(r.real_src, false, "real src must never be excluded");
  // A repo's OWN vendor/, data/ and _work/ are deliberately NOT pruned: those
  // names are legitimately authored or vendored-and-kept far too often, and the
  // measured index confirms it (3,615 cards under /vendor/, 1,717 under /data/,
  // 6,676 under /_work/). Only the $HOME-anchored entries
  // (equitylens/data/vendor/, Desktop/Lumina/_work/) exclude those subtrees.
  assert.equal(r.vendor_pruned, false, "a repo's own vendor/ must not be a basename prune");
  assert.equal(r.data_pruned, false, "data/ is far too common to prune by name");
  assert.equal(r._work_pruned, false, "_work/ is not pruned by name");
  assert.equal(r.own_vendor, false, "a repo's own vendor/ file must be indexed");
  // These two ARE excluded by the any-depth rules — a deliberate, documented
  // trade (an artifact directory named this is far more common than authored code
  // living inside one), recorded here so it is not rediscovered as a surprise.
  assert.equal(r.worktree_src, true, "documented trade: .worktrees/ is pruned at any depth");
});

// The status() probe exec()s embed-index.py, which imports sqlite_vec. Absent
// the extension this is unverifiable, not broken — skip with the reason rather
// than failing on an import the suite was never given (that is what CI did).
test("status() must never delete rows and must not crash on odd schemas",
  { skip: canProbeSchema ? false : sqliteVecSkipReason() }, () => {
  // Adversarial review 2026-10-15, P1: status() called init() with no lock, and
  // init() DROPs cards+vec on a dimension mismatch. Reproduced: 1 card at dim 768
  // -> status() -> 0 cards at dim 384, while the same call reported
  // `dimension_ok: True`. A read-only status call destroyed the index.
  //
  // Fix requires two properties that pull against each other, so both are pinned:
  //   (a) repair what is genuinely broken-but-additive (vec table absent → create
  //       it; a vec-less index fails every k-NN query),
  //   (b) NEVER delete, and never crash on a legacy `cards` schema that predates
  //       this module (it used to raise "no such column: root").
  const script = `
import json, os, sqlite3, sqlite_vec, contextlib, fcntl
src = open(${JSON.stringify(join(repoRoot, "bin", "embed-index.py"))}).read()
import ast
t = ast.parse(src)
g = {"sqlite3": sqlite3, "re": __import__("re"), "DIM": 768, "contextlib": contextlib, "fcntl": fcntl}
g["Busy"] = type("Busy", (Exception,), {})
exec(compile(ast.Module(body=[n for n in t.body if isinstance(n, ast.FunctionDef) and n.name in {"init","_db_dim","status"}], type_ignores=[]), "m", "exec"), g)
g["_acquire_read_lock"] = lambda: os.fdopen(os.dup(0), "r")
FULL = "CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL)"
VEC = "CREATE VIRTUAL TABLE vec USING vec0(embedding float[768] distance_metric=cosine)"
ROW = "insert into cards values('i','/a.py','a.py','b','s','/h',0,1)"
cases = [
  ("cards_no_vec", [FULL, ROW]),
  ("healthy",     [FULL, ROW, VEC]),
  ("legacy",      ["CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT UNIQUE)", "insert into cards values('i','/a.py')"]),
  ("empty",       []),
  ("dim_mismatch",[FULL, ROW, "CREATE VIRTUAL TABLE vec USING vec0(embedding float[384] distance_metric=cosine)"]),
]
out = {}
for label, ddl in cases:
    c = sqlite3.connect(":memory:"); c.enable_load_extension(True); sqlite_vec.load(c)
    for stmt in ddl: c.execute(stmt)
    c.commit()
    class DB:
        def execute(self, *a): return c.execute(*a)
        def commit(self): c.commit()
        def close(self): pass
    g["conn"] = lambda: DB()
    def rows():
        try: return c.execute("select count(*) from cards").fetchone()[0]
        except Exception: return None
    before = rows()
    res = g["status"]()
    out[label] = {"before": before, "after": rows(), "res": res}
print(json.dumps(out))
`;
  const r = JSON.parse(execFileSync(PY, ["-c", script], { encoding: "utf8" }));

  for (const [label, v] of Object.entries(r)) {
    // The load-bearing property: no row ever disappears from a status() call.
    if (v.before !== null) {
      assert.equal(v.after, v.before,
        `${label}: status() LOST rows (${v.before} -> ${v.after}) — it must never delete`);
    } else {
      assert.equal(v.after, 0, `${label}: status() on an empty db must leave an empty cards table`);
    }
  }
  // A vec-less index is repaired (additive DDL, no row loss).
  assert.equal(r.cards_no_vec.res.dimension_ok, true, "a missing vec table must be recreated");
  // A dimension mismatch is REPORTED, never repaired — this is the destructive case.
  assert.equal(r.dim_mismatch.res.dimension_ok, false, "a dim mismatch must be reported, not repaired");
  assert.equal(r.dim_mismatch.after, 1, "the dim-mismatch case must not drop the row");
  // A legacy schema must not crash the status call.
  assert.equal(r.legacy.res.schema_ok, false, "a legacy cards table must be reported, not raised on");
  assert.equal(r.legacy.after, 1, "legacy rows must survive a status call");
});
