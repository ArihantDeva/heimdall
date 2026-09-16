// gate-hardening.test.mjs — regression tests for the defect classes that
// adversarial review found in the first version of the gate.
//
// Each test below reproduces a REAL finding: an input for which the original
// gate returned { ok: true } when it should have refused. They are written so
// that reverting any single guard turns one of them red.
//
// Lane 1 findings covered here: empty artifacts, missing speed lane, zero
// samples, NaN metrics, negative timings, undefined metrics, metric-set
// shrinkage, exit-status blindness, capability drift, p95 blindness, and
// editable labels passing as an improvement.
import { test } from "node:test";
import assert from "node:assert/strict";

import { gate, validateArtifact } from "../bench/improvement/run.mjs";
import { compareMetrics } from "../bench/improvement/eval.mjs";
import { fixturesHash, validateFixtures } from "../bench/improvement/fixtures.mjs";

const WL = { corpus: "c1", env: "darwin", cache: "cold" };
const ACC = { mrr: 0.5, "recall@1": 0.5, "ndcg@1": 0.5, n: 6, labels: "sha256:aaaa" };
const SPEED = { depth: { n: 20, p50: 100, p95: 150, p99: null } };

const baseline = (over = {}) => ({ workload: WL, accuracy: ACC, speed: SPEED, capability: "graph", ...over });
const candidate = (over = {}) => ({ workload: WL, accuracy: ACC, speed: SPEED, capability: "graph", ...over });

const refused = (verdict) => assert.equal(verdict.ok, false, `expected refusal, got ${JSON.stringify(verdict)}`);
const accepted = (verdict) => assert.equal(verdict.ok, true, `expected acceptance, got ${JSON.stringify(verdict)}`);

test("baseline sanity: an unchanged candidate is accepted", () => {
  accepted(gate(baseline(), candidate()));
});

// --- finding 5: six ways garbage used to pass -------------------------------

test("empty artifacts are refused, not treated as vacuously equal", () => {
  refused(gate({}, {}));
});

test("a candidate that omits the whole speed lane is refused", () => {
  refused(gate(baseline(), candidate({ speed: undefined })));
});

test("a speed cell with zero samples is refused", () => {
  refused(gate(baseline(), candidate({ speed: { depth: { n: 0, p50: null, p95: null, p99: null } } })));
});

test("NaN accuracy metrics are refused", () => {
  refused(gate(baseline(), candidate({ accuracy: { ...ACC, mrr: NaN, "recall@1": NaN } })));
});

test("a negative timing is refused as unusable, not accepted as 'fast'", () => {
  refused(gate(baseline(), candidate({ speed: { depth: { n: 20, p50: -500, p95: 150, p99: null } } })));
});

test("an explicitly-undefined metric is refused", () => {
  refused(gate(baseline(), candidate({ accuracy: { ...ACC, mrr: undefined } })));
});

test("a candidate that silently drops metrics is refused", () => {
  refused(gate(baseline(), candidate({ accuracy: { mrr: 0.5, n: 6, labels: "sha256:aaaa" } })));
});

test("validateArtifact reports the offending field", () => {
  const problems = validateArtifact({ accuracy: { mrr: NaN, n: 0 }, speed: {} }, "candidate");
  assert.ok(problems.some((p) => p.includes("mrr")));
  assert.ok(problems.some((p) => p.includes("accuracy.n")));
  assert.ok(problems.some((p) => p.includes("no speed measurements")));
});

test("compareMetrics reports unusable values instead of silently ignoring them", () => {
  const drops = compareMetrics({ mrr: 0.5 }, { mrr: undefined });
  assert.equal(drops.length, 1);
  assert.match(drops[0], /UNUSABLE/);
  assert.match(compareMetrics({ mrr: 0.5 }, { mrr: NaN })[0], /UNUSABLE/);
});

// --- finding 3: capability drift is a correctness regression ----------------

test("a capability drop from graph to file is a regression, not a silent pass", () => {
  const verdict = gate(baseline(), candidate({ capability: "file" }));
  refused(verdict);
  assert.ok(verdict.reasons.some((r) => /CAPABILITY REGRESSION/.test(r)));
});

test("an unknown capability is refused rather than assumed fine", () => {
  refused(gate(baseline(), candidate({ capability: null })));
});

// --- finding 6: tail regressions were invisible -----------------------------

test("a candidate that keeps p50 but triples p95 is refused", () => {
  const verdict = gate(
    baseline(),
    candidate({ speed: { depth: { n: 20, p50: 100, p95: 500, p99: 900 } } }),
  );
  refused(verdict);
  assert.ok(verdict.reasons.some((r) => /TAIL REGRESSION/.test(r)));
});

// --- finding 2: editable labels must be visible -----------------------------

test("editing the labels makes the candidate incomparable, not better", () => {
  const verdict = gate(baseline(), candidate({ accuracy: { ...ACC, labels: "sha256:bbbb" } }));
  refused(verdict);
  assert.ok(verdict.reasons.some((r) => /labels changed/.test(r)));
});

test("fixturesHash is stable for the same labels and changes when a label moves", () => {
  const a = [{ id: "x", ranked: ["p", "q"], gold: ["p"] }];
  const b = [{ id: "x", ranked: ["p", "q"], gold: ["p"] }];
  const c = [{ id: "x", ranked: ["q", "p"], gold: ["p"] }];
  assert.equal(fixturesHash(a), fixturesHash(b));
  assert.notEqual(fixturesHash(a), fixturesHash(c));
});

test("an empty fixture set is rejected by the validator", () => {
  assert.ok(validateFixtures([]).length > 0, "empty fixtures must not validate");
});

// --- finding 4: a crashing CLI must never look fast -------------------------

test("a broken CLI throws instead of producing a fast sample", async () => {
  const { runSpeedWorkload } = await import("../bench/improvement/run.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const fake = mkdtempSync(join(tmpdir(), "heimdall-broken-"));
  try {
    mkdirSync(join(fake, "bin"), { recursive: true });
    writeFileSync(join(fake, "bin", "heimdall.js"), "process.exit(1);\n");
    const proj = mkdtempSync(join(tmpdir(), "heimdall-proj-"));
    assert.throws(
      () => runSpeedWorkload({ repo: fake, home: proj, proj, reps: 1 }),
      /depth failed/,
      "a CLI that exits non-zero must throw, not be timed as a speedup",
    );
    rmSync(proj, { recursive: true, force: true });
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});
