// insert-kind-person.test.mjs — kb_insert --kind person.
//
// RED for Phase 2. The dispatch ORDER is the contract: runInsert requires
// --title and --body and exits 1 without them, so a `--kind person` write has
// to short-circuit BEFORE that check or it can never succeed. And it must NOT
// fall through to the fact-card path — a person is not a fact, and writing
// ~/heimdall-notes/facts/<slug>.md for one would pollute the fact corpus.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openPeople, screenPerson, upsertPerson } from "../bin/lib/people.mjs";

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

test("person backup produces a snapshot that is VALID and COMPLETE under a live WAL reader", async () => {
  // BLOCKER from review. The old implementation did
  // `PRAGMA wal_checkpoint(FULL)` (busy result never checked) and then
  // copyFileSync'd the main db WITHOUT its WAL. Proven 3/3
  // "database disk image is malformed" with a reader holding a snapshot, and
  // it can also tear SILENTLY: exit 0, integrity_check ok, a row missing.
  // FULL cannot checkpoint frames younger than the oldest live reader, so it
  // is the wrong tool by construction, not by timing.
  const home = mkdtempSync(join(tmpdir(), "heimdall-bak-"));
  try {
    run(home, "person", "add", "--name", "Alice", "--org", "A");
    const dbPath = join(home, ".heimdall", "people.db");
    const reader = spawn("python3", ["-c",
      `import sqlite3,time
c=sqlite3.connect(${JSON.stringify(dbPath)})
c.execute("BEGIN")
c.execute("select count(*) from people").fetchall()
time.sleep(8)`], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1200));
    run(home, "person", "add", "--name", "Bob", "--org", "B");
    const r = run(home, "person", "backup");
    assert.equal(r.status, 0, `backup failed: ${r.stderr}`);

    const dir = join(home, ".heimdall", "backup");
    const snap = join(dir, readdirSync(dir)[0]);
    const out = execFileSync("python3", ["-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
bad=c.execute("PRAGMA integrity_check").fetchall()
names=sorted(r[0] for r in c.execute("select name from people"))
print(bad[0][0], names)`,
      snap], { encoding: "utf8" });
    assert.match(out, /^ok /, `snapshot is corrupt: ${out}`);
    // COMPLETE, not merely openable: the row written during the backup must
    // be present. A torn snapshot passes integrity_check while silently
    // losing a person, which is the worse failure.
    assert.match(out, /Alice/, `snapshot lost Alice: ${out}`);
    assert.match(out, /Bob/, `snapshot silently lost a row: ${out}`);
    reader.kill("SIGKILL");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a hand-maintained column survives a KB-style re-write", () => {
  // The clobbering-import shape: relationship/last_contact come from NO
  // source KB, so a routine import must not be able to erase them.
  const home = mkdtempSync(join(tmpdir(), "heimdall-imp-pres-"));
  try {
    run(home, "person", "add", "--name", "Zoe Quinn", "--org", "Acme",
      "--relationship", "college friend", "--last-contact", "2026-09-01");
    const db = join(home, ".heimdall", "people.db");
    const q = (sql) => execFileSync("python3", ["-c",
      `import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print(repr(c.execute(${JSON.stringify(sql)}).fetchall()))`, db],
      { encoding: "utf8" });
    // Exactly what an import row looks like: KB columns only.
    execFileSync("node", ["--input-type=module", "-e",
      `import {openPeople,upsertPerson} from ${JSON.stringify(join(repoRoot, "bin", "lib", "people.mjs"))};
       const s=openPeople(${JSON.stringify(db)});
       upsertPerson(s,{name:"Zoe Quinn",org:"Acme",source:"kb"});`]);
    const got = q("select relationship,last_contact from people");
    assert.match(got, /college friend/, "relationship was wiped by the re-write");
    assert.match(got, /2026-09-01/, "last_contact was wiped by the re-write");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("person subcommands reject unknown flags and bad values with exit 2", () => {
  // `verify --deeph` silently became a plain `verify` once; checkFlags exists
  // for that. person never called it. Also: `--kb bogus` exited 0 with a note
  // indistinguishable from the genuinely-absent personal KB.
  const home = mkdtempSync(join(tmpdir(), "heimdall-insp5-"));
  try {
    assert.equal(run(home, "person", "list", "--deeph").status, 2);
    const bad = run(home, "person", "import", "--kb", "bogus");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /valid: all/);
    assert.equal(run(home, "person", "list", "--limit", "abc").status, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an absent source value maps to null, never to an empty string", () => {
  // BLOCKER, second round. The mappers emitted '' for "no value in source".
  // The upsert preserves a stored value with COALESCE(excluded.col, col),
  // which only fires on NULL -- so '' sailed through and a routine re-import
  // destroyed hand-typed notes. Proven on the real X KB: crescely's notes
  // were wiped to '' by an ordinary import, and no KB carries notes, so
  // nothing could ever restore them.
  const home = mkdtempSync(join(tmpdir(), "heimdall-absent-"));
  try {
    run(home, "person", "add", "--name", "Crescely", "--notes", "hand-typed note");
    const db = join(home, ".heimdall", "people.db");
    // Exactly the shape an X row has: handle + empty bio, no other field.
    execFileSync("node", ["--input-type=module", "-e",
      `import {openPeople,upsertPerson} from ${JSON.stringify(join(repoRoot, "bin", "lib", "people.mjs"))};
       const s=openPeople(${JSON.stringify(db)});
       upsertPerson(s,{name:"Crescely",aliases:"crescely",url:"https://x.com/crescely",
         notes:null, identity_verified:null, confidence:null, source:"x-devabuilds-follower-kb"});`]);
    const got = execFileSync("python3", ["-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
print(repr(c.execute("select notes from people").fetchone()[0]))`, db], { encoding: "utf8" });
    assert.match(got, /hand-typed note/, "a null source value destroyed the stored note");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an explicit empty string still CLEARS a field", () => {
  // The other half of the contract: null means "source has nothing, keep
  // yours"; '' means "actually clear this". Fixing the blocker in SQL with
  // COALESCE(NULLIF(col,''), col) would have silently made this impossible
  // forever, so it is pinned here.
  const dir = mkdtempSync(join(tmpdir(), "heimdall-clear-"));
  try {
    const store = openPeople(join(dir, "people.db"));
    upsertPerson(store, { name: "Jane Doe", org: "Acme", notes: "old note" });
    upsertPerson(store, { name: "Jane Doe", org: "Acme", notes: "" });
    assert.equal(store.db.prepare("SELECT notes FROM people").get().notes, "",
      "an explicit '' did not clear the field");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the screen is what dry-run and the real run share", () => {
  // A dry run that cannot see what the screen will reject is not a preview:
  // it reported stored=1519/refused=0 where the real run stored 1510 and
  // refused 9. Both modes now call the same predicate, so pin the predicate
  // against the real refused string rather than a hand-shortened one.
  const row = { name: "Andrew Zhang",
    identity_verified: "** yes — exact slug match (andrew-zhangg): "
      + "\"Co-Founder & CEO, Azure Partners | Advisor to AI startups\"; led "
      + "Columbia's AI Mastery program; RocketReach/TopContenders/Happenstance/"
      + "azurepartners.ai corroborate." };
  assert.equal(screenPerson(row), "identity_verified", "the fixture no longer trips the screen");
  assert.equal(screenPerson({ name: "Fine Person" }), null);
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
