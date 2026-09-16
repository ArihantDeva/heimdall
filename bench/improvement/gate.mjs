// bench/improvement/gate.mjs — verdict logic: artifact validation and the
// baseline comparison. Split from run.mjs (measurement) to keep each module
// under the repo's file-size limit and to make the two responsibilities
// separately reviewable: run.mjs produces numbers, gate.mjs judges them.
//
// Constants (SPEED_TOLERANCE, MAX_DISAGREEMENT) live in run.mjs and are
// imported here so there is exactly one source for each threshold.
import { compareMetrics, sameWorkload, NON_METRIC_KEYS } from "./eval.mjs";
import { SPEED_TOLERANCE, MAX_DISAGREEMENT, ANCHOR_TOLERANCE } from "./run.mjs";

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

/**
 * Machine-load anchoring: refuses speed claims when the whole machine is slow.
 *
 * The baseline records a fixed anchor (bare node startup). If this run's anchor
 * is inflated beyond the same tolerance, the environment changed — every
 * latency number is suspect, including a suspiciously fast one.
 */
function anchorReasons(baseline, candidate) {
  const b = baseline.anchor;
  const c = candidate.anchor;
  if (typeof b !== "number" || typeof c !== "number" || b <= 0) return [];
  if (c > b * ANCHOR_TOLERANCE) {
    return [
      `machine load changed: baseline anchor ${b.toFixed(1)}ms -> ${c.toFixed(1)}ms ` +
        `(>${ANCHOR_TOLERANCE}x). No speed claim is possible — re-run on a comparable machine state.`,
    ];
  }
  return [];
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
  const anchor = anchorReasons(baseline, candidate);
  const reasons = [
    ...compareMetrics(baseline.accuracy ?? {}, candidate.accuracy ?? {}),
    // When the machine-load anchor fails, EVERY latency number is suspect, so
    // no speed claim is made at all — reporting a p50 "regression" from a
    // loaded machine asserts a code change that the measurement cannot support.
    ...(anchor.length ? [] : speed),
    ...anchor,
    // Speed tail and capability are only meaningful when the speed measurement
    // itself is usable. Reporting a p95 "regression" from a noisy or
    // load-skewed run would be asserting a number the runner just refused.
    ...(speed.length || anchor.length
      ? []
      : [...tailReasons(baseline, candidate), ...capabilityReasons(baseline, candidate)]),
    ...labelReasons(baseline, candidate),
  ];
  return { ok: reasons.length === 0, reasons };
}
