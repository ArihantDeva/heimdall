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

import { rankingMetrics, compareMetrics, summarizeTimings, sameWorkload } from "./eval.mjs";
import { FIXTURES } from "./fixtures.mjs";

// Absolute on purpose: see the header note. Overridable for other machines.
export const DEFAULT_PYTHON =
  process.env.HEIMDALL_EVAL_PYTHON ?? "/Users/arihantdeva/.heimdall/venv/bin/python3";

// Speed regression threshold: a candidate slower than this factor on p50 is a
// regression. Non-zero because process-level latency on a shared machine is
// noisy; the accuracy lane keeps zero tolerance.
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

function timeOne(repo, home, proj, python) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(repo, "bin", "heimdall.js"), "depth", join(proj, "lib.mjs")], {
    encoding: "utf8",
    env: cliEnv(home, python),
    timeout: 120_000,
  });
  return {
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    capability: extractCapability(r.stdout),
  };
}

/**
 * Measure real CLI latency. `samples` replaces the measured values with a
 * fixed series — used by contract tests to exercise the arithmetic without
 * depending on machine noise; production callers omit it.
 */
export function runSpeedWorkload({ repo, home, proj, reps = 5, samples = null, samples2 = null, python = DEFAULT_PYTHON }) {
  const measured = samples ?? Array.from({ length: reps }, () => timeOne(repo, home, proj, python).ms);
  const distribution = summarizeTimings(measured);
  if (distribution.n === 0) throw new Error("speed workload produced no samples");
  // Self-calibration: measure twice and refuse to compare when the machine is
  // too noisy to distinguish the two runs. Identical code measured 1.6x apart
  // under load, so without this the gate would fail honest work.
  const second = samples2 ?? (samples ? null : Array.from({ length: reps }, () => timeOne(repo, home, proj, python).ms));
  const repeat = second ? summarizeTimings(second) : null;
  const disagreement = repeat && distribution.p50 ? repeat.p50 / distribution.p50 : 1;
  const speedReliable =
    repeat === null ? true : Math.max(disagreement, 1 / disagreement) <= MAX_DISAGREEMENT;
  const capability = samples ? "fixed-samples" : timeOne(repo, home, proj, python).capability;
  return {
    command: "depth",
    distribution,
    repeat,
    disagreement,
    speedReliable,
    capability,
    workload: { commit: gitCommit(repo), corpus: "scratch-fixture", reps: distribution.n, env: process.platform, cache: "cold" },
  };
}

function extractCapability(stdout) {
  const m = /^capability:\s*(\w+)/m.exec(stdout ?? "");
  return m ? m[1] : null;
}

function gitCommit(repo) {
  const r = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : "unknown";
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
  return { ...out, n: fixtures.length };
}

function speedReasons(baseline, candidate) {
  const reliable = candidate.speedReliable ?? candidate.speed?.reliable;
  const disagreement = candidate.disagreement ?? candidate.speed?.disagreement;
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
    if (!c || b.p50 === null || c.p50 === null) continue;
    if (c.p50 > b.p50 * SPEED_TOLERANCE) {
      reasons.push(
        `SPEED REGRESSION ${key}: p50 ${b.p50}ms -> ${c.p50}ms (threshold ${SPEED_TOLERANCE}x)`,
      );
    }
  }
  return reasons;
}

/**
 * Compare a candidate measurement against the frozen baseline. Returns
 * { ok, reasons }. Refuses — and says so — when the workload differs, because
 * numbers from different workloads are not comparable.
 */
/**
 * Compare a candidate measurement against the frozen baseline. Returns
 * { ok, reasons }. Refuses — and says so — when the workload differs or when
 * either side is too noisy to compare, because numbers from different workloads
 * are not comparable and numbers from a loaded machine are not evidence.
 */
export function gate(baseline, candidate) {
  if (!sameWorkload(baseline.workload ?? {}, candidate.workload ?? {})) {
    return { ok: false, reasons: ["workload mismatch: candidate and baseline are not comparable"] };
  }
  const reasons = [
    ...compareMetrics(baseline.accuracy ?? {}, candidate.accuracy ?? {}),
    ...speedReasons(baseline, candidate),
  ];
  return { ok: reasons.length === 0, reasons };
}
