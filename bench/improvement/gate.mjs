// bench/improvement/gate.mjs — verdict logic: artifact validation and the
// baseline comparison. Split from run.mjs (measurement) to keep each module
// under the repo's file-size limit and to make the two responsibilities
// separately reviewable: run.mjs produces numbers, gate.mjs judges them.
//
// Constants (SPEED_TOLERANCE, MAX_DISAGREEMENT) live in run.mjs and are
// imported here so there is exactly one source for each threshold.
import { compareMetrics, sameWorkload } from "./eval.mjs";
import { validateArtifact } from "./validate.mjs";
import { SPEED_TOLERANCE, MAX_DISAGREEMENT, ANCHOR_TOLERANCE } from "./run.mjs";
import { MIN_SAMPLES_FOR } from "./eval.mjs";

/**
 * Speed cells that are evidence, not targets of comparison.
 *
 * `depthRepeat` is the SECOND batch of the same measurement — the evidence
 * behind the disagreement figure. Comparing it like an independent workload
 * would compare one run's noise against another's and report a "regression"
 * that is pure variance.
 */
const EVIDENCE_CELLS = new Set(["depthRepeat"]);

const comparedSpeedCells = (speed) =>
  Object.keys(speed ?? {}).filter((key) => !EVIDENCE_CELLS.has(key));

/** Metrics the candidate must still report; a shrinking set is not a pass. */
function missingKeys(baseline, candidate) {
  const problems = [];
  const cand = candidate.accuracy ?? {};
  for (const key of Object.keys(baseline.accuracy ?? {})) {
    if (!(key in cand)) problems.push(key);
  }
  // Speed cell names are part of the contract too: review found renaming the
  // cell (`speed:{other:...}`) made the whole speed lane vanish from the
  // comparison while the gate returned ok:true.
  const baseCells = comparedSpeedCells(baseline.speed);
  const candCells = Object.keys(candidate.speed ?? {});
  for (const key of baseCells) {
    if (!candCells.includes(key)) problems.push(`speed.${key}`);
  }
  return problems;
}

/**
 * An unchanged metric over a SHIFTED per-query slice is not an unchanged
 * result. Review showed a per-query swap (one query 1.0 -> 0.5, another
 * 0.0 -> 0.5) keeps every average identical while real performance moved in two
 * places. Averages hid it; per-query comparison does not.
 */
function perQueryReasons(baseline, candidate) {
  const b = baseline.accuracy?.perQuery;
  const c = candidate.accuracy?.perQuery;
  if (!Array.isArray(b) || b.length === 0) return [];
  if (!Array.isArray(c) || c.length !== b.length) {
    return [`per-query detail missing or the query count changed (${b.length} -> ${c?.length ?? 0})`];
  }
  const byId = new Map(c.map((q) => [q.id, q]));
  const reasons = [];
  for (const before of b) {
    const after = byId.get(before.id);
    if (!after) {
      reasons.push(`query "${before.id}" disappeared from the candidate`);
      continue;
    }
    for (const [key, value] of Object.entries(before.metrics ?? {})) {
      const now = after.metrics?.[key];
      if (typeof now === "number" && typeof value === "number" && now < value) {
        reasons.push(
          `PER-QUERY REGRESSION ${before.id}.${key}: ${value} -> ${now}`,
        );
      }
    }
  }
  return reasons;
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
  for (const key of comparedSpeedCells(baseline.speed)) {
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
    return [`speed tail unmeasurable: repeat runs disagreed by ${spread} (max ${MAX_DISAGREEMENT}x) — no p95 claim is possible`];
  }
  for (const key of comparedSpeedCells(baseline.speed)) {
    const b = baseline.speed[key];
    const c = candidate.speed?.[key];
    if (!c) continue;
    // A null p95 is NOT a pass. Review finding B1: with n below the sample
    // floor the p95 is null, the old code `continue`d past it, and an identical
    // tail regression was refused at n=100 but accepted at n=20 — silently.
    // If the baseline can state a tail and the candidate cannot, the candidate
    // has not shown the tail is fine; that is a refusal, not a green.
    if (typeof b.p95 === "number" && typeof c.p95 !== "number") {
      reasons.push(
        `speed tail unmeasurable for ${key}: baseline p95=${b.p95}ms but this run reported none ` +
          `(n=${c.n}; a p95 needs >=${MIN_SAMPLES_FOR.p95} samples) — raise HEIMDALL_EVAL_REPS or report no tail claim`,
      );
      continue;
    }
    if (typeof b.p95 !== "number" || typeof c.p95 !== "number") continue;
    // Improving the median while making 1-in-20 calls far slower is not an
    // improvement; p95 gets the same tolerance as p50.
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
 * is inflated beyond the tolerance, the environment changed — every latency
 * number is suspect, including a suspiciously fast one.
 *
 * A missing or non-numeric anchor on EITHER side is a refusal, not a skip:
 * review found `NaN`/`0`/`-1`/`"999"`/absent all disabled the guard and returned
 * ok:true, and the fast path is exactly where the anchor is easiest to break.
 */
function anchorReasons(baseline, candidate) {
  const b = baseline.anchor;
  const c = candidate.anchor;
  const usable = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (b === undefined && c === undefined) {
    return ["no machine-load anchor recorded on either side — speed comparability is unproven"];
  }
  if (!usable(b)) return [`baseline anchor is not usable (${String(b)}) — no speed claim is possible`];
  if (!usable(c)) return [`candidate anchor is not usable (${String(c)}) — no speed claim is possible`];
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
  const c = candidate.capability;
  // A missing capability record on either side is a refusal, not a skip. The
  // anchor guard was hardened for exactly this reason after review; capability
  // was left with the old `if (b === undefined) return []` behaviour, which
  // meant a baseline frozen without a capability record silently disabled the
  // check (verified: `anchors present, capability absent -> ok:true`).
  if (b === undefined || b === null) {
    return ["baseline records no capability verdict — extraction depth is unproven, so no green is justified"];
  }
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
  // Sample count is part of comparability: 9 queries and 1 query are not the
  // same measurement, even when every average matches. Review found n shrinking
  // to 1 passing the gate.
  if (baseline.accuracy?.n !== candidate.accuracy?.n) {
    return {
      ok: false,
      reasons: [`query count changed: ${baseline.accuracy?.n} -> ${candidate.accuracy?.n}`],
    };
  }
  const gone = missingKeys(baseline, candidate);
  if (gone.length) return { ok: false, reasons: [`candidate no longer reports: ${gone.join(", ")}`] };
  const speed = speedReasons(baseline, candidate);
  const anchor = anchorReasons(baseline, candidate);
  const reasons = [
    ...compareMetrics(baseline.accuracy ?? {}, candidate.accuracy ?? {}),
    ...perQueryReasons(baseline, candidate),
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
