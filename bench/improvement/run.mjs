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

import { summarizeTimings } from "./eval.mjs";

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

// Machine-load anchor tolerance: how much the fixed anchor may inflate before
// the machine itself is judged to have changed and speed claims are refused.
export const ANCHOR_TOLERANCE = 1.5;

function cliEnv(home, python) {
  return { ...process.env, HOME: home, HEIMDALL_PYTHON: python };
}

/**
 * Machine load anchor.
 *
 * The batch-to-batch disagreement check cannot see SUSTAINED load: under a
 * machine at load 280 both batches are uniformly slow, agree with each other,
 * and pass — while the p50 is 2x the baseline that was recorded on a quiet
 * machine. Observed repeatedly, and it fails honest work.
 *
 * So we also measure a fixed, machine-only workload (bare node startup) and
 * compare it against the value recorded in the baseline. If the anchor itself
 * is inflated, the machine — not the code — changed, and no speed claim is
 * possible. This is deliberately not free: it is one extra spawn, and it is the
 * only way to distinguish "your change is slower" from "your laptop is busy".
 */
export function measureAnchor() {
  const samples = Array.from({ length: 5 }, () => {
    const started = process.hrtime.bigint();
    spawnSync(process.execPath, ["-e", ""], { stdio: "ignore", timeout: 30_000 });
    return Number(process.hrtime.bigint() - started) / 1e6;
  });
  return summarizeTimings(samples).p50;
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
    anchor: fixed ? null : measureAnchor(),
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

