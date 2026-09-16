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

import { runSpeedWorkload, runAccuracyWorkload, gate } from "./run.mjs";
import { validateFixtures } from "./fixtures.mjs";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASELINE = join(REPO, "bench", "improvement", "baseline.json");
// Sample count for a speed claim. 20 is the minimum that supports a p95 (see
// MIN_SAMPLES_FOR in eval.mjs); the runner measures the process twice so it can
// also detect machine noise and refuse to gate on it. Override with
// HEIMDALL_EVAL_REPS for a quick smoke run; keep >=20 for a real claim.
const REPS = Number(process.env.HEIMDALL_EVAL_REPS ?? 20);

function checks() {
  return [
    ["node tests", process.execPath, ["--test", join(REPO, "tests", "improvement-eval.test.mjs"), join(REPO, "tests", "improvement-run.test.mjs")]],
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

function measure() {
  const home = mkdtempSync(join(tmpdir(), "heimdall-gate-"));
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "lib.mjs"), "export function alpha() { return 1; }\n");
  try {
    const speed = runSpeedWorkload({ repo: REPO, home, proj, reps: REPS });
    return {
      workload: speed.workload,
      speed: { depth: speed.distribution },
      // Reliability must travel with the measurement: without these fields the
      // gate's noise check reads `undefined` and silently treats a polluted
      // measurement as trustworthy (observed: load average 520 produced
      // p50=169ms against a quiet-machine 116ms for identical code).
      disagreement: speed.disagreement,
      speedReliable: speed.speedReliable,
      accuracy: runAccuracyWorkload({}),
      capability: speed.capability,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
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
  const problems = validateFixtures();
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
