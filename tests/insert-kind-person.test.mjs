// insert-kind-person.test.mjs — kb_insert --kind person.
//
// RED for Phase 2. The dispatch ORDER is the contract: runInsert requires
// --title and --body and exits 1 without them, so a `--kind person` write has
// to short-circuit BEFORE that check or it can never succeed. And it must NOT
// fall through to the fact-card path — a person is not a fact, and writing
// ~/heimdall-notes/facts/<slug>.md for one would pollute the fact corpus.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(repoRoot, "bin", "heimdall.js");

const run = (home, ...args) =>
  spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: process.env.PATH },
  });

test("insert --kind person writes a person row without needing --title/--body", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-insp-"));
  try {
    const r = run(home, "insert", "--kind", "person", "--name", "Dinesh Sayana",
      "--org", "Temple University");
    assert.equal(r.status, 0, `insert failed: ${r.stderr}`);
    assert.match(r.stdout, /person-[0-9a-f]{12}/);

    const db = join(home, ".heimdall", "people.db");
    assert.ok(existsSync(db), "people.db was not created");
    const out = execFileSync("python3", ["-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
r=c.execute("select name,org from people").fetchone()
print(repr(r))`, db], { encoding: "utf8" });
    assert.match(out, /Dinesh Sayana/);
    assert.match(out, /Temple University/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("insert --kind person does NOT create a fact card", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-insp2-"));
  try {
    run(home, "insert", "--kind", "person", "--name", "Jane Doe");
    const factsDir = join(home, "heimdall-notes", "facts");
    const cards = existsSync(factsDir) ? readdirSync(factsDir) : [];
    assert.deepEqual(cards, [], `person write leaked ${cards.length} fact card(s)`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("person add / rm / list round-trip through the CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-insp3-"));
  try {
    assert.equal(run(home, "person", "add", "--name", "Jane Doe", "--org", "Acme").status, 0);
    const list = run(home, "person", "list");
    assert.equal(list.status, 0);
    assert.match(list.stdout, /Jane Doe/);
    assert.equal(run(home, "person", "rm", "--name", "Jane Doe", "--org", "Acme").status, 0);
    assert.doesNotMatch(run(home, "person", "list").stdout, /Jane Doe/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("person backup writes a restorable snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-insp4-"));
  try {
    run(home, "person", "add", "--name", "Jane Doe");
    const r = run(home, "person", "backup");
    assert.equal(r.status, 0, r.stderr);
    const dir = join(home, ".heimdall", "backup");
    const snaps = readdirSync(dir);
    assert.ok(snaps.some((f) => f.startsWith("people.db.")), "no snapshot written");
    // The snapshot must be a real, readable database, not a zero-byte copy.
    const out = execFileSync("python3", ["-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
print(c.execute("select count(*) from people").fetchone()[0])`,
      join(dir, snaps[0])], { encoding: "utf8" });
    assert.equal(out.trim(), "1", "the backup does not contain the row");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the CSV reader handles the KBs' quoted multi-line fields", () => {
  // A naive split(",") corrupts these files: interests/outreach are quoted
  // blocks containing both commas and newlines.
  const csv = 'a,b\n"one, two\nline two",plain\n';
  const script = join(repoRoot, "bin", "lib", "people-cli.mjs");
  assert.ok(existsSync(script));
  const out = execFileSync("node", ["--input-type=module", "-e",
    `import {parseCsv} from ${JSON.stringify(script)};
     const r = parseCsv(${JSON.stringify(csv)});
     process.stdout.write(JSON.stringify(r));`], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), [{ a: "one, two\nline two", b: "plain" }]);
});
