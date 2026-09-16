// retrieval-lane.test.mjs — the accuracy lane must measure REAL retrieval.
//
// Adversarial review found the first accuracy lane scored hand-written arrays
// with zero product imports: its numbers were identical on a tree where the
// retrieval path had been deleted. These tests pin the fix — the lane spawns
// the real embed-index query path in a scratch index and grades what it returns.
//
// The last test is the important one: it asserts the lane can FAIL. A scoring
// harness that cannot observe a broken index proves nothing, so we degrade the
// corpus (queries whose gold document is absent) and require the metrics to
// drop rather than stay flat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runRetrievalWorkload } from "../bench/improvement/retrieval-lane.mjs";
import { validateCase, RETRIEVAL_CASE, hashCase } from "../bench/improvement/retrieval-case.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const PY = process.env.HEIMDALL_EVAL_PYTHON ?? "/Users/arihantdeva/.heimdall/venv/bin/python3";

// NOTE: an earlier version of this check used `require` inside an ESM module,
// which always threw and made both real tests skip silently — the exact
// vacuous-pass failure mode these tests exist to prevent. Keep it as a real
// import and assert the lane actually ran.
function venvReady() {
  if (!existsSync(PY)) return false;
  try {
    execFileSync(PY, ["-c", "import sentence_transformers"], { stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

function withScratch(fn) {
  const home = mkdtempSync(join(tmpdir(), "heimdall-retrieval-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("the case itself is well-formed before any measurement", () => {
  assert.deepEqual(validateCase(), []);
  assert.ok(RETRIEVAL_CASE.docs.length >= 5, "enough documents to make ranking meaningful");
  assert.ok(RETRIEVAL_CASE.queries.length >= 5, "enough queries to make an average meaningful");
});

test("case hash changes when a document or label changes", () => {
  const base = hashCase(RETRIEVAL_CASE.docs, RETRIEVAL_CASE.queries);
  const editedDoc = RETRIEVAL_CASE.docs.map((d, i) => (i === 0 ? { ...d, text: `${d.text} extra` } : d));
  const editedLabel = RETRIEVAL_CASE.queries.map((q, i) =>
    i === 0 ? { ...q, gold: [...q.gold, "other.md"] } : q,
  );
  assert.notEqual(hashCase(editedDoc, RETRIEVAL_CASE.queries), base);
  assert.notEqual(hashCase(RETRIEVAL_CASE.docs, editedLabel), base);
});

test("the embedding venv is present, so the real retrieval tests actually run", () => {
  // A green suite where the only tests that matter silently skipped is a false
  // signal. Assert the precondition instead of discovering it in a skip note.
  assert.ok(
    venvReady(),
    `${PY} cannot import sentence_transformers — the real retrieval lane would skip on every run`,
  );
});

test("REAL retrieval: the lane finds gold documents through the product path", (t) => {
  if (!venvReady()) return t.skip(`${PY} cannot import sentence_transformers`);
  withScratch((home) => {
    const r = runRetrievalWorkload({ repo, home, python: PY });
    assert.equal(r.n, RETRIEVAL_CASE.queries.length);
    assert.ok(r.perQuery.length === r.n, "per-query detail is retained");
    // Exact expectation, not a floor. A `>= 0.75` bar left only 0.028 of
    // headroom above the current 0.778/0.889, so a single gold-label typo would
    // red the suite and read as a retrieval regression. Pin the measured value:
    // any movement is then a real, named change to this corpus.
    assert.equal(
      Number(r["recall@1"].toFixed(3)),
      0.889,
      `real retrieval changed: got recall@1=${r["recall@1"]} — ` +
        JSON.stringify(r.perQuery.map((q) => [q.id, q.ranked.slice(0, 2)])),
    );
  });
});

test("VALIDITY: degraded corpus makes the metrics drop (the lane can fail)", (t) => {
  // Replace every document's text with unrelated filler but keep the queries.
  // A lane that cannot observe this is not measuring retrieval.
  if (!venvReady()) return t.skip(`${PY} cannot import sentence_transformers`);
  withScratch((home) => {
    const filler = RETRIEVAL_CASE.docs.map((d) => ({
      ...d,
      text: "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor",
    }));
    const degraded = { docs: filler, queries: RETRIEVAL_CASE.queries, hash: "sha256:degraded" };
    const r = runRetrievalWorkload({ repo, home, python: PY, caseSpec: degraded });
    assert.ok(
      r["recall@1"] < 0.5,
      `corpus scrambled but recall@1 stayed at ${r["recall@1"]} — the lane is not measuring retrieval`,
    );
  });
});
