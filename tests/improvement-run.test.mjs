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

import { runSpeedWorkload, runAccuracyWorkload, gate } from "../bench/improvement/run.mjs";

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

test("accuracy workload scores the real verdict path against held-out labels", () => {
  const m = runAccuracyWorkload({});
  assert.ok(m.n >= 3, "held-out fixture has cases");
  assert.ok("mrr" in m, "ranking metrics present");
  assert.ok("recall@1" in m);
  assert.ok(Number.isFinite(m.mrr));
  assert.ok(m.mrr > 0 && m.mrr < 1, `fixtures span good and bad cases, got mrr=${m.mrr}`);
});

test("GATE PASSES on an intact workload (no false alarm)", () => {
  const s = scratch();
  try {
    const measured = runAccuracyWorkload({});
    const baseline = {
      workload: { commit: "base", corpus: "fixture-v1", reps: 3 },
      accuracy: measured,
    };
    const candidate = {
      workload: { commit: "base", corpus: "fixture-v1", reps: 3 },
      accuracy: runAccuracyWorkload({}),
    };
    const verdict = gate(baseline, candidate);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
  } finally {
    s.cleanup();
  }
});

test("VALIDITY: GATE FAILS on a deliberately degraded accuracy candidate", () => {
  const baseline = {
    workload: { commit: "base", corpus: "fixture-v1", reps: 3 },
    accuracy: { "recall@1": 1, mrr: 1 },
  };
  const degraded = {
    workload: { commit: "base", corpus: "fixture-v1", reps: 3 },
    accuracy: { "recall@1": 0, mrr: 0.1 },
  };
  const verdict = gate(baseline, degraded);
  assert.equal(verdict.ok, false, "a degraded candidate must fail the gate");
  assert.ok(verdict.reasons.some((r) => r.includes("REGRESSION")));
});

test("VALIDITY: GATE FAILS on a deliberately degraded speed candidate", () => {
  const baseline = {
    workload: { commit: "base", corpus: "fixture-v1", reps: 3 },
    speed: { depth: { n: 3, p50: 10, p95: 20, p99: 20 } },
  };
  const degraded = {
    workload: { commit: "base", corpus: "fixture-v1", reps: 3 },
    speed: { depth: { n: 3, p50: 400, p95: 900, p99: 900 } },
  };
  const verdict = gate(baseline, degraded);
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

const WL = { commit: "a", corpus: "c", env: "darwin", cache: "cold" };
const ACC = { mrr: 0.5, "recall@1": 0.5 };
const SPEED = { depth: { n: 20, p50: 100, p95: 150, p99: null } };

function candidate(extra) {
  return { workload: WL, speed: SPEED, accuracy: ACC, ...extra };
}

function baseline(extra) {
  return { workload: WL, speed: SPEED, accuracy: ACC, ...extra };
}

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
  // A candidate that reports no metrics has not proven no regression.
  const verdict = gate(baseline(), candidate({ accuracy: {} }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => /no accuracy cells/i.test(r)));
});
