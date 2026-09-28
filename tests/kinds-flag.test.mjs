// kinds-flag.test.mjs — --kind parsing/validation and the exit-2 contract.
//
// RED for Phase 1. The pre-change script has a bare `*) shift ;;` in its flag
// loop (kb-search.sh:27), so every unknown flag is silently swallowed and the
// only exit code is the 1 that `${1:?}` produces. These tests pin the
// contract the spec requires: an unknown FLAG and an unknown KIND both exit 2
// with the valid list, and a valid kind is accepted.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const shellTest = process.platform === "win32" ? test.skip : test;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARCH = join(repoRoot, "bin", "kb-search.sh");

// A home with a fake graft and one graft-bearing repo, so the script gets past
// every "nothing to search" pre-backend exit and actually reaches flag parsing
// and the query legs.
const fakeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-kinds-"));
  const graft = join(home, ".local", "bin", "graft");
  mkdirSync(dirname(graft), { recursive: true });
  writeFileSync(
    graft,
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"hits\":[{\"pointer\":\"src/file.py:1\",\"title\":\"Expected hit\",\"score\":1,\"snippet\":\"example\"}]}'\n",
  );
  chmodSync(graft, 0o755);
  mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true });
  return home;
};

const run = (home, args) =>
  spawnSync("bash", [SEARCH, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined },
  });

shellTest("--kind with an unknown value exits 2 and names the valid kinds", () => {
  const home = fakeHome();
  try {
    const r = run(home, ["example", "--kind", "banana"]);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
    assert.match(r.stderr, /person/);
    assert.match(r.stderr, /decision/);
    assert.match(r.stderr, /fact/);
    assert.match(r.stderr, /code/);
    assert.match(r.stderr, /all/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("an unknown flag exits 2 instead of being silently swallowed", () => {
  const home = fakeHome();
  try {
    // Pre-change this printed results and exited 0: `*) shift ;;` ate the flag.
    const r = run(home, ["example", "--deeph"]);
    assert.equal(r.status, 2, `expected exit 2 for an unknown flag, got ${r.status}`);
    assert.match(r.stderr, /--deeph/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("an empty query exits 2 (pre-change it exited 1)", () => {
  const home = fakeHome();
  try {
    const r = run(home, ["", "-n", "2"]);
    assert.equal(r.status, 2, `expected exit 2 for an empty query, got ${r.status}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("every valid --kind value is accepted and exits 0", () => {
  const home = fakeHome();
  try {
    for (const kind of ["code", "fact", "person", "decision", "all"]) {
      const r = run(home, ["example", "--kind", kind, "-n", "2"]);
      assert.notEqual(r.status, 2, `--kind ${kind} was rejected as unknown`);
      assert.notEqual(
        r.status,
        1,
        `--kind ${kind} exited 1 (stderr: ${r.stderr.slice(0, 200)})`,
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("--kind with no value exits 2 rather than consuming the next flag", () => {
  const home = fakeHome();
  try {
    const r = run(home, ["example", "--kind", "--scope"]);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
