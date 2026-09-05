// Graded health score (C4, scoring half). The invariant is the test target:
// the score is pure arithmetic over issue counts, deterministic, and never
// negative — no daemon, journal, or graft round-trips involved.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeHealthScore,
  classifyWhy,
  classifyDrift,
  WEIGHTS,
} from "../bin/lib/health-score.mjs";

test("zero issues scores a perfect 100 / healthy", () => {
  assert.deepEqual(computeHealthScore({ errors: 0, warnings: 0, infos: 0 }), {
    score: 100,
    band: "healthy",
  });
  assert.deepEqual(computeHealthScore(), { score: 100, band: "healthy" });
});

test("known vector: 1 error + 2 warnings = 100 − (10 + 6) = 84", () => {
  assert.deepEqual(computeHealthScore({ errors: 1, warnings: 2, infos: 0 }), {
    score: 84,
    band: "degraded",
  });
});

test("clamped at zero — penalties below −100 do not go negative", () => {
  const r = computeHealthScore({ errors: 11 }); // 100 − 110
  assert.equal(r.score, 0);
  assert.equal(r.band, "critical");
  assert.deepEqual(
    computeHealthScore({ errors: 999, warnings: 999, infos: 999 }).score,
    0,
  );
});

test("band boundaries: 90 is healthy, 89 degraded; 60 degraded, 59 critical", () => {
  // infos only → boundary values land exactly on the seams.
  assert.deepEqual(computeHealthScore({ infos: 10 }), { score: 90, band: "healthy" });
  assert.deepEqual(computeHealthScore({ infos: 11 }), { score: 89, band: "degraded" });
  assert.deepEqual(computeHealthScore({ infos: 40 }), { score: 60, band: "degraded" });
  assert.deepEqual(computeHealthScore({ infos: 41 }), { score: 59, band: "critical" });
});

test("weights are exactly 10/3/1 (Vault evidence model)", () => {
  assert.deepEqual(WEIGHTS, { error: 10, warning: 3, info: 1 });
});

test("garbage inputs degrade to zero issues, never NaN or throw", () => {
  for (const bad of [
    { errors: -5 },
    { errors: Number.NaN },
    { errors: "3" }, // numeric string counts
    { errors: 2.9 }, // fractional floors
    null,
  ]) {
    const r = computeHealthScore(bad);
    assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100);
    assert.ok(["healthy", "degraded", "critical"].includes(r.band));
  }
  assert.equal(computeHealthScore(null).score, 100);
  assert.deepEqual(computeHealthScore({ errors: "2" }), {
    score: 80,
    band: "degraded",
  });
  // counts are floored per-field before weighting, not after
  assert.deepEqual(computeHealthScore({ errors: 2.9 }), {
    score: 80,
    band: "degraded",
  });
});

test("why classification: missing=error, reappeared/hash=warning, mtime/size+depth=info", () => {
  assert.equal(classifyWhy("missing"), "errors");
  assert.equal(classifyWhy("reappeared"), "warnings");
  assert.equal(classifyWhy("hash"), "warnings");
  assert.equal(classifyWhy("mtime/size"), "infos");
  assert.equal(classifyWhy("depth path -> file"), "infos");
  // Unknown future whys must not crash scoring nor masquerade as errors.
  assert.equal(classifyWhy("something-new-later"), "infos");
  assert.equal(classifyWhy(undefined), "infos");
});

test("drift rows fold into severity counts", () => {
  assert.deepEqual(
    classifyDrift([
      { path: "/a", why: "missing" },
      { path: "/b", why: "mtime/size" },
      { path: "/c", why: "hash" },
      { path: "/d", why: "reappeared" },
      { path: "/e", why: "depth path -> file" },
    ]),
    { errors: 1, warnings: 2, infos: 2 },
  );
  assert.deepEqual(classifyDrift([]), { errors: 0, warnings: 0, infos: 0 });
  assert.deepEqual(classifyDrift(null), { errors: 0, warnings: 0, infos: 0 });
});

test("end-to-end shape: drift rows → score, matching hand arithmetic", () => {
  const drift = classifyDrift([
    { path: "/x", why: "missing" },
    { path: "/y", why: "mtime/size" },
    { path: "/z", why: "reappeared" },
  ]);
  // 100 − (10·1 + 3·1 + 1·1) = 86
  assert.deepEqual(computeHealthScore(drift), { score: 86, band: "degraded" });
});
