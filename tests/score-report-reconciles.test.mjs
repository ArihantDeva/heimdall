// score-report-reconciles.test.mjs — the health report must add up.
//
// WHY THIS EXISTS (measured 2026-10-23)
// `heimdall score` computes the score from `counts.warnings + staleWarn +
// staleIssue` but then printed `{ ...counts }`, the RAW drift counts. With a
// corrupt graph the stale scan fails, so staleIssue = 1 and the score is 97 — yet
// the report said:
//
//     { "score": 97, "band": "healthy",
//       "issues": { "errors": 0, "warnings": 0, "infos": 0, "staleScanFailed": true } }
//
// Three points unaccounted for. WEIGHTS are error 10 / warning 3 / info 1, so
// score 100 - 3 means exactly one warning was charged, while the report showed
// none — a reader could not reconcile the number, and a script summing
// issues.* would compute a different score from the one printed.
//
// The sensor-loss handling itself was already correct (fail closed: a dead scan
// charges a warning instead of dropping its reading). Only the reporting was
// wrong, which is the part a human or a dashboard actually reads.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "bin", "heimdall.js");
const PY = plainPython();

// Weights mirrored from bin/lib/health-score.mjs. The test recomputes the score
// from the REPORTED counts and asserts it matches the printed score — that is the
// property that was violated, independent of the weight values themselves.
const WEIGHTS = { error: 10, warning: 3, info: 1 };

function sandbox(dbContents) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-score-"));
	const prof = join(home, ".graft", "profiles", "default");
	mkdirSync(prof, { recursive: true });
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	const db = join(prof, "graft.db");
	if (dbContents === null) {
		// no database at all: fresh install
	} else if (dbContents === "corrupt") {
		writeFileSync(db, "this is not a database");
	} else {
		const r = spawnSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE nodes (id BLOB, title TEXT, body TEXT)")
c.commit(); c.close()
`, db], { encoding: "utf8", timeout: 60_000 });
		if (r.status !== 0) throw new Error(r.stderr);
	}
	return home;
}

async function score(home) {
	const r = spawnSync(process.execPath, [CLI, "score"], {
		encoding: "utf8", timeout: 180_000,
		env: { ...process.env, HOME: home, HEIMDALL_PYTHON: PY },
	});
	const line = (r.stdout || "").trim();
	if (!line) throw new Error(`no stdout from score; stderr=${r.stderr}`);
	return { json: JSON.parse(line), status: r.status };
}

describe("heimdall score: the printed report reconciles with the printed score", () => {
	it("a corrupt graph charges a warning AND reports it", async () => {
		const { json } = await score(sandbox("corrupt"));
		// The defect: staleScanFailed true, warnings 0, score 97.
		expect(json.issues.staleScanFailed).toBe(true);
		expect(json.issues.warnings, "the dead sensor must appear in the report, not only in the score").toBeGreaterThan(0);
	});

	it("the reported counts reproduce the reported score", async () => {
		// The invariant, stated as arithmetic so it holds whatever the weights are.
		for (const kind of ["corrupt", "empty"]) {
			const { json } = await score(sandbox(kind === "corrupt" ? "corrupt" : "valid"));
			const i = json.issues;
			const recomputed = Math.max(0, 100 - (
				WEIGHTS.error * i.errors + WEIGHTS.warning * i.warnings + WEIGHTS.info * i.infos
			));
			expect(recomputed, `${kind}: printed score ${json.score} but counts give ${recomputed} (${JSON.stringify(i)})`)
				.toBe(json.score);
		}
	});

	it("a healthy graph still reports a perfect score", async () => {
		// The fix must not charge a warning when the scan SUCCEEDS; over-charging
		// would make every healthy install look degraded.
		const { json } = await score(sandbox("valid"));
		expect(json.issues.staleScanFailed).toBe(false);
		expect(json.score).toBe(100);
		expect(json.band).toBe("healthy");
	});

	it("a missing database is a fresh install, not a dead sensor", async () => {
		// count_only() returns {nodes:0,stale:0} when no DB exists — the sanctioned
		// empty state — so the scan did NOT fail and no warning is due. Pinned so a
		// blanket "no data means warn" change would be caught.
		const { json } = await score(sandbox(null));
		expect(json.issues.staleScanFailed).toBe(false);
		expect(json.score).toBe(100);
	});

	it("exits 0 in healthy and nonzero only when critical", async () => {
		const { status, json } = await score(sandbox("corrupt"));
		if (json.band !== "critical") expect(status).toBe(0);
	});
});
