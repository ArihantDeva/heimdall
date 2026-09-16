// bench/improvement/cli.mjs — the gate entry point behind
// `mise run verify:improvement`.
//
//   (default)  measure, compare against the frozen baseline, exit 1 on regression
//   --freeze   measure and write the baseline (deliberate, baseline-breaking act)
//   --json     print the measurement artifact instead of a human report
//
// Deterministic correctness gates (node tests + bench tests) run first; the
// measurement lane runs only if they pass, so a broken tree never produces a
// number that looks like progress.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runSpeedWorkload } from "./run.mjs";
import { LOAD_SATURATION } from "./run.mjs";
import { gate } from "./gate.mjs";
import { runRetrievalWorkload } from "./retrieval-lane.mjs";
import { validateCase } from "./retrieval-case.mjs";
import { DEFAULT_PYTHON as PYTHON } from "./run.mjs";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASELINE = join(REPO, "bench", "improvement", "baseline.json");
// Sample count for a speed claim. 100 is the minimum that supports a p95 (see
// MIN_SAMPLES_FOR in eval.mjs); at n=20 the "p95" tracked the maximum and swung
// 191ms -> 386ms on identical code. The runner measures the process twice so it
// can also detect machine noise and refuse to gate on it. Override with
// HEIMDALL_EVAL_REPS for a quick smoke run — but a run below 100 cannot make a
// tail claim, and the gate reports that honestly rather than guessing.
const REPS = Number(process.env.HEIMDALL_EVAL_REPS ?? 100);

// A loaded machine must never become the baseline: the anchor is a fixed
// machine-only workload (bare node startup), and a baseline recorded while it
// is inflated makes every later comparison fail honest work. Override with
// --force when the load is understood and accepted.
const FREEZE_ANCHOR_MAX = Number(process.env.HEIMDALL_EVAL_ANCHOR_MAX ?? 120);

function checks() {
  return [
    [
      "node tests",
      process.execPath,
      [
        "--test",
        join(REPO, "tests", "improvement-eval.test.mjs"),
        join(REPO, "tests", "improvement-run.test.mjs"),
        join(REPO, "tests", "gate-hardening.test.mjs"),
        join(REPO, "tests", "retrieval-lane.test.mjs"),
      ],
    ],
    ["bench tests", "~/.heimdall/venv/bin/python3", ["-m", "pytest", join(REPO, "bench", "tests"), "-q"]],
  ];
}

function runCheck([label, cmd, args]) {
  const resolved = cmd.startsWith("~") ? cmd.replace("~", process.env.HOME ?? "") : cmd;
  const r = spawnSync(resolved, args, { encoding: "utf8", cwd: REPO, timeout: 600_000 });
  if (r.status !== 0) {
    console.error(`✖ ${label} failed\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  return r.status === 0;
}

// Every reliability field the gate reads. Kept as one function so adding a new
// field to runSpeedWorkload without forwarding it is a single-line change here
// instead of a silent dead guard downstream.
const RELIABILITY_FIELDS = [
  "disagreement",
  "speedReliable",
  "tailDisagreement",
  "tailReliable",
  "anchor",
  "anchorReadings",
  "load",
];

function reliability(speed) {
  const out = {};
  for (const field of RELIABILITY_FIELDS) out[field] = speed[field];
  const missing = RELIABILITY_FIELDS.filter((f) => out[f] === undefined);
  if (missing.length) {
    throw new Error(`speed workload did not report ${missing.join(", ")} — the gate would read undefined`);
  }
  return out;
}

function measure() {
  const home = mkdtempSync(join(tmpdir(), "heimdall-gate-"));
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "lib.mjs"), "export function alpha() { return 1; }\n");
  const retrievalHome = mkdtempSync(join(tmpdir(), "heimdall-gate-retrieval-"));
  try {
    const speed = runSpeedWorkload({ repo: REPO, home, proj, reps: REPS });
    return {
      workload: speed.workload,
      // Both batches are recorded, not just the one compared: the second
      // distribution is the evidence behind the disagreement figure, and
      // storing only the first left "uncertainty" as a bare ratio.
      speed: { depth: speed.distribution, depthRepeat: speed.repeat },
      // Reliability must travel with the measurement. This used to be a hand-
      // written list of fields, and review found `tailReliable`/`tailDisagreement`
      // missing from it — the tail guard was dead code reading `undefined`
      // (`speedReliable` had already been fixed by hand for the same reason).
      // Spreading the measurement stops the next field from being forgotten.
      ...reliability(speed),
      // Accuracy is measured on REAL retrieval (scratch index, real query
      // path), not on literals — review found the first version scored
      // hand-written arrays with zero product imports.
      accuracy: runRetrievalWorkload({ repo: REPO, home: retrievalHome, python: PYTHON }),
      capability: speed.capability,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(retrievalHome, { recursive: true, force: true });
  }
}

function report(artifact, verdict) {
  const d = artifact.speed.depth;
  console.log(`capability: ${artifact.capability}   commit: ${artifact.workload.commit}`);
  const spread = artifact.disagreement === undefined ? "" : `  repeat-spread=${artifact.disagreement.toFixed(2)}x`;
  console.log(`speed  depth  n=${d.n}  p50=${d.p50?.toFixed(1)}ms  p95=${fmt(d.p95)}ms  p99=${fmt(d.p99)}ms${spread}`);
  console.log(`accuracy  mrr=${artifact.accuracy.mrr.toFixed(3)}  recall@1=${artifact.accuracy["recall@1"].toFixed(3)}  n=${artifact.accuracy.n}`);
  if (artifact.speedReliable === false) {
    console.log("note: speed measurement is noisy on this machine — no speed claim is being made");
  }
  if (verdict.ok) {
    console.log("✔ no regression against frozen baseline");
    return;
  }
  console.error("✖ regression detected:");
  for (const reason of verdict.reasons) console.error(`  - ${reason}`);
}

const fmt = (v) => (typeof v === "number" ? v.toFixed(1) : "n/a");

function main() {
  const problems = validateCase();
  if (problems.length) {
    console.error(`✖ fixture labels are invalid:\n  - ${problems.join("\n  - ")}`);
    return 1;
  }
  for (const check of checks()) {
    if (!runCheck(check)) return 1;
  }
  const artifact = measure();
  if (process.argv.includes("--freeze")) {
    // A baseline measured on a noisy machine is not evidence — it would let a
    // real regression pass as "within noise". Refuse rather than freeze junk.
    if (artifact.speedReliable === false && !process.argv.includes("--force")) {
      console.error(
        `✖ refusing to freeze a baseline from an unreliable measurement ` +
          `(repeat spread ${artifact.disagreement?.toFixed(2)}x). Re-run when the machine is quiet, or pass --force to record it anyway.`,
      );
      return 1;
    }
    // The batch agreement check cannot see sustained load: two batches agree
    // with each other while both are uniformly inflated. Compare the run's
    // anchor against a fixed reference so a baseline is never recorded from a
    // machine state that makes every future comparison meaningless.
    const saturated = artifact.load && artifact.load.load1PerCpu > LOAD_SATURATION;
    if (!process.argv.includes("--force") && saturated) {
      console.error(
        `✖ refusing to freeze a baseline on a saturated machine ` +
          `(load ${artifact.load.load1.toFixed(1)} / ${artifact.load.cores} cores). ` +
          `A baseline recorded under load makes every later comparison fail honest work. Re-run when quiet, or pass --force.`,
      );
      return 1;
    }
    if (!process.argv.includes("--force") && artifact.anchor > FREEZE_ANCHOR_MAX) {
      console.error(
        `✖ refusing to freeze a baseline while the machine is loaded ` +
          `(anchor ${artifact.anchor.toFixed(1)}ms > ${FREEZE_ANCHOR_MAX}ms). ` +
          `A baseline recorded under load makes every later comparison fail honest work. Re-run when quiet, or pass --force.`,
      );
      return 1;
    }
    writeFileSync(BASELINE, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`✔ baseline frozen at ${BASELINE}`);
    report(artifact, { ok: true, reasons: [] });
    return 0;
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(artifact, null, 2));
    return 0;
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const verdict = gate(baseline, artifact);
  report(artifact, verdict);
  return verdict.ok ? 0 : 1;
}

process.exit(main());
