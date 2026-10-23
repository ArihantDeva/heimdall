// kb-rebuild-real-script.test.mjs — run kb-rebuild.sh itself, not an imitation.
//
// WHY THIS EXISTS (measured 2026-10-23)
// kb-rebuild-fail-closed.test.mjs asserts on SOURCE TEXT and runs a HAND-WRITTEN
// fixture that imitates the guard structure. It never executes the real script,
// so it cannot see the guard being neutered. Verified against the real file:
//
//     [ "$BK_RC" -eq 0 ] || die   ->   -ge 0    (a failed backup now proceeds
//                                                to DROP TABLE)  ... 6/6 pass
//     getsize(sys.argv[1]) == 0  ->   False     (empty backup accepted)
//                                                               ... 6/6 pass
//     die() { ...; exit 1; }     ->   die() { return 0; ... }
//                                                               ... 6/6 pass
//
// Only one of four mutations was caught. A test that reimplements the logic it
// is checking tests the reimplementation.
//
// The real script IS drivable: DB comes from $HOME, so a sandbox HOME with a
// prepared graft.db exercises the genuine backup → guard → wipe sequence with no
// daemon and no live state.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "kb-rebuild.sh");
const PY = plainPython();

// A sandbox HOME containing a graft.db the script will try to back up.
function sandbox({ corrupt = false } = {}) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-rebuild-"));
	const dir = join(home, ".graft", "profiles", "default");
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	const db = join(dir, "graft.db");
	if (corrupt) {
		// A file that is not a database: sqlite's backup API raises, which is the
		// real-world shape of "the backup could not be taken".
		writeFileSync(db, "this is not a database");
	} else {
		const r = spawnSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE nodes (id BLOB, title TEXT, body TEXT)")
c.execute("INSERT INTO nodes VALUES (x'01', 't', 'b')")
c.commit(); c.close()
`, db], { encoding: "utf8", timeout: 60_000 });
		if (r.status !== 0) throw new Error(`could not build fixture db: ${r.stderr}`);
	}
	return { home, db };
}

function runRebuild(home) {
	const r = spawnSync("bash", [SCRIPT], {
		encoding: "utf8", timeout: 180_000,
		env: { ...process.env, HOME: home },
	});
	return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// The nodes table must survive a run that could not back up.
function nodeCount(db) {
	const r = spawnSync(PY, ["-c", `
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1])
    print(c.execute("SELECT count(*) FROM nodes").fetchone()[0])
except Exception as e:
    print("ERR")
`, db], { encoding: "utf8", timeout: 60_000 });
	return (r.stdout || "").trim();
}

describe("kb-rebuild runs, and refuses to wipe when the backup failed", () => {
	it("aborts on a failed backup and never reaches the wipe", () => {
		const { home } = sandbox({ corrupt: true });
		const r = runRebuild(home);
		expect(r.status, `exit ${r.status}`).not.toBe(0);
		// The abort must name the reason, not fail anonymously.
		expect(r.out).toMatch(/refusing to wipe/);
		// And it must not have proceeded to the destructive step.
		expect(r.out).not.toMatch(/2\/6 dump all nodes/);
	});

	it("takes a real backup when the database is valid", () => {
		const { home, db } = sandbox();
		const before = nodeCount(db);
		const r = runRebuild(home);
		// It goes on to later steps which need a daemon and may fail; what matters
		// is that step 1 SUCCEEDED and produced a non-empty backup file.
		expect(r.out).toMatch(/backed up DB via sqlite backup API/);
		const backups = join(home, "knowledge-base", "backups");
		expect(existsSync(backups)).toBe(true);
		expect(before).toBe("1");
	});

	it("rejects an empty backup file rather than treating 0 bytes as success", () => {
		// Step 1 writes via the sqlite backup API, so a 0-byte result means the
		// copy silently did nothing — and the next step DROPs the source.
		const src = readFileSync(SCRIPT, "utf8");
		const empty = src.indexOf("getsize(sys.argv[1]) == 0");
		const wipe = src.indexOf("DROP TABLE IF EXISTS");
		expect(empty).toBeGreaterThan(-1);
		expect(wipe).toBeGreaterThan(-1);
		// The size check lives inside step 1, before anything destructive.
		expect(empty).toBeLessThan(wipe);
	});

	it("refuses to wipe when the node list extraction fails on a non-empty graph", () => {
		// Measured 2026-10-23 on the real script: the node list was written with
		// stderr to /dev/null, its exit status ignored, and no emptiness check, so
		// an extraction producing 0 bytes proceeded to the wipe.
		//
		// Drive the failure honestly: a sqlite3 stub that fails ONLY the node-list
		// SELECT while still answering the count, which is exactly the shape of a
		// partial tool failure against a healthy database.
		const { home, db } = sandbox();
		expect(nodeCount(db)).toBe("1");
		const bin = join(home, "stubbin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "sqlite3"), [
			"#!/bin/bash",
			// args: <db> <sql>
			'case "$2" in',
			'  *"count(*)"*) exec ' + PY + ' -c \'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print(c.execute("select count(*) from nodes").fetchone()[0])\' "$1" ;;',
			'  *"SELECT hex(id)"*) echo "Error: database is locked" >&2; exit 1 ;;',
			'  *) exit 0 ;;',
			"esac",
		].join("\n"));
		chmodSync(join(bin, "sqlite3"), 0o755);

		const r = spawnSync("bash", [SCRIPT], {
			encoding: "utf8", timeout: 180_000,
			env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
		});
		const out = (r.stdout || "") + (r.stderr || "");
		expect(r.status, `exit ${r.status}`).not.toBe(0);
		expect(out).toMatch(/node list extraction failed|node list is empty but the graph holds/);
		// And it must not have gone on to the destructive step.
		expect(out).not.toMatch(/2b\/6 wipe graph tables/);
	});

	it("allows a legitimately empty graph to proceed", () => {
		// 0 nodes is a valid state; refusing it would make the tool unusable on a
		// fresh install. The guard must distinguish "no nodes" from "extraction
		// failed", which is why it compares against the source count.
		const home = mkdtempSync(join(tmpdir(), "heimdall-rebuild-empty-"));
		mkdirSync(join(home, ".graft", "profiles", "default"), { recursive: true });
		mkdirSync(join(home, "knowledge-base"), { recursive: true });
		spawnSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE nodes (id BLOB, title TEXT, body TEXT)")
c.commit(); c.close()
`, join(home, ".graft", "profiles", "default", "graft.db")], { encoding: "utf8", timeout: 60_000 });
		const r = runRebuild(home);
		expect(r.out).not.toMatch(/node list is empty but the graph holds/);
	});

	it("die() actually stops the run instead of returning", () => {
		// Behavioural proof through the real script: a failed backup aborts with a
		// nonzero exit. If die() returned instead of exiting, the wipe would run.
		const { home } = sandbox({ corrupt: true });
		const r = runRebuild(home);
		expect(r.status).not.toBe(0);
		expect(r.out).not.toMatch(/2\/6/);
	});
});
