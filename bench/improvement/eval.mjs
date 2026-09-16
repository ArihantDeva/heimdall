// bench/improvement/eval.mjs — scoring and comparison primitives for the
// continuous speed/accuracy gate.
//
// Pure functions only: no I/O, no daemon, no live ~/.heimdall state. The
// runner owns measurement; this module owns the arithmetic, so the arithmetic
// is testable on any machine — including CI, which has no graft daemon.
//
// Deliberate rules encoded here (see tests/improvement-eval.test.mjs):
//   · a missing gold document scores 0 — never excluded from the average
//   · any metric drop is a regression (zero tolerance, like bench/regression_gate.py)
//   · a distribution claim needs more than one sample
//   · numbers from different workloads are never comparable

// Workload identity: what makes two measurements comparable. Only the
// CONDITIONS of measurement belong here.
//
// Not here, deliberately:
//  · `commit` — the entire purpose of a baseline is comparing different code
//    against it. Including the commit made the gate fail with "workload
//    mismatch" after every commit (observed at 8c73441 against a 4eed256
//    baseline), i.e. it was structurally incapable of measuring change. It is
//    still RECORDED in the artifact as provenance.
//  · `reps` — a measurement parameter, not a property of the workload. It was
//    wrongly included and made a 5-sample baseline incomparable with a
//    20-sample candidate, which is how MIN_SAMPLES_FOR forced more reps.
const WORKLOAD_KEYS = ["corpus", "hardware", "cache", "env"];

/** Accuracy fields that are bookkeeping, not metrics. */
export const NON_METRIC_KEYS = new Set(["n", "labels"]);

function dcg(relevances) {
  return relevances.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

function ndcgAt(ranked, goldSet, k) {
  const gains = ranked.slice(0, k).map((id) => (goldSet.has(id) ? 1 : 0));
  const ideal = Array.from({ length: Math.min(goldSet.size, k) }, () => 1);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(gains) / idealDcg;
}

/**
 * Ranking quality for one query. Binary relevance (gold is a set of ids).
 * Returns recall@k and nDCG@k for each k, plus MRR.
 */
export function rankingMetrics(ranked, gold, ks = [1, 5, 10]) {
  const goldSet = new Set(gold);
  const found = ranked.findIndex((id) => goldSet.has(id)) + 1;
  const hitRank = found === 0 ? null : found;
  const out = { mrr: hitRank ? 1 / hitRank : 0 };
  for (const k of ks) {
    out[`recall@${k}`] = hitRank !== null && hitRank <= k ? 1 : 0;
    out[`ndcg@${k}`] = ndcgAt(ranked, goldSet, k);
  }
  return out;
}

/**
 * Zero-tolerance regression check. Returns one message per dropped cell;
 * an empty array means no regression.
 */
export function compareMetrics(baseline, candidate) {
  const baseKeys = Object.keys(baseline);
  const shared = baseKeys.filter((k) => k in candidate);
  if (shared.length === 0) {
    // Nothing to compare: both sides empty means no accuracy claim is being
    // made, which is not a regression. A baseline that HAS cells with a
    // candidate that reports none IS a regression — the metrics disappeared.
    return baseKeys.length === 0 ? [] : ["candidate reports no accuracy cells; expected " + baseKeys.join(", ")];
  }
  const drops = [];
  for (const key of shared) {
    // Bookkeeping fields are compared elsewhere (n by the shape validator,
    // labels by labelReasons) and are not metrics.
    if (NON_METRIC_KEYS.has(key)) continue;
    const c = candidate[key];
    // An explicitly-undefined or NaN value is not "no regression": `NaN < 0`
    // and `undefined < 0` are both false, so a candidate reporting garbage used
    // to pass. Unusable values are reported as such.
    if (typeof c !== "number" || !Number.isFinite(c)) {
      drops.push(`UNUSABLE ${key}: candidate value is ${String(c)}`);
      continue;
    }
    const delta = c - baseline[key];
    if (delta < 0) {
      drops.push(
        `REGRESSION ${key}: ${baseline[key]} -> ${candidate[key]} (${delta.toFixed(3)})`,
      );
    }
  }
  return drops;
}

function percentile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.min(lower + 1, sorted.length - 1);
  const weight = pos - lower;
  return sorted[lower] + weight * (sorted[upper] - sorted[lower]);
}

// Minimum samples for a percentile claim. A p95 needs ~20 observations and a
// p99 needs ~100 before the number means anything; below that the "p95" is
// just the maximum wearing a statistical label. Returning null is the honest
// answer, and the gate treats null as "no claim" rather than "fast".
export const MIN_SAMPLES_FOR = { p95: 20, p99: 100 };

/**
 * Latency distribution with its sample count.
 *
 * p50 is reported from one sample; p95/p99 stay null until there are enough
 * observations to support them (see MIN_SAMPLES_FOR). `null` never means 0 —
 * a missing measurement must not read as "instant".
 */
export function summarizeTimings(samples) {
  const n = samples.length;
  if (n === 0) return { n: 0, p50: null, p95: null, p99: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n,
    p50: percentile(sorted, 0.5),
    p95: n >= MIN_SAMPLES_FOR.p95 ? percentile(sorted, 0.95) : null,
    p99: n >= MIN_SAMPLES_FOR.p99 ? percentile(sorted, 0.99) : null,
  };
}

/**
 * Two measurements are only comparable when the workload that produced them
 * matches. Missing keys on both sides are ignored.
 */
export function sameWorkload(a, b) {
  return WORKLOAD_KEYS.every((key) => {
    if (a[key] === undefined && b[key] === undefined) return true;
    return a[key] === b[key];
  });
}
