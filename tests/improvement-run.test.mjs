// improvement-run.test.mjs — end-to-end contract for the improvement gate.
//
// RED-first: drives the real CLI in a scratch HOME (the same isolation
// tests/init-e2e.test.mjs uses) and asserts the gate PASSES on an intact
// workload and FAILS on a deliberately degraded one. This is the test that
// makes "the evaluation is valid" falsifiable rather than asserted.
//
// Hermetic: scratch HOME, temp project dir, no live ~/.heimdall state, no
// network, no daemon. Slow-ish by design (real process spawns), so it stays
// out of the default `mise run test` glob until the gate is wired in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runSpeedWorkload } from "../bench/improvement/run.mjs";
import { gate } from "../bench/improvement/gate.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function scratch() {
  const home = mkdtempSync(join(tmpdir(), "heimdall-improvement-"));
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "lib.mjs"),
    ["export function alpha() { return 1; }", "export function beta() { return alpha() + 1; }", "export function gamma() { return beta() * 2; }"].join("\n"),
  );
  return { home, proj, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const UNSTABLE = [1, 9, 4, 40, 2, 70, 1, 30, 3, 100];
const THREE = UNSTABLE.slice(0, 3);

const WL = { commit: "a", corpus: "c", env: "darwin", cache: "cold" };
const ACC = { mrr: 0.5, "recall@1": 0.5, n: 6, labels: "sha256:aaaa", perQuery: [] };
// p95 is null: n=20 cannot support a tail claim (MIN_SAMPLES_FOR.p95 = 100), so
// these fixtures model an honest small run rather than an impossible one.
const SPEED = { depth: { n: 20, p50: 100, p95: null, p99: null } };
const RELIABILITY = { anchor: 40, speedReliable: true, tailReliable: true, tailDisagreement: 1, disagreement: 1 };

function candidate(extra) {
  return { workload: WL, speed: SPEED, accuracy: ACC, capability: "graph", ...RELIABILITY, ...extra };
}

function baseline(extra) {
  return { workload: WL, speed: SPEED, accuracy: ACC, capability: "graph", ...RELIABILITY, ...extra };
}

test("speed workload measures the real CLI in a scratch HOME", () => {
  const s = scratch();
  try {
    const m = runSpeedWorkload({ repo, home: s.home, proj: s.proj, reps: 3, samples: THREE });
    assert.equal(m.distribution.n, 3);
    assert.ok(m.distribution.p50 !== null);
    assert.equal(m.command, "depth");
    assert.ok(m.workload.commit.length > 0, "workload records the commit");
    assert.equal(m.workload.reps, 3);
  } finally {
    s.cleanup();
  }
});

test("speed workload spawns the real CLI when no fixed samples are given", () => {
  const s = scratch();
  try {
    const m = runSpeedWorkload({ repo, home: s.home, proj: s.proj, reps: 2 });
    assert.equal(m.distribution.n, 2);
    assert.ok(m.distribution.p50 > 0, `expected a real measurement, got ${m.distribution.p50}`);
  } finally {
    s.cleanup();
  }
});

test("accuracy is measured on real retrieval, not literals", (t) => {
  // The old literal-scoring helper (which imported zero product code) was
  // deleted. Real retrieval accuracy lives in tests/retrieval-lane.test.mjs,
  // which also asserts the embedding venv is present rather than skipping
  // silently. Point here instead of duplicating that ~30s measurement.
  t.skip("moved to tests/retrieval-lane.test.mjs — real retrieval measurement");
});

test("GATE PASSES on an intact workload (no false alarm)", () => {
  const shared = {
    workload: { commit: "base", corpus: "fixture-v1", env: "darwin", cache: "cold" },
    speed: SPEED,
    capability: "graph",
    ...RELIABILITY,
  };
  const verdict = gate(
    { ...shared, accuracy: ACC },
    { ...shared, accuracy: ACC },
  );
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});

test("VALIDITY: GATE FAILS on a deliberately degraded accuracy candidate", () => {
  const degraded = candidate({
    accuracy: { mrr: 0.1, "recall@1": 0, n: 6, labels: "sha256:aaaa", perQuery: [] },
  });
  const verdict = gate(baseline(), degraded);
  assert.equal(verdict.ok, false, "a degraded candidate must fail the gate");
  assert.ok(verdict.reasons.some((r) => r.includes("REGRESSION")));
});

test("VALIDITY: GATE FAILS on a deliberately degraded speed candidate", () => {
  const degraded = candidate({ speed: { depth: { n: 20, p50: 400, p95: 900, p99: 900 } } });
  const verdict = gate(baseline(), degraded);
  assert.equal(verdict.ok, false, "a candidate several times slower must fail the gate");
  assert.ok(verdict.reasons.some((r) => /speed/i.test(r)));
});

test("GATE REFUSES to compare numbers from different workloads", () => {
  const baseline = {
    workload: { commit: "base", corpus: "fixture-v1", reps: 3 },
    speed: { depth: { n: 3, p50: 10, p95: 20, p99: 20 } },
  };
  const other = {
    workload: { commit: "base", corpus: "fixture-v2", reps: 3 },
    speed: { depth: { n: 3, p50: 1, p95: 1, p99: 1 } },
  };
  const verdict = gate(baseline, other);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => /workload/i.test(r)));
});

const WL_LEGACY = { commit: "a", corpus: "c", env: "darwin", cache: "cold" };

test("GATE refuses to judge a measurement taken on a noisy machine", () => {
  // Observed for real: load average 520 produced p50=169ms against a
  // quiet-machine 116ms for identical code. Gating on that would fail honest
  // work, so an unreliable measurement must produce no verdict at all.
  const verdict = gate(baseline(), candidate({ speedReliable: false, disagreement: 1.8 }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => /unusable|quiet machine/i.test(r)));
});

test("GATE passes a clean, unchanged candidate", () => {
  const verdict = gate(baseline(), candidate({ speedReliable: true, disagreement: 1.02 }));
  assert.deepEqual(verdict, { ok: true, reasons: [] });
});

test("GATE catches a candidate that dropped its accuracy metrics entirely", () => {
  // A candidate that reports no metrics has not proven no regression. The
  // hardened validator reports the missing shape directly.
  const verdict = gate(baseline(), candidate({ accuracy: {} }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => /no accuracy metrics|candidate reports no accuracy/i.test(r)));
});
