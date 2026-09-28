// embed-walker-exclusions.test.mjs — PRUNE_PREFIXES vs PRUNE_DIRS.
//
// RED for Phase 1. The spec's E1 blocker: embed_walker.py:136 tests the
// BASENAME against PRUNE_DIRS, at every depth below the $HOME walk root. So a
// bare "bench" entry prunes any dir named bench anywhere on the volume —
// including heimdall's own bench/*.py and ~/.config/harness-truth/bench/.
// The fix is a PATH-PREFIX rule for the two subdirectories that are genuinely
// noise, leaving PRUNE_DIRS for true build artifacts.
//
// A .mjs test, not a Python one: package.json runs
// `node --test "tests/**/*.test.mjs"`, so a .py test in tests/ never executes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const WALKER = join(repoRoot, "bin", "embed_walker.py");

// Exercise the REAL discovery function in a real temp tree, and read the REAL
// constants from the module. Asserting on the module's values (not on its
// source text) keeps the test passing if the constants are simply re-imported.
function walk(root) {
  const script = `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
import embed_walker
text_files, _dataless = embed_walker.discover_files(pathlib.Path(sys.argv[1]))
print(json.dumps({
  "paths": [str(p) for p in text_files],
  "prune_dirs": sorted(embed_walker.PRUNE_DIRS),
  "prune_prefixes": list(getattr(embed_walker, "PRUNE_PREFIXES", [])),
}))
`;
  return JSON.parse(execFileSync("python3", ["-c", script, root], { encoding: "utf8" }));
}

test("PRUNE_PREFIXES carries the two noise subtrees and bench is NOT a basename prune", () => {
  const r = walk(join(repoRoot, "tests", "fixtures", "exclusion-tree"));
  assert.ok(
    r.prune_prefixes.length >= 2,
    `PRUNE_PREFIXES missing or empty: ${JSON.stringify(r.prune_prefixes)}`,
  );
  assert.ok(
    r.prune_prefixes.some((p) => p.includes("/bench/runs/")),
    "PRUNE_PREFIXES must carry the /bench/runs/ path prefix",
  );
  assert.ok(
    r.prune_prefixes.some((p) => p.includes("/.claude/file-history/")),
    "PRUNE_PREFIXES must carry the /.claude/file-history/ path prefix",
  );
  // The original blocker: "bench" as a PRUNE_DIRS entry prunes by basename at
  // any depth, which would delete heimdall's own bench/*.py and 1,230 real
  // cards under ~/.bun/.../bench/ and ~/.config/harness-truth/bench/.
  assert.equal(
    r.prune_dirs.includes("bench"),
    false,
    '"bench" must NOT be in PRUNE_DIRS',
  );
});

test("bench/runs is skipped while bench/*.py and other bench/ dirs survive", (t) => {
  const root = join(repoRoot, "tests", "fixtures", "exclusion-tree");
  if (!existsSync(root)) return t.skip("fixture tree not present");

  const { paths } = walk(root);
  const has = (frag) => paths.some((p) => p.includes(frag));

  assert.equal(has("bench/runs"), false, "bench/runs must not be discovered");
  assert.equal(has("file-history"), false, ".claude/file-history must not be discovered");
  assert.equal(has("bench/recall.py"), true, "bench/*.py is real source and must survive");
  assert.equal(
    has("harness-truth/bench"),
    true,
    "an unrelated bench/ dir is real source and must survive",
  );
});
