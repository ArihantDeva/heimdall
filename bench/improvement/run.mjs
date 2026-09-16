// bench/improvement/run.mjs — the improvement evaluation runner.
//
// Two lanes, measured separately and never blended:
//   speed    — real CLI process latency in a scratch HOME
//   accuracy — ranking metrics over held-out labeled fixtures
//
// Hermetic by construction: every run gets its own HOME, its own project dir,
// and an absolute HEIMDALL_PYTHON. No daemon, no network, no live ~/.heimdall
// state. Under a scratch HOME the venv candidate resolves INSIDE the scratch
// dir, so a relative python path silently degrades the run to `capability:
// file` (L2/L3 off) — hence the absolute default below.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { rankingMetrics, compareMetrics, summarizeTimings, sameWorkload, NON_METRIC_KEYS } from "./eval.mjs";
import { FIXTURES, fixturesHash } from "./fixtures.mjs";

// Absolute on purpose: see the header note. Overridable for other machines.
export const DEFAULT_PYTHON =
  process.env.HEIMDALL_EVAL_PYTHON ?? "/Users/arihantdeva/.heimdall/venv/bin/python3";

// Speed regression threshold: a candidate slower than this factor on p50 (or on
// p95) is a regression. Non-zero because process-level latency on a shared
// machine is noisy; the accuracy lane keeps zero tolerance.
export const SPEED_TOLERANCE = 1.5;

// Below this ratio the measurement is not usable evidence: the same command
// measured p50=163ms immediately after a heavy pytest run and p50=101ms when
// the machine was quiet — a 1.6x swing with identical code. Rather than gate on
// noise (which would fail honest work and pass regressions by luck), the runner
// re-measures once and reports the disagreement instead of a verdict.
export const MAX_DISAGREEMENT = 1.25;

function cliEnv(home, python) {
  return { ...process.env, HOME: home, HEIMDALL_PYTHON: python };
}

function extractCapability(stdout) {
  const m = /^capability:\s*(\w+)/m.exec(stdout ?? "");
  return m ? m[1] : null;
}

function gitCommit(repo) {
  const r = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

function timeOne(repo, home, proj, python) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(repo, "bin", "heimdall.js"), "depth", join(proj, "lib.mjs")], {
    encoding: "utf8",
    env: cliEnv(home, python),
    timeout: 120_000,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // A broken CLI is not a fast CLI. Without this check a stub containing only
  // `process.exit(1)` measured p50 49.8ms against a 300ms baseline and the gate
  // accepted it as a 6x speedup. Failure must never enter the distribution.
  if (r.error || r.status !== 0) {
    throw new Error(
      `heimdall depth failed (status=${r.status ?? "spawn-error"}): ${String(r.error?.message ?? r.stderr ?? "").trim().slice(0, 300)}`,
    );
  }
  return { ms, capability: extractCapability(r.stdout) };
}

/**
 * Measure real CLI latency. `samples`/`samples2` replace the measured values
 * with fixed series — used by contract tests to exercise the arithmetic without
 * depending on machine noise; production callers omit them.
 */
export function runSpeedWorkload({ repo, home, proj, reps = 5, samples = null, samples2 = null, python = DEFAULT_PYTHON }) {
  const fixed = samples !== null;
  const measured = fixed ? samples : Array.from({ length: reps }, () => timeOne(repo, home, proj, python).ms);
  const distribution = summarizeTimings(measured);
  if (distribution.n === 0) throw new Error("speed workload produced no samples");
  // Self-calibration: measure twice and refuse to compare when the machine is
  // too noisy to distinguish the two runs.
  const second = fixed ? samples2 : Array.from({ length: reps }, () => timeOne(repo, home, proj, python).ms);
  const repeat = second === null ? null : summarizeTimings(second);
  const disagreement = repeat && distribution.p50 ? repeat.p50 / distribution.p50 : 1;
  const speedReliable = repeat === null ? true : Math.max(disagreement, 1 / disagreement) <= MAX_DISAGREEMENT;
  // The tail gets its own reliability check. A batch pair can agree closely on
  // p50 while disagreeing on p95 (observed: spread 1.07x on p50 with p95
  // 115ms vs 202ms), and claiming a p95 regression from that is asserting a
  // number the measurement does not support.
  const tailDisagreement =
    repeat && distribution.p95 && repeat.p95 ? repeat.p95 / distribution.p95 : 1;
  const tailReliable =
    repeat === null || repeat.p95 === null || distribution.p95 === null
      ? true
      : Math.max(tailDisagreement, 1 / tailDisagreement) <= MAX_DISAGREEMENT;
  const capability = fixed ? "fixed-samples" : timeOne(repo, home, proj, python).capability;
  return {
    command: "depth",
    distribution,
    repeat,
    disagreement,
    speedReliable,
    tailDisagreement,
    tailReliable,
    capability,
    workload: {
      commit: gitCommit(repo),
      corpus: "scratch-fixture",
      env: process.platform,
      cache: "cold",
      reps: distribution.n,
    },
  };
}

/**
 * Score the retrieval/verdict path against held-out labeled fixtures.
 * Binary relevance: each fixture names the gold ids that must be found.
 */
export function runAccuracyWorkload({ fixtures = FIXTURES } = {}) {
  const perCase = fixtures.map((f) => rankingMetrics(f.ranked, f.gold, [1, 5]));
  const keys = Object.keys(perCase[0]);
  const out = {};
  for (const key of keys) {
    out[key] = perCase.reduce((sum, m) => sum + m[key], 0) / perCase.length;
  }
  return { ...out, n: fixtures.length, labels: fixturesHash(fixtures) };
}

/**
 * Validate a measurement artifact before comparing it. Six distinct ways the
 * gate returned ok:true on garbage were found by adversarial review: empty
 * artifacts, a missing speed lane, zero samples, NaN metrics, negative timings,
 * and metrics that silently shrank. All are shape problems, so shape is checked
 * first and produces a refusal rather than a verdict.
 */
export function validateArtifact(artifact, label) {
  if (!artifact || typeof artifact !== "object") return [`${label}: not an object`];
  return [...accuracyShape(artifact.accuracy, label), ...speedShape(artifact.speed, label)];
}

function accuracyShape(accuracy, label) {
  if (!accuracy || typeof accuracy !== "object" || Object.keys(accuracy).length === 0) {
    return [`${label}: no accuracy metrics`];
  }
  const problems = [];
  for (const [key, value] of Object.entries(accuracy)) {
    if (NON_METRIC_KEYS.has(key)) continue;
    // per-query detail is evidence payload, not a scalar metric.
    if (Array.isArray(value)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      problems.push(`${label}: accuracy.${key} is not a finite non-negative number (${value})`);
    }
  }
  if (!Number.isFinite(accuracy.n) || accuracy.n <= 0) {
    problems.push(`${label}: accuracy.n must be a positive number (${accuracy.n})`);
  }
  return problems;
}

function speedShape(speed, label) {
  if (!speed || typeof speed !== "object" || Object.keys(speed).length === 0) {
    return [`${label}: no speed measurements`];
  }
  const problems = [];
  for (const [key, cell] of Object.entries(speed)) {
    if (!cell || typeof cell !== "object") {
      problems.push(`${label}: speed.${key} is not a measurement`);
      continue;
    }
    if (!Number.isFinite(cell.n) || cell.n <= 0) {
      problems.push(`${label}: speed.${key}.n must be positive (${cell.n})`);
    }
    if (typeof cell.p50 !== "number" || !Number.isFinite(cell.p50) || cell.p50 <= 0) {
      problems.push(`${label}: speed.${key}.p50 is not a positive finite number (${cell.p50})`);
    }
  }
  return problems;
}

/** Metrics the candidate must still report; a shrinking set is not a pass. */
function missingKeys(baseline, candidate) {
  const cand = candidate.accuracy ?? {};
  return Object.keys(baseline.accuracy ?? {}).filter((key) => !(key in cand));
}

function speedReasons(baseline, candidate) {
  const reliable = candidate.speedReliable;
  const disagreement = candidate.disagreement;
  if (reliable === false) {
    const spread = typeof disagreement === "number" ? `${disagreement.toFixed(2)}x` : "unknown";
    return [
      `speed measurement unusable: repeat runs disagreed by ${spread} ` +
        `(max ${MAX_DISAGREEMENT}x) — re-run on a quiet machine`,
    ];
  }
  const reasons = [];
  for (const key of Object.keys(baseline.speed ?? {})) {
    const b = baseline.speed[key];
    const c = candidate.speed?.[key];
    if (!c || typeof b.p50 !== "number" || typeof c.p50 !== "number") continue;
    if (c.p50 > b.p50 * SPEED_TOLERANCE) {
      reasons.push(
        `SPEED REGRESSION ${key}: p50 ${b.p50}ms -> ${c.p50}ms (threshold ${SPEED_TOLERANCE}x)`,
      );
    }
  }
  return reasons;
}

function tailReasons(baseline, candidate) {
  const reasons = [];
  if (candidate.tailReliable === false) {
    const spread = typeof candidate.tailDisagreement === "number" ? `${candidate.tailDisagreement.toFixed(2)}x` : "unknown";
    // Not a pass either: no tail claim can be made, and silently returning []
    // would read as "tail is fine".
    return [`speed tail unmeasurable: repeat runs disagreed by ${spread} (max ${MAX_DISAGREEMENT}x) — no p95 claim is possible`];
  }
  for (const key of Object.keys(baseline.speed ?? {})) {
    const b = baseline.speed[key];
    const c = candidate.speed?.[key];
    // Improving the median while making 1-in-20 calls far slower is not an
    // improvement; p95 gets the same tolerance as p50.
    if (!c || typeof b.p95 !== "number" || typeof c.p95 !== "number") continue;
    if (c.p95 > b.p95 * SPEED_TOLERANCE) {
      reasons.push(
        `SPEED TAIL REGRESSION ${key}: p95 ${b.p95}ms -> ${c.p95}ms (threshold ${SPEED_TOLERANCE}x)`,
      );
    }
  }
  return reasons;
}

function capabilityReasons(baseline, candidate) {
  const b = baseline.capability;
  if (b === undefined) return [];
  const c = candidate.capability;
  if (c === undefined || c === null) {
    return [`capability missing (baseline ${b}) — the probe produced no verdict, so depth is unproven`];
  }
  if (c !== b && c !== "fixed-samples") {
    // Correctness, not speed: dropping graph -> file disables L2/L3 extraction
    // (issue #12) while every latency number can still look healthy.
    return [`CAPABILITY REGRESSION: ${b} -> ${c} (extraction depth changed)`];
  }
  return [];
}

function labelReasons(baseline, candidate) {
  const b = baseline.accuracy?.labels;
  const c = candidate.accuracy?.labels;
  if (!b || !c) return [];
  return b === c
    ? []
    : [`labels changed (${b} -> ${c}): the accuracy baseline was built from different labels and is not comparable`];
}

/**
 * Compare a candidate measurement against the frozen baseline. Returns
 * { ok, reasons }. Refuses — rather than judging — when an artifact is
 * malformed, when metrics disappeared, when the labels changed, when the
 * workload differs, or when either side is too noisy to compare.
 */
export function gate(baseline, candidate) {
  if (!sameWorkload(baseline.workload ?? {}, candidate.workload ?? {})) {
    return { ok: false, reasons: ["workload mismatch: candidate and baseline are not comparable"] };
  }
  const shape = [...validateArtifact(baseline, "baseline"), ...validateArtifact(candidate, "candidate")];
  if (shape.length) return { ok: false, reasons: shape };
  const gone = missingKeys(baseline, candidate);
  if (gone.length) return { ok: false, reasons: [`candidate no longer reports: ${gone.join(", ")}`] };
  const speed = speedReasons(baseline, candidate);
  const reasons = [
    ...compareMetrics(baseline.accuracy ?? {}, candidate.accuracy ?? {}),
    ...speed,
    // Speed tail and capability are only meaningful when the speed measurement
    // itself is usable. Reporting a p95 "regression" from a noisy run would be
    // asserting a number the runner just refused to stand behind.
    ...(speed.length ? [] : [...tailReasons(baseline, candidate), ...capabilityReasons(baseline, candidate)]),
    ...labelReasons(baseline, candidate),
  ];
  return { ok: reasons.length === 0, reasons };
}
