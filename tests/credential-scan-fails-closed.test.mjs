// credential-scan-fails-closed.test.mjs — a leak scanner must not pass blind.
//
// WHY THIS EXISTS (measured 2026-10-23)
// `heimdall credentials` scans ~/.heimdall/global.db for card paths that look like
// credentials. Its three existing suites (credential-exclusion, predicate-parity,
// unknown-flag-rejected) all pass against a FAIL-OPEN build: wrapping the open in
// a try/catch that reports "0" and exits 0 when the store cannot be read leaves
// every one of them green (4/4, 2/2, 7/7).
//
// That matters more here than elsewhere: exit 0 with a count of 0 is exactly what
// CI reads as "no leaked credentials". A scanner that cannot read its input and
// says "clean" is worse than one that crashes, because nothing looks wrong.
//
// The behaviour was already correct — DatabaseSync throws and the CLI exits 1 with
// the reason on stderr. It was simply unpinned, and the neighbouring suites give
// no hint that they would not notice. This pins it, plus the boundary that a
// MISSING store is a fresh install (0 leaks, exit 0) rather than a failure.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "bin", "heimdall.js");

function sandbox(kind, paths = []) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-cred-"));
	mkdirSync(join(home, ".heimdall"), { recursive: true });
	mkdirSync(join(home, ".graft", "profiles", "default"), { recursive: true });
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	const db = join(home, ".heimdall", "global.db");
	if (kind === "corrupt") {
		writeFileSync(db, "this is not a database");
	} else if (kind === "valid") {
		const r = spawnSync(process.execPath, ["-e", `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE cards (path TEXT)");
const ins = db.prepare("INSERT INTO cards VALUES (?)");
for (const p of JSON.parse(process.argv[2])) ins.run(p);
db.close();
`, db, JSON.stringify(paths)], { encoding: "utf8", timeout: 60_000 });
		if (r.status !== 0) throw new Error(`fixture db failed: ${r.stderr}`);
	}
	return home;
}

function creds(home, ...flags) {
	const r = spawnSync(process.execPath, [CLI, "credentials", ...flags], {
		encoding: "utf8", timeout: 120_000,
		env: { ...process.env, HOME: home },
	});
	return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe("credentials: an unreadable store is a failure, never a clean bill", () => {
	it("exits nonzero when the store is corrupt", () => {
		const r = creds(sandbox("corrupt"), "--count");
		// The fail-open shape printed "0" and exited 0 — indistinguishable from
		// "no leaks found", which is the one answer that must never be guessed.
		expect(r.status, `exit 0 on a corrupt store; stdout=${r.out}`).not.toBe(0);
	});

	it("does not report a count of 0 for a store it could not read", () => {
		const r = creds(sandbox("corrupt"), "--count");
		expect(r.out).not.toBe("0");
	});

	it("says why it failed, on stderr", () => {
		const r = creds(sandbox("corrupt"), "--count");
		expect(r.err.length, "a blind scanner must not fail silently").toBeGreaterThan(0);
	});

	it("still reports a real leak in a healthy store", () => {
		// The fix must not make the scanner refuse everything.
		const r = creds(sandbox("valid", ["/Users/x/.ssh/id_rsa", "/Users/x/notes.md"]), "--count");
		expect(r.status).toBe(0);
		expect(r.out).toBe("1");
	});

	it("treats a missing store as a fresh install", () => {
		// No global.db yet: nothing is indexed, so 0 leaks and exit 0 is correct.
		// Collapsing missing into corrupt would break every new install.
		const r = creds(sandbox("absent"), "--count");
		expect(r.status).toBe(0);
		expect(r.out).toBe("0");
	});
});
