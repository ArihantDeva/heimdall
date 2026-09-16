// bench/improvement/validate.mjs — artifact shape validation.
//
// Split from gate.mjs to keep each module under the repo's file-size limit.
// Shape problems are refusals, not verdicts: review found six ways a malformed
// artifact (empty, missing lane, zero samples, NaN, negative, shrunk metrics)
// was previously accepted as 'no regression'.
import { NON_METRIC_KEYS } from "./eval.mjs";

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

