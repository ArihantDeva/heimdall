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

import { gate } from "../bench/improvement/gate.mjs";
import { validateArtifact } from "../bench/improvement/validate.mjs";
import { compareMetrics } from "../bench/improvement/eval.mjs";
import { validateCase, hashCase, RETRIEVAL_CASE } from "../bench/improvement/retrieval-case.mjs";
const WL = { corpus: "c1", env: "darwin", cache: "cold" };
const ACC = { mrr: 0.5, "recall@1": 0.5, "ndcg@1": 0.5, n: 6, labels: "sha256:aaaa" };
const SPEED = { depth: { n: 20, p50: 100, p95: 150, p99: null } };

const LOAD_OK = { cores: 8, load1: 2, load1PerCpu: 0.25 };

const baseline = (over = {}) => ({ workload: WL, accuracy: ACC, speed: SPEED, capability: "graph", anchor: 40, load: LOAD_OK, ...over });
const candidate = (over = {}) => ({ workload: WL, accuracy: ACC, speed: SPEED, capability: "graph", anchor: 40, load: LOAD_OK, ...over });

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

test("a baseline with no capability record refuses rather than skipping the check", () => {
  // Found by self-checking the fix patch: this used to return ok:true, so a
  // baseline frozen without a capability verdict silently disabled the guard —
  // the same hole the anchor was hardened against.
  const verdict = gate(baseline({ capability: undefined }), candidate({ capability: undefined }));
  refused(verdict);
  assert.ok(verdict.reasons.some((r) => /capability/i.test(r)));
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

test("hashCase is stable for the same case and changes when a label moves", () => {
  const a = [[{ name: "x.md", text: "t" }], [{ id: "q", text: "t", gold: ["x.md"] }]];
  const b = [[{ name: "x.md", text: "t" }], [{ id: "q", text: "t", gold: ["x.md"] }]];
  const c = [[{ name: "x.md", text: "t" }], [{ id: "q", text: "t", gold: ["y.md"] }]];
  assert.equal(hashCase(...a), hashCase(...b));
  assert.notEqual(hashCase(...a), hashCase(...c));
});

test("an empty case is rejected by the validator", () => {
  assert.ok(validateCase([], []).length > 0, "empty case must not validate");
  assert.deepEqual(validateCase(RETRIEVAL_CASE.docs, RETRIEVAL_CASE.queries), []);
});

// --- review round 2: gold integrity, sample count, per-query slices ---------

test("a gold id that is not in the corpus is a label error, not a regression", () => {
  const docs = [{ name: "a.md", text: "t" }];
  const bad = [{ id: "q", text: "t", gold: ["a.mdd"] }];
  const problems = validateCase(docs, bad);
  assert.ok(
    problems.some((p) => /not a document in the corpus/.test(p)),
    `a typo'd gold id must be caught: ${JSON.stringify(problems)}`,
  );
});

test("the no-match sentinel is a legal gold label", () => {
  assert.deepEqual(validateCase(RETRIEVAL_CASE.docs, RETRIEVAL_CASE.queries), []);
});

test("a candidate measuring fewer queries is refused even with identical averages", () => {
  const acc = { ...ACC, n: 9, perQuery: [] };
  const verdict = gate(
    baseline({ accuracy: acc }),
    candidate({ accuracy: { ...acc, n: 1 } }),
  );
  refused(verdict);
  assert.ok(verdict.reasons.some((r) => /query count changed/.test(r)));
});

test("a per-query slice swap is caught even when every average is identical", () => {
  // one query improves, another regresses, averages unchanged.
  const mk = (x, y) => ({
    ...ACC,
    perQuery: [
      { id: "x", ranked: [], metrics: { mrr: x, "recall@1": x } },
      { id: "y", ranked: [], metrics: { mrr: y, "recall@1": y } },
    ],
  });
  const verdict = gate(baseline({ accuracy: mk(1, 0) }), candidate({ accuracy: mk(0.5, 0.5) }));
  refused(verdict);
  assert.ok(
    verdict.reasons.some((r) => /PER-QUERY REGRESSION x/.test(r)),
    `a masked per-query regression must surface: ${JSON.stringify(verdict.reasons)}`,
  );
});

test("a disappearing query is caught", () => {
  const mk = (qs) => ({ ...ACC, perQuery: qs });
  const before = mk([{ id: "x", ranked: [], metrics: { mrr: 1 } }]);
  const after = mk([{ id: "z", ranked: [], metrics: { mrr: 1 } }]);
  const verdict = gate(baseline({ accuracy: before }), candidate({ accuracy: after }));
  refused(verdict);
});

// --- review round 3: tail claim honesty, anchor robustness ------------------

test("a missing p95 against a baseline that HAS one is refused, not skipped", () => {
  // Finding B1: at n<100 the p95 is null; the old code `continue`d, so the same
  // tail regression was refused at n=100 and silently accepted at n=20.
  const verdict = gate(
    baseline(),
    candidate({ speed: { depth: { n: 20, p50: 100, p95: null, p99: null } } }),
  );
  refused(verdict);
  assert.ok(
    verdict.reasons.some((r) => /tail unmeasurable/.test(r)),
    `a suppressed tail claim must be refused: ${JSON.stringify(verdict.reasons)}`,
  );
});

test("the tail guard is reachable — an unreliable tail is refused end to end", () => {
  // Finding B2: tailReliable was computed but never forwarded, so the gate read
  // undefined and judged p95 anyway. This asserts the field actually arrives.
  const verdict = gate(baseline(), candidate({ tailReliable: false, tailDisagreement: 3 }));
  refused(verdict);
  assert.ok(verdict.reasons.some((r) => /tail unmeasurable/.test(r)));
});

test("a non-numeric anchor refuses instead of disabling the guard", () => {
  for (const bad of [NaN, 0, -1, "999", null]) {
    const verdict = gate(baseline({ anchor: 40 }), candidate({ anchor: bad }));
    refused(verdict);
    assert.ok(
      verdict.reasons.some((r) => /anchor/.test(r)),
      `anchor ${String(bad)} must refuse: ${JSON.stringify(verdict.reasons)}`,
    );
  }
});

test("a missing anchor on both sides refuses rather than assuming comparability", () => {
  refused(gate(baseline({ anchor: undefined }), candidate({ anchor: undefined })));
});

test("a renamed speed cell is refused instead of vanishing from the comparison", () => {
  const verdict = gate(baseline(), candidate({ speed: { other: SPEED.depth } }));
  refused(verdict);
  assert.ok(verdict.reasons.some((r) => /no longer report|speed\.depth/.test(r)));
});

test("an inverted or negative tail percentile is refused", () => {
  refused(gate(baseline(), candidate({ speed: { depth: { n: 100, p50: 100, p95: 50, p99: null } } })));
  refused(gate(baseline(), candidate({ speed: { depth: { n: 100, p50: 100, p95: -500, p99: null } } })));
});

test("a smaller speed finding never hides a capability regression", () => {
  // Found by review of the final fix patch: suppression was keyed off
  // `speed.length`, so a p50 regression suppressed capabilityReasons entirely
  // and a graph -> file downgrade (issue #12) was reported as nothing at all.
  const verdict = gate(
    baseline(),
    candidate({
      capability: "file",
      speed: { depth: { n: 100, p50: 300, p95: 900, p99: null } },
    }),
  );
  refused(verdict);
  assert.ok(
    verdict.reasons.some((r) => /CAPABILITY REGRESSION/.test(r)),
    `capability drop must surface alongside the speed finding: ${JSON.stringify(verdict.reasons)}`,
  );
  assert.ok(verdict.reasons.some((r) => /SPEED REGRESSION/.test(r)), "and so must the p50 finding");
  assert.ok(verdict.reasons.some((r) => /TAIL REGRESSION/.test(r)), "and the tail finding");
});

test("an unusable measurement still withholds speed and tail claims", () => {
  // The suppression that IS intended: no latency claim from a refused run.
  const verdict = gate(
    baseline(),
    candidate({ speedReliable: false, tailReliable: false, speed: { depth: { n: 100, p50: 400, p95: 900, p99: null } } }),
  );
  refused(verdict);
  assert.ok(verdict.reasons.some((r) => /unusable/.test(r)));
  assert.ok(!verdict.reasons.some((r) => /SPEED REGRESSION/.test(r)), "no speed claim from an unusable run");
});

// --- machine load: the noise guard cannot see a sustained slowdown ----------

test("a uniformly slow machine is refused, not reported as a code regression", () => {
  // Observed for real: load average 280 made every depth call ~2x slower in
  // BOTH batches, so they agreed with each other (spread 1.13x, inside the
  // 1.25x limit) and the gate reported a p50 regression against a quiet-machine
  // baseline. The disagreement check cannot see sustained load; the anchor can.
  const verdict = gate(
    baseline({ anchor: 40 }),
    candidate({ anchor: 300, speed: { depth: { n: 20, p50: 188, p95: 276, p99: null } } }),
  );
  refused(verdict);
  assert.ok(
    verdict.reasons.some((r) => /machine load changed/i.test(r)),
    `expected a load-anchor refusal, got ${JSON.stringify(verdict.reasons)}`,
  );
  assert.ok(
    !verdict.reasons.some((r) => /SPEED REGRESSION/.test(r)),
    "must not also assert a code regression from numbers the load invalidated",
  );
});

test("a comparable machine is judged normally", () => {
  const verdict = gate(baseline({ anchor: 40 }), candidate({ anchor: 42 }));
  accepted(verdict);
});

test("a saturated machine is refused from the OS load reading alone", () => {
  // Verified real failure: at load 63 on unchanged code the anchor read 43ms
  // (inside its tolerance) while the target p50 went 108.7ms -> 227ms, and the
  // gate reported a CODE regression. A ~40ms bare-node anchor does not respond
  // to load like a ~110ms process that spawns python and does file I/O.
  const verdict = gate(
    baseline(),
    candidate({ load: { cores: 8, load1: 40, load1PerCpu: 5 } }),
  );
  refused(verdict);
  assert.ok(
    verdict.reasons.some((r) => /saturated/.test(r)),
    `expected a saturation refusal: ${JSON.stringify(verdict.reasons)}`,
  );
  assert.ok(
    !verdict.reasons.some((r) => /SPEED REGRESSION/.test(r)),
    "must not assert a code regression from a saturated run",
  );
});

test("a missing load reading refuses rather than skipping the guard", () => {
  refused(gate(baseline(), candidate({ load: undefined })));
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
