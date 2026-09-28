// long-output.test.mjs — --long prints full person rows, and only for people.
//
// RED for Phase 1. K7: the default hit line is reused, detail is opt-in, and
// `--long` without `--kind person` is a usage error (exit 2) rather than a
// silently ignored flag.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const shellTest = process.platform === "win32" ? test.skip : test;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARCH = join(repoRoot, "bin", "kb-search.sh");
const FIXED_HOME = join(tmpdir(), "heimdall-long-fixed");

// A people.db with one row, so --long has something to expand.
function fakeHome() {
  rmSync(FIXED_HOME, { recursive: true, force: true });
  const graft = join(FIXED_HOME, ".local", "bin", "graft");
  mkdirSync(dirname(graft), { recursive: true });
  writeFileSync(
    graft,
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"hits\":[{\"pointer\":\"src/alpha.py:1\",\"title\":\"alpha hit\",\"score\":2.0,\"snippet\":\"alpha example\"}]}'\n",
  );
  chmodSync(graft, 0o755);
  mkdirSync(join(FIXED_HOME, "Repos", "example", "graft"), { recursive: true });
  mkdirSync(join(FIXED_HOME, ".heimdall"), { recursive: true });

  execFileSync("python3", [
    "-c",
    `import sqlite3, os
db = ${JSON.stringify(join(FIXED_HOME, ".heimdall", "people.db"))}
c = sqlite3.connect(db)
c.execute("""CREATE TABLE people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT, org TEXT, role TEXT,
  url TEXT, relationship TEXT, last_contact TEXT, notes TEXT,
  identity_verified TEXT, confidence TEXT, source TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
c.execute("INSERT INTO people VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
  "person-abc123", "Dinesh Sayana", "dsayana", "Temple University",
  "Research Assistant", "https://linkedin.com/in/dsayana", None, None,
  "ABS research", "** no — unverified", "low", "test", "2026-01-01", "2026-01-02"))
c.commit(); c.close()`,
  ]);
  return FIXED_HOME;
}

const run = (home, ...args) =>
  spawnSync("bash", [SEARCH, "Sayana", "-n", "3", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined },
  });

shellTest("--kind person emits STRONG and never reports a dead anchor", () => {
  const home = fakeHome();
  try {
    const r = run(home, "--kind", "person");
    assert.equal(r.status, 0, `person search failed: ${r.stderr}`);
    assert.match(r.stdout, /\[STRONG\]/, "person hit is not STRONG");
    // The K6 blocker: routed through the verdict loop this is NOPATH, because
    // `people.db:<id>` is not a file and os.path.exists() is false.
    assert.doesNotMatch(r.stdout, /NOPATH/, "person hit rendered as a dead anchor");
    assert.doesNotMatch(r.stdout, /anchor is gone from disk/);
    assert.match(r.stdout, /Dinesh Sayana/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("--long adds the extra person fields", () => {
  const home = fakeHome();
  try {
    const compact = run(home, "--kind", "person");
    const long = run(home, "--kind", "person", "--long");
    assert.equal(long.status, 0);
    assert.match(long.stdout, /aliases: dsayana/);
    assert.match(long.stdout, /identity_verified:/);
    assert.match(long.stdout, /source: test/);
    // The compact line must still be a prefix of the long one (same format).
    assert.ok(
      compact.stdout.split("\n")[0] === long.stdout.split("\n")[0],
      "--long changed the header line",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("--long without --kind person is a usage error", () => {
  const home = fakeHome();
  try {
    const r = run(home, "--kind", "code", "--long");
    assert.equal(r.status, 2, `--long with --kind code should exit 2, got ${r.status}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Reviewer finding 1 (2026-09-28): a person/fact query must never fall through
// to the code leg, not even when its own store is empty. The original guard was
// `if ppl or facts: sys.exit(0)`, so an empty or missing store answered "who is
// X" with a list of Python files. Empty is an answer; leakage is not.
shellTest("an empty people store answers empty — no code hits leak in", () => {
  const home = fakeHome();
  try {
    rmSync(join(home, ".heimdall", "people.db"), { force: true });
    const r = spawnSync("bash", [SEARCH, "Sayana", "-n", "5", "--kind", "person"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined },
    });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /alpha hit/, "a code hit leaked into a person query");
    assert.doesNotMatch(r.stdout, /src\/alpha\.py/);
    assert.doesNotMatch(
      r.stdout,
      /retrieve \(per-repo graft/,
      "printed a code-leg header for a query that never ran the code legs",
    );
    assert.match(r.stdout, /No ~\/\.heimdall\/people\.db yet/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Reviewer finding 2: the person/fact dispatch must sit BEFORE the graft legs,
// so a pure people query does not pay ~15s of graft work it then discards.
shellTest("--kind person does not invoke graft at all", () => {
  const home = fakeHome();
  try {
    const marker = join(home, "graft-was-called");
    writeFileSync(
      join(home, ".local", "bin", "graft"),
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\nprintf '%s\\n' '{"hits":[]}'\n`,
    );
    chmodSync(join(home, ".local", "bin", "graft"), 0o755);
    const r = spawnSync("bash", [SEARCH, "Sayana", "-n", "2", "--kind", "person"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined },
    });
    assert.equal(r.status, 0);
    assert.equal(
      existsSync(marker),
      false,
      "--kind person still shelled out to graft",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
