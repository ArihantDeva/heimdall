// kinds-default-identical.test.mjs — the no-flag path is byte-identical.
//
// This is the spec's K1/K4/A1 promise: adding --kind/--recency/--long must not
// change one byte of the default output. The existing tests/kb-search.test.mjs
// only asserts a SUBSTRING (/Expected hit/), which cannot detect a changed
// column, a reordered hit, or a vanished token. So this file captures the
// complete stdout and compares it to a committed golden.
//
// The golden is a GENERATED constant. Run this test once with
//   UPDATE_GOLDEN=1 node --test tests/kinds-default-identical.test.mjs
// to re-record it, and read the diff before committing — a golden that is
// regenerated to match a regression is worse than no golden.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const shellTest = process.platform === "win32" ? test.skip : test;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARCH = join(repoRoot, "bin", "kb-search.sh");
const GOLDEN = join(repoRoot, "tests", "fixtures", "kb-search-default.golden");

// Two fixed hits so the golden pins ORDER, not just presence.
const FIXTURE_GRAFT = `#!/usr/bin/env bash
cat <<'JSON'
{"hits":[
 {"pointer":"src/alpha.py:1","title":"alpha hit","score":2.0,"snippet":"alpha example"},
 {"pointer":"src/beta.py:2","title":"beta hit","score":1.0,"snippet":"beta example"}
]}
JSON
`;

// The hit lines carry the absolute path, which includes $HOME. A mkdtemp()
// home would bake a RANDOM path into the golden and never match again, so the
// home is a fixed name under the OS temp dir and the whole tree is removed
// after each run.
const FIXED_HOME = join(tmpdir(), "heimdall-golden-fixed");

function fakeHome() {
  rmSync(FIXED_HOME, { recursive: true, force: true });
  const graft = join(FIXED_HOME, ".local", "bin", "graft");
  mkdirSync(dirname(graft), { recursive: true });
  writeFileSync(graft, FIXTURE_GRAFT);
  chmodSync(graft, 0o755);
  mkdirSync(join(FIXED_HOME, "Repos", "example", "graft"), { recursive: true });
  return FIXED_HOME;
}

const search = (home, args = []) =>
  spawnSync("bash", [SEARCH, "example", "-n", "2", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined },
  });

shellTest("default output is byte-identical to the committed golden", () => {
  const home = fakeHome();
  try {
    const r = search(home);
    assert.equal(r.status, 0, `search failed: ${r.stderr}`);
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(GOLDEN, r.stdout);
      return;
    }
    const expected = readFileSync(GOLDEN, "utf8");
    assert.equal(
      r.stdout,
      expected,
      "default kb_search output changed. If this is intentional, re-record with " +
        "UPDATE_GOLDEN=1 and read the diff — the spec requires the no-flag " +
        "path to be byte-identical.",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("passing --kind code is byte-identical to passing no flag", () => {  // K1: --kind code IS the default path. If these ever differ, the enum is not
  // wired the way the spec describes and the default promise is unreliable.
  const home = fakeHome();
  try {
    const bare = search(home);
    const code = search(home, ["--kind", "code"]);
    assert.equal(bare.status, 0);
    assert.equal(code.status, 0);
    assert.equal(code.stdout, bare.stdout, "--kind code changed the default output");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
