// health-score.mjs — graded health score (C4, scoring half ONLY).
//
// Pure arithmetic over issue counts: score = 100 − (10·error + 3·warning +
// 1·info), clamped at 0, banded healthy ≥90 / degraded 60–89 / critical <60.
// Weights mirror the Perseus Vault evidence model (src/drift_check.rs).
//
// Deliberately NOT here: any repair gating, deletion logic, or rollback. The
// adversarial verdict (perseus C4) rejected the self-repair half — Heimdall's
// reconciler already guarantees convergence via generation counters, and a
// buggy scorer must never become an automated deleter.
//
// Severity taxonomy is a declarative table (data edit, not code edit, when
// calibration changes). Sources fed into the counts:
//   - `heimdall verify` drift rows ({path, why}, see reconcile.mjs audit())
//   - kb-stale-scan.py --count-only {nodes, stale} — fully-dead nodes pending
//     a delete decision count as WARNINGS, never errors: removing memory must
//     never be cheaper than fixing an anchor.

export const WEIGHTS = Object.freeze({ error: 10, warning: 3, info: 1 });

// why-pattern → count bucket, first match wins. Order matters: "missing"
// must outrank the gentler patterns, and unknown future whys fall through to
// infos so a taxonomy gap degrades the score gently instead of crashing it.
export const WHY_SEVERITY = Object.freeze([
  [/\bmissing\b/, "errors"], // indexed path gone — retrieval lies
  [/\breappeared\b/, "warnings"], // recorded-absent content came back
  [/\bhash\b/, "warnings"], // silent same-size/same-mtime rewrite
  [/mtime\/size/, "infos"], // routine edit awaiting reconcile
  [/\bdepth\b/, "infos"], // capability upgrade, not decay
]);

export function classifyWhy(why) {
  for (const [pattern, bucket] of WHY_SEVERITY) {
    if (pattern.test(String(why ?? ""))) return bucket;
  }
  return "infos";
}

/** Fold verify drift rows into {errors, warnings, infos}. */
export function classifyDrift(rows) {
  const counts = { errors: 0, warnings: 0, infos: 0 };
  for (const r of rows ?? []) counts[classifyWhy(r?.why)] += 1;
  return counts;
}

/**
 * computeHealthScore({errors, warnings, infos}) → {score, band}.
 * Garbage-resistant: negative/fractional/NaN inputs are floored/clamped to a
 * non-negative integer before arithmetic, so the score stays in [0, 100].
 */
export function computeHealthScore(counts) {
  const { errors = 0, warnings = 0, infos = 0 } = counts ?? {};
  const nonNegInt = (n) =>
    Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
  const penalty =
    WEIGHTS.error * nonNegInt(errors) +
    WEIGHTS.warning * nonNegInt(warnings) +
    WEIGHTS.info * nonNegInt(infos);
  const score = Math.max(0, 100 - penalty);
  const band = score >= 90 ? "healthy" : score >= 60 ? "degraded" : "critical";
  return { score, band };
}
