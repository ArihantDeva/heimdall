// verify-sees-destroyed-graph.test.mjs — the integrity checker must not report
// "no drift" about a store it cannot read.
//
// WHY THIS EXISTS (measured 2026-10-23)
// `heimdall verify` audits the JOURNAL and never opens graft.db, so its node and
// edge counts describe what the journal believes, not whether the graph can still
// answer a query. With graft.db overwritten by garbage:
//
//     $ heimdall verify
//     ok: 0 paths, 0 nodes, 0 edges, 0 pending, 0 queued — no drift     (exit 0)
//     $ heimdall verify --json
//     { "ok": true, "drift": [], "stats": { "nodes": 0, "edges": 0, ... } }
//
// Any health automation watching verify saw green through total data loss. The
// same blindness hid a graph holding 5 nodes behind an empty journal.
//
// The three states are genuinely different and must stay distinguishable:
//   absent  -> fresh install, legitimately empty, NOT an error
//   corrupt -> store destroyed; retrieval silently returns nothing
//   present -> validate by state, as before
//
// The probe reads SQLite's 16-byte file magic, so no driver dependency and no SQL
// parsing is involved.
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

function sandbox(kind) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-verify-"));
	const prof = join(home, ".graft", "profiles", "default");
	mkdirSync(prof, { recursive: true });
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	const db = join(prof, "graft.db");
	if (kind === "valid") {
		const r = spawnSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE nodes (id BLOB, title TEXT, body TEXT)")
c.commit(); c.close()
`, db], { encoding: "utf8", timeout: 60_000 });
		if (r.status !== 0) throw new Error(r.stderr);
	} else if (kind === "corrupt") {
		writeFileSync(db, "this is definitely not a sqlite database");
	} else if (kind === "truncated") {
		writeFileSync(db, "SQLite format 3\u0000");   // right magic, no content
	}
	return home;
}

function verify(home, ...flags) {
	const r = spawnSync(process.execPath, [CLI, "verify", ...flags], {
		encoding: "utf8", timeout: 180_000,
		env: { ...process.env, HOME: home },
	});
	return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}

describe("verify: a destroyed graph store is not 'no drift'", () => {
	it("fails and says so when the graph store is corrupt", () => {
		const r = verify(sandbox("corrupt"));
		expect(r.status, "verify exited 0 on a corrupt graph store").not.toBe(0);
		expect(r.out).toMatch(/GRAPH STORE CORRUPT/);
	});

	it("does not claim 'no drift' unqualified when the store is corrupt", () => {
		// The old line was "ok: ... — no drift", which is what dashboards grep.
		const r = verify(sandbox("corrupt"));
		expect(r.out).not.toMatch(/^ok: /m);
	});

	it("reports ok:false and graph:corrupt in --json", () => {
		const r = verify(sandbox("corrupt"), "--json");
		const j = JSON.parse(r.stdout);
		expect(j.ok).toBe(false);
		expect(j.graph.state).toBe("corrupt");
		// The journal is genuinely intact — the report must not pretend otherwise.
		expect(j.stats).toBeTruthy();
	});

	it("treats a MISSING store as a fresh install, not a failure", () => {
		// A new install has no graft.db. Refusing it would make the tool unusable,
		// so absent must stay distinct from corrupt.
		const r = verify(sandbox("absent"), "--json");
		const j = JSON.parse(r.stdout);
		expect(j.graph.state).toBe("absent");
		expect(j.ok).toBe(true);
		expect(r.status).toBe(0);
	});

	it("still passes a healthy store", () => {
		const r = verify(sandbox("valid"), "--json");
		const j = JSON.parse(r.stdout);
		expect(j.graph.state).toBe("present");
		expect(j.ok).toBe(true);
		expect(r.status).toBe(0);
	});

	it("flags a file that has the magic but no content as corrupt", () => {
		// Header-only is not a usable database. A magic-only check would pass it,
		// so the probe also enforces sqlite's 512-byte minimum page.
		const r = verify(sandbox("truncated"), "--json");
		const j = JSON.parse(r.stdout);
		expect(j.graph.state).toBe("corrupt");
		expect(j.ok).toBe(false);
		expect(r.status).not.toBe(0);
	});
});
