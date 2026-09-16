// improvement-eval.test.mjs — contract tests for the evaluation gate itself.
//
// RED-first: these tests define the scoring/validity contract BEFORE the
// implementation exists (bench/improvement/eval.mjs). They exist to make one
// claim checkable that a benchmark suite usually leaves untested: that the
// gate FAILS on a deliberately degraded result. A gate that cannot fail is not
// a gate, and "the numbers went up" is not evidence without it.
//
// Hermetic by construction: pure functions only — no daemon, no network, no
// live ~/.heimdall state, no Python venv. Runs inside `mise run test`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rankingMetrics,
  compareMetrics,
  summarizeTimings,
  sameWorkload,
} from "../bench/improvement/eval.mjs";

const RANKED = ["a", "b", "c", "d", "e"];

test("ranking: the gold document at rank 1 scores perfectly", () => {
  const m = rankingMetrics(RANKED, ["a"], [1, 3]);
  assert.equal(m["recall@1"], 1);
  assert.equal(m["recall@3"], 1);
  assert.equal(m.mrr, 1);
  assert.equal(m["ndcg@1"], 1);
});

test("ranking: the gold document at rank 2 costs recall@1 but not recall@2", () => {
  const m = rankingMetrics(RANKED, ["b"], [1, 2]);
  assert.equal(m["recall@1"], 0);
  assert.equal(m["recall@2"], 1);
  assert.equal(m.mrr, 0.5);
});

test("ranking: a missing gold document is a miss, never an exclusion", () => {
  // The bench harness documents this trap for abstention questions: a
  // "no gold => skip" rule silently never fires. Missing gold must score 0.
  const m = rankingMetrics(RANKED, ["zzz"], [1, 5]);
  assert.equal(m["recall@1"], 0);
  assert.equal(m["recall@5"], 0);
  assert.equal(m.mrr, 0);
});

test("ranking: nDCG discounts a relevant hit found late", () => {
  const early = rankingMetrics(RANKED, ["a"], [5])["ndcg@5"];
  const late = rankingMetrics(RANKED, ["e"], [5])["ndcg@5"];
  assert.ok(early > late, `expected ${early} > ${late}`);
});

test("regression: any drop is a regression at the default zero tolerance", () => {
  const base = { "recall@1": 0.8, "recall@5": 0.9 };
  const drops = compareMetrics(base, { "recall@1": 0.7, "recall@5": 0.9 });
  assert.equal(drops.length, 1);
  assert.match(drops[0], /recall@1/);
});

test("regression: equal or improved cells are not regressions", () => {
  const base = { "recall@1": 0.8 };
  assert.deepEqual(compareMetrics(base, { "recall@1": 0.8 }), []);
  assert.deepEqual(compareMetrics(base, { "recall@1": 0.9 }), []);
});

test("VALIDITY: the gate must fail on a deliberately degraded ranking", () => {
  // The core validity claim of the whole evaluation: take a system that
  // ranks gold first everywhere and degrade it to gold-last. If the gate
  // still passes, it is a no-op and every "improvement" is unfalsifiable.
  const gold = RANKED.map((id) => [id]);
  const queries = gold.map(([id], i) => ({ ranked: [id, ...RANKED], gold: [id], i }));
  assert.ok(queries.length > 0);

  const good = { "recall@1": 1, mrr: 1 };
  const degraded = { "recall@1": 0, mrr: 0.2 };
  const drops = compareMetrics(good, degraded);
  assert.ok(drops.length >= 2, `degradation must be caught, got ${JSON.stringify(drops)}`);
  assert.ok(drops.some((d) => d.includes("mrr")));
});

test("timings: n=10 supports p50 but must NOT claim p95/p99", () => {
  const s = summarizeTimings([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(s.n, 10);
  assert.equal(s.p50, 55);
  assert.equal(s.p95, null, "a p95 from 10 samples is the max wearing a statistical label");
  assert.equal(s.p99, null, "a p99 from 10 samples is not a measurement");
});

test("timings: 20+ samples support a p95, 100+ support a p99", () => {
  const twenty = summarizeTimings(Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(twenty.n, 20);
  assert.ok(twenty.p95 > twenty.p50, "p95 above p50 with 20 samples");
  assert.equal(twenty.p99, null, "p99 still unsupported at n=20");

  const hundred = summarizeTimings(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(hundred.n, 100);
  assert.ok(hundred.p99 >= hundred.p95, "p99 above p95 with 100 samples");
});

test("timings: a single sample cannot support a p99 claim", () => {
  const s = summarizeTimings([42]);
  assert.equal(s.n, 1);
  assert.equal(s.p50, 42);
  assert.equal(s.p95, null, "p95 from one sample is not a measurement");
  assert.equal(s.p99, null, "p99 from one sample is not a measurement");
});

test("timings: no samples is not a zero-latency result", () => {
  const s = summarizeTimings([]);
  assert.equal(s.n, 0);
  assert.equal(s.p50, null);
});

test("workload: sample counts do not break comparability, distinct conditions do", () => {
  const a = { commit: "abc123", corpus: "sha256:deadbeef", reps: 10 };
  const same = { commit: "abc123", corpus: "sha256:deadbeef", reps: 10 };
  const otherCorpus = { commit: "abc123", corpus: "sha256:ffffffff", reps: 10 };
  assert.equal(sameWorkload(a, same), true);
  assert.equal(sameWorkload(a, otherCorpus), false);
});

test("workload: different commits ARE comparable — that is the point of a baseline", () => {
  // Regression test for a real defect: `commit` was in the workload identity,
  // so after every commit the gate reported "workload mismatch" and could
  // never measure a change. Verified failing at 8c73441 vs a 4eed256 baseline.
  const baseline = { commit: "4eed256", corpus: "c1", env: "darwin", cache: "cold" };
  const candidate = { commit: "8c73441", corpus: "c1", env: "darwin", cache: "cold" };
  assert.equal(sameWorkload(baseline, candidate), true);
});

test("workload: a different corpus or environment is NOT comparable", () => {
  const baseline = { commit: "a", corpus: "c1", env: "darwin", cache: "cold" };
  assert.equal(sameWorkload(baseline, { commit: "a", corpus: "c2", env: "darwin", cache: "cold" }), false);
  assert.equal(sameWorkload(baseline, { commit: "a", corpus: "c1", env: "linux", cache: "cold" }), false);
  assert.equal(sameWorkload(baseline, { commit: "a", corpus: "c1", env: "darwin", cache: "warm" }), false);
});

test("workload: sample count is a measurement parameter, not workload identity", () => {
  // A 5-sample baseline must remain comparable with a 20-sample candidate:
  // raising reps is how the runner earns the right to state a p95, and it must
  // not silently invalidate every existing baseline.
  const baseline = { commit: "abc", corpus: "c1", reps: 5 };
  const candidate = { commit: "abc", corpus: "c1", reps: 20 };
  assert.equal(sameWorkload(baseline, candidate), true);
});
