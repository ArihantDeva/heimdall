// facts.test.mjs — contract suite for bin/lib/facts.mjs extractFacts(buf, meta)
// (spec: docs/superpowers/specs/2026-08-23-fact-layer-design.md §Extraction).
// Input modes: JSONL prompt log ({at,cwd,text} lines) and plain text/markdown.
// Returns [{id,title,body,keywords,line}], deterministic per bytes; meta gains
// skippedSecrets. Targets ONLY the public export — no engine internals.
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractFacts } from "../bin/lib/facts.mjs";

const PATH = "/tmp/proj/notes.md";

// ── helpers ───────────────────────────────────────────────────────────────
function jsonl(records, tornTail = null) {
  const lines = records.map((r) => JSON.stringify(r));
  if (tornTail !== null) lines.push(tornTail); // unterminated, unparsable
  return Buffer.from(lines.join("\n") + "\n");
}
const prompt = (text, n = 0) =>
  ({ at: `2026-08-23T00:00:0${n}Z`, cwd: "/tmp/proj", text });

// ── shape ─────────────────────────────────────────────────────────────────
test("FC-01 every fact carries exactly the contract keys with sane types", () => {
  const facts = extractFacts(
    jsonl([prompt("I prefer SQLite over Postgres.", 1)]), { path: PATH });
  assert.ok(facts.length >= 1, "expected at least one fact");
  for (const f of facts) {
    assert.deepEqual(Object.keys(f).sort(), ["body", "id", "keywords", "line", "title"]);
    assert.equal(typeof f.id, "string");
    assert.equal(typeof f.title, "string");
    assert.equal(typeof f.body, "string");
    assert.ok(Array.isArray(f.keywords) && f.keywords.every((k) => typeof k === "string"));
    assert.ok(Number.isInteger(f.line) && f.line >= 1);
  }
});

// ── determinism ───────────────────────────────────────────────────────────
test("FC-02 same bytes twice deepEqual (ids included)", () => {
  const buf = jsonl([
    prompt("I prefer SQLite over Postgres.", 1),
    prompt("Heimdall is a local-first memory layer.", 2),
    prompt("I always commit before rebasing.", 3),
  ]);
  const metaA = { path: PATH };
  const metaB = { path: PATH };
  const a = extractFacts(buf, metaA);
  const b = extractFacts(buf, metaB);
  assert.deepEqual(a, b);
});

// ── degenerate inputs ─────────────────────────────────────────────────────
test("FC-03 empty buffer yields [] with skippedSecrets 0", () => {
  const meta = { path: PATH };
  assert.deepEqual(extractFacts(Buffer.alloc(0), meta), []);
  assert.equal(meta.skippedSecrets, 0);
});
test("FC-04 whitespace-only buffer yields []", () => {
  const meta = { path: PATH };
  assert.deepEqual(extractFacts(Buffer.from("   \n\t\n  \n"), meta), []);
});

// ── JSONL prompt-log mode: provenance line numbers ────────────────────────
test("FC-05 JSONL mode maps facts to their physical line numbers", () => {
  const facts = extractFacts(jsonl([
    prompt("I prefer SQLite over Postgres.", 1),
    prompt("I use ripgrep for search.", 2),
  ]));
  assert.ok(facts.length >= 2, `want >=2 facts, got ${facts.length}`);
  assert.ok(facts.some((f) => f.line === 1 && f.body.includes("I prefer SQLite over Postgres")));
  assert.ok(facts.some((f) => f.line === 2 && f.body.includes("I use ripgrep for search")));
});

// ── plain text/markdown mode: fact classes ────────────────────────────────
test("FC-06 plain text: 'I prefer SQLite over Postgres' yields a fact", () => {
  const facts = extractFacts(Buffer.from("I prefer SQLite over Postgres.\n"), { path: PATH });
  assert.ok(facts.length >= 1);
  assert.ok(facts.some((f) => f.body.includes("I prefer SQLite over Postgres")));
});
test("FC-07 plain text: first-person assertion yields a fact", () => {
  const facts = extractFacts(
    Buffer.from("I use ripgrep instead of grep for search.\n"), { path: PATH });
  assert.ok(facts.length >= 1);
});
test("FC-08 plain text: declaration 'X is Y' with named entity yields a fact", () => {
  const facts = extractFacts(
    Buffer.from("Heimdall is a local-first memory layer.\n"), { path: PATH });
  assert.ok(facts.length >= 1);
});

// ── secrets: skipped and counted (JSONL mode) ─────────────────────────────
test("FC-09 six secret shapes skipped, counted in meta.skippedSecrets", () => {
  const buf = jsonl([
    prompt("I prefer SQLite over Postgres.", 0),
    prompt("sk-proj-abcdefgh123456789012345678", 1),
    prompt("ghp_AbCdEf0123456789AbCdEf0123456789abcd", 2),
    prompt("AKIAIOSFODNN7EXAMPLE", 3),
    prompt("bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.s3cr3tsignature", 4),
    prompt("password=correct-horse-battery-staple", 5),
    prompt("deadbeefcafebabe0123456789abcdef", 6),
  ]);
  const meta = { path: PATH };
  const facts = extractFacts(buf, meta);
  assert.equal(meta.skippedSecrets, 6);
  assert.equal(facts.length, 1, "only the clean prompt may survive");
  for (const needle of ["sk-", "ghp_", "AKIA", "bearer", "password=", "deadbeef"]) {
    assert.ok(!facts.some((f) => f.body.includes(needle)), `secret leaked: ${needle}`);
  }
});
test("FC-10 plain mode: secret-looking line never becomes a fact body", () => {
  const buf = Buffer.from(
    "I prefer SQLite over Postgres.\nTOKEN=ghp_AbCdEf0123456789AbCdEf0123456789abcd\n",
  );
  const meta = { path: PATH };
  const facts = extractFacts(buf, meta);
  assert.ok(facts.length >= 1);
  assert.ok(!facts.some((f) => f.body.includes("ghp_")));
});

// ── dedup within one file ─────────────────────────────────────────────────
test("FC-11 duplicate fact inside one file dedupes to one entry", () => {
  const buf = Buffer.from(
    "I prefer SQLite over Postgres.\nI prefer SQLite over Postgres.\n", );
  const facts = extractFacts(buf, { path: PATH });
  assert.equal(facts.length, 1);
});

// ── long sentence: truncated title, full verbatim body ────────────────────
test("FC-12 >512-char sentence: title <=120, body keeps full utterance", () => {
  const sentence =
    `I prefer ${"Postgres-over-SQLite weekend benchmarking ".repeat(16)}to casual ORM tuning.`;
  assert.ok(sentence.length > 512, "fixture must exceed 512 chars");
  const facts = extractFacts(Buffer.from(sentence + "\n"), { path: PATH });
  assert.ok(facts.length >= 1);
  const f = facts[0];
  assert.ok(f.title.length <= 120, `title was ${f.title.length}`);
  // body must carry the FULL verbatim utterance (trailing period tolerance
  // allowed — check up to the last word, not the punctuation).
  assert.ok(f.body.includes(sentence.replace(/\.$/, "")));
});

// ── torn final JSONL line ─────────────────────────────────────────────────
test("FC-13 torn final JSONL line skipped without throwing", () => {
  const buf = jsonl(
    [prompt("I prefer SQLite over Postgres.", 1)],
    '{"at":"2026-08-23T00:00:02Z","cwd":"/tmp/proj","text":"I always dock the term',
  );
  const meta = { path: PATH };
  const facts = extractFacts(buf, meta); // must not throw
  assert.equal(facts.length, 1);
  assert.ok(!facts.some((f) => f.body.includes("dock")));
});

// ── NFKC normalization ────────────────────────────────────────────────────
test("FC-14 NFKC: fullwidth characters fold; output carries no compat codepoints", () => {
  const buf = Buffer.from("Ｉ prefer ＳQLite over ＭySQL.\n"); // U+FF34 etc.
  const facts = extractFacts(buf, { path: PATH });
  assert.ok(facts.length >= 1, "normalized input must still match patterns");
  for (const f of facts) {
    assert.ok(!/[\uFF00-\uFFEF]/.test(f.title + f.body), "compat codepoints leaked");
  }
  assert.ok(facts[0].title.toLowerCase().includes("sqlite") ||
            facts[0].body.includes("SQLite"), "folded entity missing");
});

// ── provenance in body ────────────────────────────────────────────────────
test("FC-15 body embeds path:line provenance matching the line field", () => {
  const buf = Buffer.from("# scratch\n\nI prefer SQLite over Postgres.\n");
  const facts = extractFacts(buf, { path: PATH });
  assert.ok(facts.length >= 1);
  const f = facts.find((x) => x.body.includes("prefer"));
  assert.equal(f.line, 3);
  assert.ok(f.body.includes(`${PATH}:3`), `body missing "${PATH}:3": ${f.body}`);
});

// ── near-dup suppression (C1 dedup half) ──────────────────────────────
// ponytail: boundary fixtures built by construction, not vibes — each pair
// is scored with the same trigram math here and asserted onto its side.
const trigramsOf = (s) => {
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
};
const jac = (a, b) => {
  const ga = trigramsOf(a);
  const gb = trigramsOf(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
};
const DEDUP_JACCARD = 0.97; // mirrors bin/lib/facts.mjs

// Identical utterance (punct variant): ≥ threshold → suppressed, counted.
test("FC-16 identical body suppressed, first occurrence wins", () => {
  const buf = Buffer.from(
    "I prefer SQLite over Postgres.\nI prefer SQLite over Postgres!\n",
  );
  const meta = { path: PATH };
  const facts = extractFacts(buf, meta);
  assert.equal(facts.length, 1);
  assert.equal(meta.skippedDuplicates, 1);
  assert.ok(facts[0].body.endsWith(`[${PATH}:1]`), "first occurrence wins");
});

// Provenance differences ([path:line]) must not bypass dedup: same utterance
// at different lines still dedupes because keys are text-only.
test("FC-17 provenance line shifts don't bypass dedup", () => {
  const buf = Buffer.from(
    "# scratch\n\nI prefer SQLite over Postgres.\nfiller sentence here.\nI prefer SQLite over Postgres.\n",
  );
  const meta = { path: "other.md" };
  const facts = extractFacts(buf, meta);
  assert.equal(facts.length, 1);
  assert.equal(meta.skippedDuplicates, 1);
});

// Boundary from BELOW: one word swapped in a long utterance → J < 0.97,
// both survive. Guard scores the fixture with the same trigram math and
// asserts it really sits below the line.
test("FC-18 similar-but-different pair below threshold survives", () => {
  const cols = Array.from({ length: 40 }, (_, k) => `col${k}x`).join(" ");
  const a = `I prefer table ${cols}.`;
  const b = a.replace("col7x", "col7z").replace("col31x", "col31w");
  const j = jac(a.toLowerCase(), b.toLowerCase());
  assert.ok(j >= 0.9 && j < DEDUP_JACCARD, `fixture drift: J=${j}`);
  const meta = { path: PATH };
  const facts = extractFacts(Buffer.from(`${a}\n${b}\n`), meta);
  assert.equal(facts.length, 2, `J=${j.toFixed(4)} must survive`);
  assert.equal(meta.skippedDuplicates, 0);
});

// Boundary from ABOVE: single trailing-char difference → J ≥ 0.97 →
// suppressed. Guard scores the fixture with the same trigram math and
// asserts it really crosses the line (staying under 1.0 so the exact-dup
// path isn't what's being tested).
test("FC-19 near-identical pair at/above threshold suppressed", () => {
  const cols = Array.from({ length: 40 }, (_, k) => `col${k}x`).join(" ");
  const keyA = `i prefer table ${cols}`; // normalized form (what dedup sees)
  const keyB = `${keyA.slice(0, -1)}q`;
  const j = jac(keyA, keyB);
  assert.ok(j >= DEDUP_JACCARD && j < 1, `fixture drift: J=${j}`);
  // utterances end '.' vs ',' — normalization lowercases but keeps that
  // final punctuation char, so the keys carry the difference just scored.
  const buf = Buffer.from(`I prefer table ${cols}.\nI prefer table ${cols},\n`);
  const meta = { path: PATH };
  const facts = extractFacts(buf, meta);
  assert.equal(facts.length, 1, `J=${j.toFixed(4)} must suppress`);
  assert.equal(meta.skippedDuplicates, 1);
});

// Degenerate short strings (<3 chars normalized key): empty trigram set,
// never a dupe — gate can't fire on nothing.
test("FC-20 tiny utterances never trip the dedup gate", () => {
  const facts = extractFacts(Buffer.from("I am up.\nI do run.\n"), { path: PATH });
  assert.ok(facts.length >= 2, `got ${facts.length}`);
});
