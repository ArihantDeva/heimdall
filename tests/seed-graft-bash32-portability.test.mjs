// seed-graft-bash32-portability.test.mjs — seed-graft must RUN on macOS bash 3.2.
//
// WHY THIS EXISTS (measured 2026-10-23)
// seed-graft.sh captured a node before deleting it with what reads like a plain
// array append:
//
//     saved_titles=("${saved_titles[@]}" "$title")
//
// Under `set -u`, expanding an EMPTY array is an unbound-variable error in bash
// 3.2 — the bash macOS ships at /bin/bash and what `#!/usr/bin/env bash`
// resolves to for every Mac user. Measured on this machine (GNU bash 3.2.57):
//
//     bin/seed-graft.sh: line 58: saved_titles[@]: unbound variable
//
// on EVERY run, before touching the graph, so re-seeding was completely broken
// on macOS. CI's Linux leg runs bash 5, where the same line is legal, so it was
// green throughout. Nothing caught it because no test executed the real script.
//
// `+=` is the portable append. These tests run the REAL script under BOTH an
// available bash 5 and the system bash, so a regression to the old form fails
// here rather than on a user's Mac.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "seed-graft.sh");
const PY = plainPython();

// The system bash, which is 3.2 on macOS. On Linux CI this is bash 5 and the
// test still passes — the portability contract is "works on the bash present".
const SYSTEM_BASH = "/bin/bash";

// A bash 5 if one is installed, so the append form is exercised on both.
function bash5() {
	for (const p of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"]) {
		const r = spawnSync(p, ["-c", "echo $BASH_VERSION"], { encoding: "utf8" });
		if (r.status === 0 && /^5\./.test((r.stdout || "").trim())) return p;
	}
	return null;
}

function fixture({ insertFails = false } = {}) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-bash32-"));
	const prof = join(home, ".graft", "profiles", "default");
	mkdirSync(prof, { recursive: true });
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	const bin = join(home, "stubbin");
	mkdirSync(bin, { recursive: true });

	const r = spawnSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE nodes (id BLOB, title TEXT, body TEXT)")
c.execute("INSERT INTO nodes VALUES (?,?,?)", (b"\\x01", "my file.md \\u2014 purpose here", "ORIGINAL BODY CONTENT"))
c.commit(); c.close()
`, join(prof, "graft.db")], { encoding: "utf8", timeout: 60_000 });
	if (r.status !== 0) throw new Error(`fixture db failed: ${r.stderr}`);

	// Records argv; a delete succeeds, an insert only succeeds when re-inserting
	// the ORIGINAL body (i.e. the rollback), so a failing first insert proves the
	// captured content can be restored.
	// NB: capture $1 BEFORE shift — the first version of this stub shifted first
	// and then matched on "$1", so every branch fell through and the rollback
	// silently never ran.
	writeFileSync(join(bin, "graft"), [
		"#!/bin/bash",
		'hdr="$1"; shift',
		'{ printf "CALL %s" "$hdr"; for a in "$@"; do printf " |%s" "$a"; done; echo; } >> "$HOME/calls.log"',
		'case "$hdr" in',
		"  stats) exit 0 ;;",
		insertFails
			? '  insert) for a in "$@"; do [ "$a" = "ORIGINAL BODY CONTENT" ] && exit 0; done; echo "boom" >&2; exit 1 ;;'
			: "  insert) exit 0 ;;",
		"esac",
		"exit 0",
	].join("\n"));
	chmodSync(join(bin, "graft"), 0o755);

	const file = "my file.md";
	writeFileSync(join(home, file), "x");
	writeFileSync(join(home, "knowledge-base", ".inventory.tsv"), `${file}\tpurpose here\tkw1\n`);
	return { home, log: join(home, "calls.log") };
}

function run(home, bash) {
	const r = spawnSync(bash, [SCRIPT], {
		encoding: "utf8", timeout: 120_000,
		env: { ...process.env, HOME: home, PATH: `${join(home, "stubbin")}:${process.env.PATH}` },
	});
	return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

describe("seed-graft runs on the system bash, not just bash 5", () => {
	it("does not die on an unbound array under set -u", () => {
		const { home } = fixture();
		const r = run(home, SYSTEM_BASH);
		// The exact failure was `saved_titles[@]: unbound variable`.
		expect(r.out).not.toMatch(/unbound variable/);
		expect(r.status, `exit ${r.status}; output:\n${r.out}`).toBe(0);
		expect(r.out).toMatch(/processed 1 entries/);
	});

	it("reaches the delete/insert sequence on the system bash", () => {
		const { home, log } = fixture();
		run(home, SYSTEM_BASH);
		const c = calls(log);
		expect(c.some((l) => l.startsWith("CALL delete")), `calls:\n${c.join("\n")}`).toBe(true);
		expect(c.some((l) => l.startsWith("CALL insert"))).toBe(true);
	});

	it("rolls back the captured body on the system bash", () => {
		// The whole reason the array exists: capture before delete so a failed
		// insert can be undone. If the capture were broken-but-silent, this is
		// what would fail.
		const { home, log } = fixture({ insertFails: true });
		const r = run(home, SYSTEM_BASH);
		const c = calls(log);
		const inserts = c.filter((l) => l.startsWith("CALL insert"));
		expect(inserts.length, `expected a retry after the failed insert; calls:\n${c.join("\n")}`).toBe(2);
		// The second insert must carry the ORIGINAL body, i.e. the restored content.
		expect(inserts[1]).toMatch(/ORIGINAL BODY CONTENT/);
		expect(r.out).toMatch(/restored:/);
	});

	it("behaves identically under bash 5 when one is installed", () => {
		const b5 = bash5();
		if (!b5) return;          // Linux CI and stock images have bash 5 at /bin/bash
		const { home, log } = fixture({ insertFails: true });
		const r = run(home, b5);
		// A failed insert exits 1 by design (fails counter); what matters is that
		// the rollback ran and did not die on the array append.
		expect(r.out).not.toMatch(/unbound variable/);
		expect(r.status).toBe(1);
		const inserts = calls(log).filter((l) => l.startsWith("CALL insert"));
		expect(inserts.length).toBe(2);
		expect(inserts[1]).toMatch(/ORIGINAL BODY CONTENT/);
	});
});
