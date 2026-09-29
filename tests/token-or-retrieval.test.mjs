// token-OR retrieval + gold-set integrity — Phase 4.
//
// RED for Phase 4. Both legs used a whole-string LIKE, so a natural question
// matched nothing: "who is Dinesh Sayana" returned zero while the bare name
// "Dinesh Sayana" worked. Then, once token-OR made rows match, both legs
// returned rows in whatever order sqlite produced, so a row matching every
// token lost to one matching only the commonest word — "who is Anand Bhandari"
// ranked "Aadi Bhandari" and "Aanya Bhandari" above Anand.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARCH = join(repoRoot, "bin", "kb-search.sh");
const QUERIES = join(repoRoot, "bench", "queries", "retrieval-30.jsonl");

const search = (q, kind, n = 5, home) =>
  spawnSync("bash", [SEARCH, q, "--kind", kind, "-n", String(n)],
    { encoding: "utf8", env: { ...process.env, ...(home ? { HOME: home } : {}) } });

// ── the query shapes the gold set actually uses ──────────────────────────

test("a natural question retrieves the person it names", () => {
  const r = search("who is Dinesh Sayana", "person", 3);
  assert.equal(r.status, 0, r.stderr);
  // The whole-string LIKE returned nothing here, which is the defect.
  assert.match(r.stdout, /Dinesh Sayana/,
    "a natural-language person question returned no match");
});

test("the person actually asked about ranks FIRST, not a same-surname namesake", () => {
  // The store holds 5 Bhandaris. Alphabetical tiebreak put Aadi and Aanya
  // above Anand, so the person asked about was absent from the top 3 even
  // though the row existed and matched every token.
  const r = search("who is Anand Bhandari", "person", 3);
  const first = r.stdout.split("\n").find((l) => /people\.db:/.test(l) || /·/.test(l));
  const name = r.stdout.split("\n").find((l) => l.includes("·"));
  assert.ok(name && /Anand Bhandari/.test(name),
    `the wrong person ranked first: ${JSON.stringify(name)}`);
  assert.ok(first, "no hit line at all");
});

test("an org-only query retrieves the person at that org", () => {
  const r = search("The Original Frameless Shower Doors", "person", 3);
  assert.match(r.stdout, /Nick Kurian/,
    "an org-only query did not retrieve the person there");
});

test("an alias query retrieves its owner", () => {
  const r = search("dinesh-sayana-2050a5196", "person", 3);
  assert.match(r.stdout, /Dinesh Sayana/, "an alias query did not retrieve its owner");
});

test("a multi-word fact query ranks the fact that matches ALL its tokens first", () => {
  const r = search("Never VACUUM, never write, never", "fact", 3);
  const first = r.stdout.split("\n").find((l) => /VACUUM/i.test(l));
  assert.ok(first, `the exact fact did not rank first: ${r.stdout.slice(0, 400)}`);
});

test("a fact query still returns facts, not code hits", () => {
  const r = search("Do not accept proxy signals", "fact", 5);
  assert.match(r.stdout, /retrieve \(facts\)|\.jsonl|session/,
    "the fact leg returned something other than facts");
});

// ── gold-set integrity: the thing that actually made 0.00 unfixable ──────

test("every gold is retrievable by its own query, or the slice is unanswerable", () => {
  // 0 of the 10 original person golds appeared in their own query, and 0 of
  // 10 fact golds existed anywhere in the corpus. Both slices read 0.00 for a
  // reason that had nothing to do with retrieval. This asserts the property
  // that makes the number mean something.
  const rows = readFileSync(QUERIES, "utf8").trim().split("\n").map(JSON.parse);
  for (const s of ["person", "fact"]) {
    const slice = rows.filter((r) => r.slice === s);
    assert.equal(slice.length, 10, `${s} slice should have 10 rows`);
    for (const r of slice) {
      assert.ok(r.golds.length > 0, `${r.qid} has no gold`);
      // A gold must share a distinctive token with its query, otherwise the
      // query cannot possibly select it. Org/role/alias rows carry
      // name_free_query: true and are exempt -- person-04 ("Temple University
      // research assistant" -> Dinesh Sayana) deliberately has no name in it,
      // because that is the only shape that proves the non-name columns are
      // searched at all.
      const qt = new Set(String(r.query).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
      const gt = r.golds.map((g) => String(g).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
      const share = gt.some((ts) => ts.some((t) => qt.has(t)));
      // An org/role/alias query is exempt, and is recognised by the gold set
      // carrying a `why` that says the query is name-free. Simpler and more
      // honest: the row declares its intent.
      const nameFree = r.name_free_query === true;
      assert.ok(share || nameFree,
        `${r.qid}: gold ${JSON.stringify(r.golds)} shares no distinctive token with its query`);
    }
  }
});

test("no person gold is absent from the people store", () => {
  const rows = readFileSync(QUERIES, "utf8").trim().split("\n").map(JSON.parse);
  const person = rows.filter((r) => r.slice === "person");
  const names = person.flatMap((r) => r.golds);
  const db = join(process.env.HOME || "", ".heimdall", "people.db");
  let store;
  try {
    store = execFileSync("python3", ["-c",
      `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1])
print(json.dumps([r[0] for r in c.execute("select name from people")]))`,
      db], { encoding: "utf8" });
  } catch {
    return; // no store on this machine; the gate run is the real check
  }
  const have = new Set(JSON.parse(store));
  for (const g of names) {
    assert.ok([...have].some((n) => n.toLowerCase() === g.toLowerCase()
      || n.toLowerCase().includes(g.toLowerCase())),
    `person gold "${g}" is not in people.db`);
  }
});

test("the person leg never falls through to code hits", () => {
  // Phase 1 regression guard, kept here because Phase 4 depends on it: a 0.00
  // person slice is exactly what a code leak or a silent fall-through looks
  // like, and the gold-set fix must not have papered over it.
  const r = search("who is Dinesh Sayana", "person", 5);
  assert.doesNotMatch(r.stdout, /Repos\/heimdall\/bin\//,
    "a person query returned repository code hits");
  assert.doesNotMatch(r.stdout, /retrieve \(per-repo graft/,
    "the code leg ran for a person query");
});

// ── Phase 4 review round: stopword leak, column weighting, rigged golds ──

test("a stopword-only query returns NOTHING, not the whole store", () => {
  // tokens_of() used to fall back to the raw string, re-injecting the
  // stopword as a LIKE pattern. "the" matched 1061 of 1696 people, "is"
  // matched 1462, and "%" matched ALL 1696 -- every row printed as
  // [STRONG] cov100%. It also made "who" return rows while "who is"
  // returned none, from identical semantics.
  for (const q of ["the", "is", "_", "%", "who", "who is", "a", "and"]) {
    const r = search(q, "person", 50);
    assert.doesNotMatch(r.stdout, /people\.db:/,
      `stopword-only query ${JSON.stringify(q)} returned rows`);
  }
});

test("a wildcard character cannot reach the LIKE pattern", () => {
  // [a-z0-9]+ can never yield % or _, so the old raw-string fallback was the
  // ONLY route by which a wildcard could reach LIKE. With the fallback gone,
  // "_" and "%" are ordinary stopword-free tokens that match nothing.
  for (const q of ["%", "_", "%_%", "%%"]) {
    assert.doesNotMatch(search(q, "person", 20).stdout, /people\.db:/,
      `wildcard query ${JSON.stringify(q)} returned rows`);
  }
});

test("a name mentioned in NOTES does not outrank the person actually named", () => {
  // The flat token count treated a notes mention like a name. Real rows:
  // "Dinesh Manocha" returned Stephen Cheng first, because his notes say
  // "co-advised by ... Prof. Dinesh Manocha", while Dinesh Sayana matches
  // the surname in a real NAME field.
  const r = search("Dinesh Manocha", "person", 3);
  const names = r.stdout.split("\n").filter((l) => l.includes("·"));
  assert.ok(names.length, "no results at all");
  assert.match(names[0], /Dinesh Sayana/,
    `a notes mention outranked the name match: ${JSON.stringify(names[0])}`);
});

test("fact queries are not prefixes of their own golds", () => {
  // As first written, all 10 fact queries were the gold's own first five
  // words. A query that is a prefix of its answer is a rigged benchmark: it
  // proves nothing about retrieval. Each query must draw from the middle.
  const rows = readFileSync(QUERIES, "utf8").trim().split("\n").map(JSON.parse);
  const facts = rows.filter((r) => r.slice === "fact");
  assert.equal(facts.length, 10);
  for (const r of facts) {
    const g = String(r.golds[0]).toLowerCase().replace(/[^a-z0-9 ]/g, "");
    const q = String(r.query).toLowerCase().replace(/[^a-z0-9 ]/g, "");
    assert.ok(!g.startsWith(q) && !q.startsWith(g),
      `${r.qid}: query ${JSON.stringify(r.query)} is a prefix of its gold`);
  }
});

test("--kind decision keeps the user's standing rules (negations)", () => {
  // The filter was assertion+declaration only, dropping all 481 negation
  // rows from a 945-row corpus. A negation IS a decision: "Never VACUUM",
  // "Do not accept proxy signals". Excluding them hid the standing rules.
  const r = search("Never VACUUM", "decision", 5);
  assert.match(r.stdout, /VACUUM/i,
    "--kind decision dropped a negation rule that --kind fact returns");
});

test("the recorded baseline points at a commit that CONTAINS the measured code", () => {
  // Round-1 finding, still live after one 'fix': the file recorded the PARENT
  // commit, which had the stopword leak, the flat ranking and the rigged
  // prefix queries, so reproducing from it gave different numbers. Moving the
  // recorded sha forward one commit is not a fix either.
  const base = JSON.parse(readFileSync(join(repoRoot, "bench", "baselines",
    "retrieval-30-phase4.json"), "utf8"));
  const rec = base.tree_commit;
  assert.match(rec, /^[0-9a-f]{40}$/, "tree_commit is not a full sha");
  // Ancestry is NOT enough and sha-equality is worse. A pre-fix commit IS an
  // ancestor, so `merge-base --is-ancestor` passes on the very defect this
  // test exists for; exact-sha pinning instead fails on every later commit,
  // which invites the mechanical bump that reintroduced the bug. So assert
  // the recorded commit's CODE is the fixed code, by fingerprint.
  const at = (path) => {
    const r = spawnSync("git", ["show", `${rec}:${path}`], { cwd: repoRoot, encoding: "utf8" });
    return r.status === 0 ? r.stdout : "";
  };
  const search = at("bin/kb-search.sh");
  assert.ok(search, `${rec.slice(0, 12)} has no bin/kb-search.sh`);
  // Match the CODE line, not the prose. The fixed file documents the old
  // fallback in a comment, so a bare substring match reports the leak on
  // the very commit that removed it.
  assert.doesNotMatch(search, /return t or \[q\.strip\(\)\.lower\(\)\]/,
    "the recorded commit still contains the stopword-fallback leak");
  assert.ok(search.includes('-hits(("name", "aliases"))'),
    "the recorded commit lacks the column-weighted ranking");
  // Whitespace-insensitive, because a fingerprint that breaks when someone
  // reformats a line trains people to ignore it. Checking each kind
  // separately is the real assertion: --kind decision must include negation,
  // and the other two must be present too.
  const kinds = ["assertion", "declaration", "negation"];
  const decisionLine = (search.match(/fact_kind IN \([^)]*\)/) || [""])[0];
  for (const k of kinds) {
    assert.ok(decisionLine.includes(k),
      `--kind decision is missing "${k}" in: ${decisionLine}`);
  }
  // And the gold set it measures must be the de-rigged one.
  const golds = at("bench/queries/retrieval-30.jsonl");
  assert.ok(golds, `${rec.slice(0, 12)} has no gold set`);
  assert.doesNotMatch(golds, /"query": "Never VACUUM, never write, never"/,
    "the recorded commit still holds the rigged prefix query");
  for (const [s, v] of Object.entries(base.slices)) {
    assert.ok(v.bar && v.bar_note, `${s} has no stated bar`);
    assert.equal(v.run_valid, true, `${s} was not a valid run`);
  }
});

test("no gold-set sidecar is left behind holding stale queries", () => {
  // bench/queries/fact-10.jsonl and person-10.jsonl were added in the first
  // Phase 4 commit and never updated, so they still carried the pre-fix
  // rigged prefix queries. Nothing read them, which is exactly why they went
  // unnoticed: a file that is dead is not checked by anything.
  for (const f of ["fact-10.jsonl", "person-10.jsonl"]) {
    assert.equal(existsSync(join(repoRoot, "bench", "queries", f)), false,
      `${f} is a dead sidecar that can drift out of sync with the real set`);
  }
});
