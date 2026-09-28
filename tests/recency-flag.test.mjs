// recency-flag.test.mjs — --recency weighting (spec K4, default OFF).
//
// RED for Phase 1. Two properties matter and both were previously impossible
// to assert:
//   1. with the flag OFF the output is unchanged (byte-identity, in the sibling
//      kinds-default-identical test);
//   2. with it ON, hits WITHOUT a card keep weight 1.0. The first draft of
//      this spec said "mtime absent => infinitely old => weight 0", which would
//      have silently demoted EVERY graft-only hit to zero — graft hits have no
//      cards at all, so on a graft-only machine the flag would empty the
//      result set.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const shellTest = process.platform === "win32" ? test.skip : test;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARCH = join(repoRoot, "bin", "kb-search.sh");
const FIXED_HOME = join(tmpdir(), "heimdall-recency-fixed");

function fakeHome() {
  rmSync(FIXED_HOME, { recursive: true, force: true });
  const graft = join(FIXED_HOME, ".local", "bin", "graft");
  mkdirSync(dirname(graft), { recursive: true });
  writeFileSync(
    graft,
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"hits\":[{\"pointer\":\"src/alpha.py:1\",\"title\":\"alpha hit\",\"score\":2.0,\"snippet\":\"alpha example\"},{\"pointer\":\"src/beta.py:2\",\"title\":\"beta hit\",\"score\":1.0,\"snippet\":\"beta example\"}]}'\n",
  );
  chmodSync(graft, 0o755);
  mkdirSync(join(FIXED_HOME, "Repos", "example", "graft"), { recursive: true });
  return FIXED_HOME;
}

const run = (home, ...args) =>
  spawnSync("bash", [SEARCH, "example", "-n", "2", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined },
  });

shellTest("--recency off (default) leaves the output untouched", () => {
  const home = fakeHome();
  try {
    const bare = run(home);
    const off = run(home, ["--recency"]); // flag present but no cards at all
    assert.equal(bare.status, 0);
    assert.equal(off.status, 0);
    // No global.db in the fake home => no card mtimes => every hit keeps
    // weight 1.0 => byte-identical. This is the property the old spec got
    // backwards.
    assert.equal(off.stdout, bare.stdout, "--recency changed hits that have no card");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("--recency is accepted on every kind and never errors", () => {
  const home = fakeHome();
  try {
    for (const kind of ["code", "person", "fact", "all"]) {
      const r = run(home, "--kind", kind, "--recency");
      assert.notEqual(r.status, 2, `--kind ${kind} --recency was rejected`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("--recency with --kind person is a no-op, not an error", () => {
  // K4 scopes recency to code cards; people are timeless (P5). The flag is
  // accepted and ignored.
  const home = fakeHome();
  try {
    const withFlag = run(home, "--kind", "person", "--recency");
    const without = run(home, "--kind", "person");
    assert.equal(withFlag.status, without.status);
    assert.equal(withFlag.stdout, without.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
