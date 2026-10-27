// people.mjs — the people store (2026-09-28 retrieval spec, P1–P6).
//
// A separate ~/.heimdall/people.db rather than a table on journal.db: the
// journal is the hot single-writer surface the reconciler owns, and this is a
// read-mostly workload with no reconcile semantics. Isolating it means a
// schema mistake here cannot take the reconciler down.
//
// Reuses facts.mjs's `norm` and `isSecret` rather than declaring a second copy:
// a second secret regex is a trust-boundary bug waiting to happen.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isSecret, norm } from "./facts.mjs";

export const PEOPLE_DB = () => join(homedir(), ".heimdall", "people.db");

export const PEOPLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  aliases          TEXT,
  org              TEXT,
  role             TEXT,
  url              TEXT,
  relationship     TEXT,
  last_contact     TEXT,
  notes            TEXT,
  identity_verified TEXT,
  confidence       TEXT,
  source           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS people_name ON people(name);
`;

/**
 * Deterministic id for a person.
 *
 * Normalizing BEFORE hashing is the whole point. Hashing the raw pair yields
 * three different ids for one human — ('Jane Doe', NULL), ('Jane Doe', ''),
 * ('Jane Doe', '   ') — and `person add --name N` with no --org is the
 * documented default, so that is the common case, not an edge case.
 *
 * NUL separates the halves so ('ab','c') cannot collide with ('a','bc'). The
 * separator is written as a \u0000 escape, not a raw NUL byte: a literal NUL
 * made this file register as binary in git, so `git diff` printed
 * 'Bin 0 -> 5486 bytes' and `git grep` refused to search it at all. An
 * unreviewable source file is a review bug, not a cosmetic one.
 */
export function idFor(name, org) {
  const left = norm(String(name ?? "")).toLowerCase();
  const right = norm(String(org ?? "")).toLowerCase();
  return "person-" + createHash("sha256")
    .update(`${left}\u0000${right}`)
    .digest("hex")
    .slice(0, 12);
}

export function openPeople(path = PEOPLE_DB(), { create = true } = {}) {
  const existed = existsSync(path);
  if (!existed && !create) return { exists: false, db: null, path };
  if (!existed) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(PEOPLE_SCHEMA);
  return { exists: true, db, path };
}

// A row is refused if a field is secret-shaped. The screen is the SHARED one
// from facts.mjs, deliberately: a second secret regex would be a second trust
// boundary (2026-08-23 spec D3).
//
// ponytail: known false positives, NOT fixed here. The generic base64 class
// `\\b[A-Za-z0-9+/]{40,}=*\\b` matches any 40+ char run of those chars, and the
// people KBs are full of English prose that trips it -- measured on the real
// LinkedIn export: 9 of 1,519 rows were refused for text like
// "DuckDuckGo/Google/Brave/Yandex/Mojeek/Startpage" (a list of search
// engines) and quoted search queries. Tightening the shared pattern would
// change fact extraction too, so that is its own change with its own tests.
// What matters here is that the refusal is LOUD (see importKb's `refused`
// counter) rather than silent, so a dropped person is visible.
// Every writable text column is screened. A previous version used a
// hardcoded 8-name list that omitted relationship and last_contact, both of
// which are CLI-writable and both of which stored a token verbatim.
// ponytail: a whitelist silently misses columns the schema gains later --
// derive from the schema instead when someone adds one.
const SCREENED = ["name", "aliases", "org", "role", "url", "relationship",
  "last_contact", "notes", "identity_verified", "confidence"];

// Returns the offending field name, or null. Exported so a dry run can ask
// the same question without writing: the dry run must not be a weaker check
// than the real run, or it is not a preview of the real run.
export function screenPerson(p) {
  for (const f of SCREENED) {
    if (p[f] && isSecret(String(p[f]))) return f;
  }
  return null;
}
export function upsertPerson(store, p) {
  const bad = screenPerson(p);
  if (bad) return { skipped: true, field: bad, id: null };
  const now = new Date().toISOString();
  const id = idFor(p.name, p.org);
  // COALESCE on every updatable column, and the insert passes p.x ?? null.
  // Without it, a sparse write NULLs everything it does not mention: proven
  // end-to-end, `person add --relationship 'college friend' --last-contact
  // 2026-09-01` followed by a plain re-add, or a routine KB import, wiped
  // the only non-derived user data in the store. Those two columns appear in
  // NO source KB, so a clobbering import silently destroyed them forever.
  // created_at is never in the update set, so it is genuinely preserved.
  // updated_at advances only when a column ACTUALLY changed: stamping it
  // unconditionally made a no-op re-import look like a modification, so
  // "has this person changed since last sync?" was unanswerable (measured:
  // 44/44 X rows churned on an identical re-import).
  store.db.prepare(`
    INSERT INTO people (id, name, aliases, org, role, url, relationship,
      last_contact, notes, identity_verified, confidence, source,
      created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      aliases=COALESCE(excluded.aliases, aliases),
      role=COALESCE(excluded.role, role),
      url=COALESCE(excluded.url, url),
      relationship=COALESCE(excluded.relationship, relationship),
      last_contact=COALESCE(excluded.last_contact, last_contact),
      notes=COALESCE(excluded.notes, notes),
      identity_verified=COALESCE(excluded.identity_verified, identity_verified),
      confidence=COALESCE(excluded.confidence, confidence),
      source=COALESCE(excluded.source, source),
      updated_at=CASE WHEN
        aliases IS NOT excluded.aliases OR role IS NOT excluded.role
        OR url IS NOT excluded.url OR relationship IS NOT excluded.relationship
        OR last_contact IS NOT excluded.last_contact OR notes IS NOT excluded.notes
        OR identity_verified IS NOT excluded.identity_verified
        OR confidence IS NOT excluded.confidence OR source IS NOT excluded.source
      THEN excluded.updated_at ELSE people.updated_at END
  `).run(id, p.name, p.aliases ?? null, p.org ?? null, p.role ?? null,
    p.url ?? null, p.relationship ?? null, p.last_contact ?? null,
    p.notes ?? null, p.identity_verified ?? null, p.confidence ?? null,
    p.source ?? null, now, now);
  return { skipped: false, id };
}

const MATCH_COLS = ["name", "aliases", "org", "role", "notes"];

export function searchPeople(store, q, limit = 10) {
  if (!store.exists) return [];
  const like = "%" + q + "%";
  // Plain `?` repeated once per column, NOT the numbered `?1` reused five times.
  //
  // Measured 2026-10-23 on the exact CI matrix: node 22's node:sqlite throws
  // `column index out of range` for a re-used numbered parameter, while node 26
  // accepts it. ci.yml pins node-version 22, so this shipped green only because
  // this machine happens to run node 26 — `searchPeople` was broken on every
  // supported runner. Passing the same value N times is boring and correct on
  // both, and it needs no version sniffing.
  const sql = `SELECT * FROM people WHERE ${MATCH_COLS.map((c) => `${c} LIKE ?`).join(" OR ")}`;
  const rows = store.db.prepare(sql).all(...MATCH_COLS.map(() => like));
  // The exact-match tiebreak runs HERE, in JS, not in SQL. A SQL compare
  // against the comma-joined alias string is wrong — it only fires when the
  // person has no aliases at all, which is the exact defect a previous review
  // caught. Rows are few, so ranking after the fetch is simpler and exact.
  const needle = String(q).trim().toLowerCase();
  const exact = (r) =>
    (r.name || "").toLowerCase() === needle ||
    (r.aliases || "").split(",").map((s) => s.trim().toLowerCase()).includes(needle);
  return rows
    .sort((a, b) => Number(exact(b)) - Number(exact(a)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
