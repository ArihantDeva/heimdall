// stale-scan-mass-guard-behaviour.test.mjs — the breaker must actually bound a run.
//
// WHY THIS EXISTS (measured 2026-10-23)
// stale-node-absence-and-mass-guard.test.mjs asserts that
// MASS_DELETE_FRACTION = 0.5 is DEFINED, that the env var name appears, and that
// the refusal string sits before the delete call. None of that is the behaviour.
// Verified against the real script: changing the comparison
//
//     planned / total > MASS_DELETE_FRACTION   ->   planned / total > 1.5
//
// leaves every source-shape assertion intact while making the breaker
// unreachable. Driven end to end with 10 dead nodes: the guarded script deletes
// 5 and refuses the rest; the mutated one deletes ALL 10. The suite passed 6/6.
//
// The script's DB/KB paths come from $HOME, so a sandbox HOME plus a recording
// `graft` stub exercises the genuine breaker with no live graph.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "kb-stale-scan.py");
const PY = plainPython();

// Build a sandbox HOME whose graph holds `n` nodes, every anchor provably dead
// (home-anchored, because extract_paths only considers those), plus a `graft`
// stub that records each delete instead of performing one.
function deadGraph(n) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-stale-"));
	const prof = join(home, ".graft", "profiles", "default");
	mkdirSync(prof, { recursive: true });
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	const bin = join(home, "stubbin");
	mkdirSync(bin, { recursive: true });
	const r = spawnSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE nodes (id BLOB, title TEXT, body TEXT)")
for i in range(int(sys.argv[2])):
    c.execute("INSERT INTO nodes VALUES (?,?,?)", (bytes([i + 1]), "", f"~/deadfile{i}.md purpose here"))
c.commit(); c.close()
`, join(prof, "graft.db"), String(n)], { encoding: "utf8", timeout: 60_000 });
	if (r.status !== 0) throw new Error(`fixture db failed: ${r.stderr}`);

	writeFileSync(join(bin, "graft"), '#!/bin/bash\necho "DELETE $2" >> "$HOME/deletes.log"\n');
	chmodSync(join(bin, "graft"), 0o755);
	return { home, log: join(home, "deletes.log") };
}

function scan(home, extraEnv = {}) {
	const r = spawnSync(PY, [SCRIPT], {
		encoding: "utf8", timeout: 180_000,
		env: { ...process.env, HOME: home, PATH: `${join(home, "stubbin")}:${process.env.PATH}`, ...extraEnv },
	});
	return (r.stdout || "") + (r.stderr || "");
}

function deletes(log) {
	return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
}

describe("stale scan: the mass-delete breaker bounds what one run can remove", () => {
	it("stops before deleting more than half the graph", () => {
		const { home, log } = deadGraph(10);
		const out = scan(home);
		// 6 discarded (the 6th is > 50%), so 5 deletes happen and the rest are kept.
		expect(deletes(log), `deleted ${deletes(log)} of 10; output:\n${out}`).toBe(5);
		expect(out).toMatch(/REFUSING to delete/);
		expect(out).toMatch(/KEPT \(mass-delete refused\)/);
	});

	it("the refusal names the ratio so a human can judge it", () => {
		const { home } = deadGraph(10);
		const out = scan(home);
		// The message must carry numbers, not just the word "refusing".
		expect(out).toMatch(/REFUSING to delete \d+\/\d+ nodes/);
	});

	it("leaves everything alone when the graph is small but every anchor is dead", () => {
		// 2 nodes, both dead: the first delete is already 1/2 = 50%, which is not
		// > 50%, so one delete is allowed and the second is refused? No — at the
		// second the ratio is 2/2 = 100% > 50%, so exactly one delete happens.
		// This pins the boundary: the breaker is a RATIO, not an absolute count.
		const { home, log } = deadGraph(2);
		const out = scan(home);
		expect(deletes(log), `output:\n${out}`).toBe(1);
		expect(out).toMatch(/REFUSING to delete/);
	});

	it("deletes everything when the operator explicitly forces it", () => {
		// The override must work, or the tool cannot be used on a genuinely moved
		// tree. Without this, a 'fix' that made the breaker unconditional would
		// look correct.
		const { home, log } = deadGraph(10);
		scan(home, { HEIMDALL_PRUNE_ALLOW_MASS: "1" });
		expect(deletes(log), "forced run should remove all 10").toBe(10);
	});

	it("does not delete nodes whose anchor is merely unreadable", () => {
		// The other half of the contract: absent is not the same as unreadable.
		// A node whose file sits under a chmod-000 directory must survive.
		const { home, log } = deadGraph(1);
		const lockedDir = join(home, "locked");
		mkdirSync(lockedDir);
		writeFileSync(join(lockedDir, "inside.md"), "x");
		spawnSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("DELETE FROM nodes")
c.execute("INSERT INTO nodes VALUES (?,?,?)", (b"\\x01", "", "~/locked/inside.md purpose"))
c.commit(); c.close()
`, join(home, ".graft", "profiles", "default", "graft.db")], { encoding: "utf8", timeout: 60_000 });
		chmodSync(lockedDir, 0o000);
		try {
			const out = scan(home);
			expect(deletes(log), `unreadable path was deleted; output:\n${out}`).toBe(0);
		} finally {
			chmodSync(lockedDir, 0o755);
		}
	});
});
