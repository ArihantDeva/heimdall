import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));


// ── the promoted hill-climb win: a stronger query-side model ─────────────
//
// LongMemEval-S, dev/test split BY FILE (9 dev files, 9 test files, no overlap).
// Coordinate ascent, one knob at a time, promote on dev then re-measure
// held-out. Full ledger in bench/longmemeval_s/ledger.jsonl.
//
//   instruction=False     dev_mrr 0.561  (d=-0.053)  reject
//   lex_weight=0.3/0.5/0.7 dev_mrr 0.615 (d=+0.000)  reject
//   body_cap=1200         dev_mrr 0.592  (d=-0.023)  reject
//   body_cap=6000         dev_mrr 0.615  (d=+0.000)  reject
//   gte-base              dev_mrr 0.526  (d=-0.156)  reject
//   bge-base              dev_mrr 0.682  (d=+0.068)  PROMOTE
//                       held-out mrr 0.498  (d=+0.043)  KEEP
//
// This is the FIRST change in this effort that improved held-out recall. The
// five earlier attempts each raised a benchmark number while lowering held-out
// recall, and were reverted.

test("the promoted model is the one the climb selected", () => {
  const srcQ = readFileSync(join(repoRoot, "bin", "embed-index.py"), "utf8");
  assert.match(srcQ, /bge-base-en-v1\.5/,
    "default embedding model is not the hill-climbed winner");
  // bge-base is 768d, not 384d. The DIM constant is derived from the model
  // name, so a stale DIM silently embeds into a table sized for the old model.
  assert.match(srcQ, /768 if .*bge-base/,
    "DIM does not account for the 768d bge-base model");
});

test("the vec table is created at the model's real dimension, not a hardcoded 384", () => {
  // The hardcoded float[384] is why the eval had to special-case it. A model
  // swap that does not resize the table is a runtime dimension error at query
  // time, long after the rebuild.
  const srcQ = readFileSync(join(repoRoot, "bin", "embed-index.py"), "utf8");
  assert.doesNotMatch(srcQ, /vec0\(embedding float\[384\]\)/,
    "vec table dimension is hardcoded to 384");
});

test("the model default is overridable without a rebuild of the source", () => {
  // HEIMDALL_EMBED_MODEL already exists; the point is that changing it must
  // not require editing the file, or every experiment becomes a code change.
  const srcQ = readFileSync(join(repoRoot, "bin", "embed-index.py"), "utf8");
  assert.match(srcQ, /HEIMDALL_EMBED_MODEL/,
    "model is not overridable by environment");
});

test("the eval records the win, including the knobs it rejected", () => {
  // An eval whose history is reconstructed from memory is how the previous
  // five overfits went unnoticed. The ledger must carry rejected trials too.
  const led = readFileSync(
    join(repoRoot, "bench", "longmemeval_s", "ledger.jsonl"), "utf8");
  const rows = led.trim().split("\n").map((l) => JSON.parse(l));
  const rejected = rows.filter((r) => r.verdict === "reject");
  assert.ok(rejected.length >= 4,
    `only ${rejected.length} rejected trials recorded; the climb is not auditable`);
  const kept = rows.filter((r) => r.verdict === "keep");
  assert.ok(kept.length >= 1, "no promoted step recorded");
  const keptRow = kept.find((r) => r.config?.model === "BAAI/bge-base-en-v1.5");
  assert.ok(keptRow, "the bge-base promotion is not in the ledger");
  // And the promotion must have been checked out of sample.
  assert.ok(keptRow.test && keptRow.test.mrr > 0,
    "the promotion was recorded without a held-out measurement");
});
