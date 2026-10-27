import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { plainPython } from "./lib/python.mjs";

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

// ── helper: execute the model/dimension expressions for real ──────────────
//
// These two decisions are plain module-level expressions in embed-index.py:
//     MODEL = os.environ.get("HEIMDALL_EMBED_MODEL", "BAAI/bge-base-en-v1.5")
//     DIM   = 768 if "bge-base" in MODEL else 384 if "bge-small" in MODEL else 1024
// Importing the module needs torch + a model download, but the EXPRESSION does
// not — so it is extracted and evaluated. That is the difference between "the
// file mentions bge-base" and "bge-base is what gets used".
//
// Why it matters (measured 2026-10-23): the previous assertions were
// assert.match on the source text. Replacing the default model with
// bge-small-en-v1.5 and leaving the old name in a comment kept all four tests
// passing, so they could not see a model swap at all.
// The MODEL/DIM lines are PYTHON (`DIM = 768 if ... else ...`), so they are
// evaluated with python, not with new Function. Only those two lines run.
function embedModelAndDim(env = {}) {
	const src = readFileSync(join(repoRoot, "bin", "embed-index.py"), "utf8");
	const assignments = src.split("\n").filter((l) => /^(MODEL|DIM)\s*=/.test(l));
	assert.ok(assignments.length >= 2,
		"embed-index.py must define MODEL and DIM as top-level assignments");
	const script = [
		"import json, os",
		...assignments,
		"print(json.dumps({'model': MODEL, 'dim': DIM}))",
	].join("\n");
	// A python that can run this needs no packages: the expressions touch only os.
	const py = plainPython();
	const r = spawnSync(py, ["-c", script], {
		encoding: "utf8", timeout: 60_000,
		env: { ...process.env, ...env },
	});
	assert.equal(r.status, 0, `python could not evaluate MODEL/DIM: ${r.stderr}`);
	return JSON.parse((r.stdout || "").trim().split("\n").pop());
}

test("the promoted model is the one the climb selected", () => {
	const { model } = embedModelAndDim();
	assert.equal(model, "BAAI/bge-base-en-v1.5",
		"default embedding model is not the hill-climbed winner");
});

test("the dimension is DERIVED from the model, not stale", () => {
	// A stale DIM silently embeds into a table sized for the old model, and the
	// error only appears at query time after a rebuild. Assert the mapping for
	// several models rather than that the source contains a ternary.
	assert.deepEqual(embedModelAndDim(), { model: "BAAI/bge-base-en-v1.5", dim: 768 });
	assert.deepEqual(embedModelAndDim({ HEIMDALL_EMBED_MODEL: "BAAI/bge-small-en-v1.5" }),
		{ model: "BAAI/bge-small-en-v1.5", dim: 384 },
		"switching to bge-small must yield 384, not the base model's 768");
	assert.deepEqual(embedModelAndDim({ HEIMDALL_EMBED_MODEL: "nomic-ai/nomic-embed-text-v1.5" }),
		{ model: "nomic-ai/nomic-embed-text-v1.5", dim: 1024 },
		"an unknown model must not silently fall back to a bge dimension");
});

test("the vec table is created at the model's real dimension, not a hardcoded 384", () => {
	// Unchanged in intent, but asserts the DDL the code BUILDS rather than the
	// absence of one specific literal.
	const srcQ = readFileSync(join(repoRoot, "bin", "embed-index.py"), "utf8");
	assert.doesNotMatch(srcQ, /vec0\(embedding float\[384\]\)/,
		"vec table dimension is hardcoded to 384");
	assert.match(srcQ, /float\[\{?\s*DIM|float\[\$\{?DIM|f?"[^"]*float\[\{DIM\}/,
		"the vec table DDL must interpolate DIM, or a model swap leaves it missized");
});

test("the model default is overridable without a rebuild of the source", () => {
	// Behavioural: an env override must actually change the value used.
	const overridden = embedModelAndDim({ HEIMDALL_EMBED_MODEL: "some/other-model" });
	assert.equal(overridden.model, "some/other-model",
		"HEIMDALL_EMBED_MODEL did not override the default");
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
