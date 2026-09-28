// people-store.test.mjs — ~/.heimdall/people.db schema, ids, and query.
//
// RED for Phase 2. The id derivation is the sharp edge: a reviewer showed that
// hashing the raw (name, org) pair yields THREE different ids for one human
// ('Jane Doe', NULL) / ('Jane Doe', '') / ('Jane Doe', '   '), and
// `heimdall person add --name N` with no --org is the documented DEFAULT, so
// NULL-vs-'' is the common case rather than an edge case. The id must be a
// function of the normalized person, not of the strings as typed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PEOPLE_SCHEMA, idFor, openPeople, searchPeople, upsertPerson } from "../bin/lib/people.mjs";

const COLS = ["id", "name", "aliases", "org", "role", "url", "relationship",
  "last_contact", "notes", "identity_verified", "confidence", "source",
  "created_at", "updated_at"];

const withStore = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-people-"));
  try {
    return fn(openPeople(join(dir, "people.db")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("the schema carries every CRM-lite column, including the KB's own", () => {
  withStore((db) => {
    const cols = db.db.prepare("PRAGMA table_info(people)").all().map((r) => r.name);
    assert.deepEqual(cols, COLS);
    // The KBs all carry these two and many rows are candidly unverified;
    // dropping them would turn a documented unknown into a silent assertion.
    assert.ok(cols.includes("identity_verified"));
    assert.ok(cols.includes("confidence"));
  });
});

test("idFor collapses NULL, empty, and whitespace orgs to one id", () => {
  const a = idFor("Jane Doe", null);
  assert.equal(a, idFor("Jane Doe", ""), "NULL and '' must be the same person");
  assert.equal(a, idFor("Jane Doe", "   "), "whitespace org must be the same person");
  assert.match(a, /^person-[0-9a-f]{12}$/);
});

test("idFor is case- and whitespace-insensitive, and collision-safe", () => {
  assert.equal(idFor("Jane  Doe", "Acme"), idFor(" jane doe ", " ACME "));
  // NUL separator: ('ab','c') and ('a','bc') are different people.
  assert.notEqual(idFor("ab", "c"), idFor("a", "bc"));
});

test("re-adding the same person upserts instead of duplicating", () => {
  withStore((db) => {
    upsertPerson(db, { name: "Jane Doe", org: "Acme", source: "manual" });
    upsertPerson(db, { name: "jane  doe", org: "ACME", source: "manual", role: "Engineer" });
    const { n } = db.db.prepare("SELECT count(*) n FROM people").get();
    assert.equal(n, 1, "the same person was inserted twice");
    const row = db.db.prepare("SELECT * FROM people").get();
    assert.equal(row.role, "Engineer", "the second write did not update the row");
  });
});

test("different orgs are different people", () => {
  withStore((db) => {
    upsertPerson(db, { name: "Jane Doe", org: "Acme" });
    upsertPerson(db, { name: "Jane Doe", org: "Globex" });
    assert.equal(db.db.prepare("SELECT count(*) n FROM people").get().n, 2);
  });
});

test("searchPeople matches name, aliases, org, role and notes", () => {
  withStore((db) => {
    upsertPerson(db, {
      name: "Dinesh Sayana", aliases: "dsayana", org: "Temple University",
      role: "Research Assistant", notes: "ABS research",
    });
    for (const q of ["Sayana", "dsayana", "Temple", "Research", "ABS"]) {
      assert.equal(searchPeople(db, q).length, 1, `query ${q} found nothing`);
    }
  });
});

test("secret-shaped text is refused by the shared screen, not a local copy", () => {
  withStore((db) => {
    const res = upsertPerson(db, { name: "Jane", notes: "key sk-ABCDEFGHIJKLMNOPQRSTUVWX here" });
    assert.equal(res.skipped, true, "a secret-shaped note was stored");
    assert.equal(db.db.prepare("SELECT count(*) n FROM people").get().n, 0);
  });
});
test("searchPeople ranks an exact alias/name match first", () => {
  withStore((db) => {
    upsertPerson(db, { name: "Bill Mackenzie", aliases: "wilhelm", org: "X" });
    upsertPerson(db, { name: "Bill Adams", org: "Y" });
    const hits = searchPeople(db, "Bill");
    assert.equal(hits[0].name, "Bill Adams", "exact name match did not rank first");
    // The alias case: an exact alias hit must beat a partial name match, and
    // that is why the tiebreak is computed over BOTH columns, not just name.
    const byAlias = searchPeople(db, "wilhelm");
    assert.equal(byAlias[0].name, "Bill Mackenzie");
  });
});

test("a refused row is COUNTED, never silently dropped", () => {
  // Regression: the first import reported "mapped 1519, skipped 0" while
  // storing only 1510. upsertPerson refused 9 rows on the shared secret screen
  // and the caller never looked at the return value, so 9 real people vanished
  // with a clean report. The count must be visible in the report.
  withStore((db) => {
    const ok = upsertPerson(db, { name: "Fine Person", org: "Acme" });
    assert.equal(ok.skipped, false);
    // The REAL refused text, copied from the LinkedIn export, not invented:
    // 'AI startups' + 'rocketreach' inside one 40+ char run trips the shared
    // base64 class. A hand-shortened string would not reproduce it.
    const bad = upsertPerson(db, {
      name: "Andrew Zhang",
      identity_verified: "** yes — exact slug match (andrew-zhangg): "
        + "\"Co-Founder & CEO, Azure Partners | Advisor to AI startups\"; led "
        + "Columbia's AI Mastery program; RocketReach/TopContenders/Happenstance/"
        + "azurepartners.ai corroborate.",
    });
    assert.equal(bad.skipped, true, "the secret-shaped row was accepted");
    // A refused row must not be half-written.
    assert.equal(db.db.prepare("SELECT count(*) n FROM people").get().n, 1);
  });
});

test("a missing store is a valid empty result, not a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-people-missing-"));
  try {
    const { exists } = openPeople(join(dir, "nope", "people.db"), { create: false });
    assert.equal(exists, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PEOPLE_SCHEMA is idempotent", () => {
  withStore((db) => {
    assert.doesNotThrow(() => db.db.exec(PEOPLE_SCHEMA));
    assert.doesNotThrow(() => db.db.exec(PEOPLE_SCHEMA));
  });
});
