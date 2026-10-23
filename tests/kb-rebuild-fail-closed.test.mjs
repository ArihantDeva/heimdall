// kb-rebuild-fail-closed.test.mjs — the one script that DROPs every graph table
// must not do so when its safety copy failed.
//
// WHY THIS EXISTS (measured 2026-10-23)
// bin/kb-rebuild.sh had no test at all and ran under `set -u` only — no -e.
// Its shape is:
//     1. back up graft.db + JSON-dump every node   (the ONLY safety copy)
//     2. DROP nodes/edges/keywords/vec/fts/similarity
//     3. re-insert every dumped node
// With `set -u` alone a FAILED backup printed an error, the wipe ran anyway, and
// the script exited 0 — verified by running the same structure with a failing
// backup: "backup FAILED" then "DROPPING EVERYTHING", exit 0. That is total loss
// reported as success.
//
// A second path had the same consequence: after the wipe the JSON dump is the
// only copy of those nodes, so a restore that fails leaves the graph EMPTY. The
// fail count was printed and then ignored.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "kb-rebuild.sh");
const RAW = readFileSync(SCRIPT, "utf8");
// Comments in this file quote the old buggy code, so they must not satisfy or
// break a source assertion.
const SRC = RAW.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");

const i = (needle) => SRC.indexOf(needle);

describe("kb-rebuild: destructive steps fail closed", () => {
	it("checks the backup's exit status", () => {
		// Without this the wipe runs on a failed backup.
		expect(SRC).toMatch(/BK_RC=\$\?/);
		expect(SRC).toMatch(/BK_RC"?-eq 0|-eq 0 \]/);
	});

	it("refuses to wipe when the backup failed", () => {
		// The guard must precede the DROP, not follow it.
		const guard = i("BK_RC");
		const drop = i("DROP TABLE IF EXISTS");
		expect(guard).toBeGreaterThan(-1);
		expect(drop).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(drop);
	});

	it("treats an empty backup file as a failure", () => {
		// A backup that "succeeded" but wrote 0 bytes is worse than a loud
		// failure, because the next step destroys the source.
		expect(SRC).toMatch(/getsize\(sys\.argv\[1\]\) == 0/);
	});

	it("aborts when the restore did not re-insert every node", () => {
		// After the DROP the JSON dump is the only copy; a partial restore means
		// those nodes exist nowhere else.
		expect(SRC).toMatch(/exit\(1 if fail else 0\)/);
		expect(SRC).toMatch(/RS_RC=\$\?/);
		expect(SRC).toMatch(/nodes\.\$TS\.json/);   // names the only remaining copy
	});

	it("the abort helper actually stops the script", () => {
		// Behavioural: the same structure with a failing first step must not
		// reach the destructive one.
		const fixture = `
set -u
die() { echo "ABORT — $*" >&2; exit 1; }
echo "backup"
python3 -c 'import sys; sys.exit(1)'
BK_RC=$?
[ "$BK_RC" -eq 0 ] || die "refusing to wipe"
echo "DROPPED EVERYTHING"
`;
		const r = spawnSync("bash", ["-c", fixture], { encoding: "utf8", timeout: 60_000 });
		expect(r.status).not.toBe(0);
		expect(r.stdout).not.toMatch(/DROPPED/);
		expect(r.stderr).toMatch(/refusing to wipe/);
	});

	it("the fixture above is a faithful reduction, not a different script", () => {
		// Guard against this test drifting from the real file: the real script
		// must contain the same three constructs the fixture exercises.
		expect(SRC).toMatch(/die\(\)/);
		expect(SRC).toMatch(/-eq 0 \] \|\| die/);
		expect(SRC).toMatch(/DROP TABLE IF EXISTS/);
	});
});
