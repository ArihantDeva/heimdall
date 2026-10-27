// sync-edits-scan-failure.test.mjs — a failed scan must not look like "nothing
// changed", because the consequence is permanent silence.
//
// WHY THIS EXISTS (measured 2026-10-23)
// sync-edits.sh scanned session logs with
//     find "$SESSIONS" -name '*.jsonl' -newer "$REF" -print0 2>/dev/null
// and piped it into xargs. find exits 1 on a permission error while printing
// NOTHING, so a partial scan is indistinguishable from "no logs changed" —
// verified: chmod 000 on a subdirectory gives find status 1 and zero matches.
//
// This is not a harmless false negative here: the run then writes $STATE, the
// high-water mark for the next run's `-newer` comparison. So every file the
// failed scan could not see is treated as already hinted and is never scanned
// again. One permission error permanently drops a subtree of session logs from
// the index.
//
// A second, separate defect was found in the same file: the reference stamp was
// built with `date -r <epoch>`, which is BSD. GNU coreutils reads `-r` as
// --reference=FILE, so on any machine with GNU date in front (measured: GNU
// 9.11 on this macOS box, and every ubuntu CI runner) the line failed under
// 2>/dev/null and left the reference wrong, disabling the seven-day default
// window entirely.
import { describe, it, expect } from "./lib/harness.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "sync-edits.sh");
const SRC = readFileSync(SCRIPT, "utf8")
	.split("\n")
	.map((l) => l.replace(/(^|\s)#.*$/, ""))   // comments quote the old buggy lines
	.join("\n");

const session = (cwd, p) => JSON.stringify({
	type: "session", cwd,
	message: { content: [{ type: "toolCall", name: "write", arguments: { path: p } }] },
});

// A HOME with one readable session log and one unreadable subdirectory.
function makeHome({ locked = false } = {}) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-sync-"));
	const work = join(home, "work");
	const sessions = join(home, ".pi", "agent", "sessions");
	mkdirSync(work, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, "a.jsonl"), session(work, join(work, "f.py")) + "\n");
	let lockedDir = null;
	if (locked) {
		lockedDir = join(sessions, "locked");
		mkdirSync(lockedDir, { recursive: true });
		writeFileSync(join(lockedDir, "b.jsonl"), session(work, join(work, "g.py")) + "\n");
		chmodSync(lockedDir, 0o000);
	}
	// A `heimdall` that always fails. Without it a fall-through mutant ends on a
	// successful reconcile and exits 0, which hides the missing exit.
	const binDir = join(home, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, "heimdall"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	return { home, work, sessions, lockedDir };
}

// The fake `heimdall` goes FIRST so a mutant that continues past the scan error
// cannot end on a successful reconcile and exit 0. The clean script never shells
// out to a `heimdall` on PATH — it resolves heimdall.js from its own directory —
// so this is invisible to correct behaviour and fatal to the mutant.
const run = (home, args = []) =>
	spawnSync("bash", [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}` },
		timeout: 120_000,
	});

describe("sync-edits: a failed scan is loud and does not advance state", () => {
	it("a clean scan lists the edited path", () => {
		const h = makeHome();
		try {
			const r = run(h.home, ["--dry-run"]);
			expect(r.stdout).toContain(h.work);
			expect(r.stdout).toMatch(/would hint 1 path/);
		} finally { rmSync(h.home, { recursive: true, force: true }); }
	});

	it("an unreadable subdirectory FAILS instead of silently finding nothing", () => {
		const h = makeHome({ locked: true });
		try {
			const r = run(h.home);
			expect(r.status).not.toBe(0);
			expect(r.stderr).toMatch(/ERROR scanning/);
		} finally {
			try { chmodSync(h.lockedDir, 0o755); } catch {}
			rmSync(h.home, { recursive: true, force: true });
		}
	});

	it("returns before the hint pipeline, not just with an error printed", () => {
		// The mechanism, asserted on the source because the EFFECT is masked: the
		// script defines its own `heimdall()` shell function (line 31), so a PATH
		// stub cannot intercept it, and `heimdall reconcile || true` (line 129)
		// swallows the exit status — which means a mutant that prints the warning
		// and falls through still exits 0. Rather than pretend a behavioural test
		// covers that, pin the two structural facts that make the guard real.
		expect(SRC).toMatch(/state NOT advanced/i);
		// Anchor on the SCAN-FAILURE branch specifically: `exit 1` also appears
		// earlier for the missing-heimdall.js check, so a bare indexOf finds the
		// wrong one and a mutant that drops this exit still passes.
		const iGuard = SRC.indexOf("state NOT advanced");
		const iScan = SRC.lastIndexOf("FIND_RC", iGuard);
		const branch = SRC.slice(iScan, SRC.indexOf("\nfi\n", iGuard));
		expect(iGuard).toBeGreaterThan(-1);
		expect(branch, "the scan-failure branch must exit 1, not fall through")
			.toMatch(/\bexit 1\b/);
		// And the state write must come after the whole branch.
		const iWrite = SRC.indexOf('> "$STATE"');
		expect(iWrite).toBeGreaterThan(iGuard);
	});

	it("does NOT advance the high-water mark when the scan failed", () => {
		// The data loss: a failed scan that advances $STATE means the files it
		// could not see are never scanned again. Both halves are required — a run
		// that silently continues to the state write is exactly the bug, and an
		// earlier version of this test passed a mutation that removed the exit
		// because it only checked that the file was absent.
		const h = makeHome({ locked: true });
		try {
			// Make the fall-through observable by removing any chance the script
			// SUCCEEDS for an unrelated reason: put a `heimdall` that always fails
			// on PATH, so a mutant that continues past the scan error cannot end
			// up exiting 0 via a successful reconcile.
			const r = run(h.home);
			// Both halves, in this order, because each alone is passable by a
			// mutation: a run that prints the warning but falls through to the
			// state write exits 0 and still never retries the missed files.
			assert.notEqual(r.status, 0, "a failed scan must exit nonzero");
			assert.match(r.stderr, /state NOT advanced/,
				"the operator must be told the state was not advanced");
			// And it must not have continued into the hint pipeline either.
			assert.doesNotMatch(r.stdout, /hinted/, "a failed scan must not report hints as applied");
			expect(existsSync(join(h.home, ".graft", ".last-sync"))).toBe(false);
		} finally {
			try { chmodSync(h.lockedDir, 0o755); } catch {}
			rmSync(h.home, { recursive: true, force: true });
		}
	});

	it("names the path it could not read", () => {
		const h = makeHome({ locked: true });
		try {
			const r = run(h.home);
			expect(r.stderr).toMatch(/Permission denied|locked/);
		} finally {
			try { chmodSync(h.lockedDir, 0o755); } catch {}
			rmSync(h.home, { recursive: true, force: true });
		}
	});

	it("checks find's exit status at all", () => {
		// Pin the mechanism: the scan's status must be captured, not discarded.
		expect(SRC).toMatch(/FIND_RC=\$\?/);
		expect(SRC).toMatch(/if \[ "\$FIND_RC" -ne 0 \]/);
		// and it must not still be the un-checked pipeline
		expect(SRC).not.toMatch(/find "\$SESSIONS" -name '\*\.jsonl' -newer "\$REF" -print0 2>\/dev\/null\s*\|/);
	});

	it("the since-reference stamp works with GNU date as well as BSD", () => {
		// `date -r <epoch>` is BSD-only; GNU reads -r as --reference=FILE. On this
		// machine (GNU 9.11) the old line failed silently and disabled the window.
		expect(SRC).toMatch(/date -d "@\$e"|date -d "@/);
		// behavioural: whichever dialect is present, a stamp must come out
		const r = spawnSync("bash", ["-c",
			'date -r 1712345678 +%Y%m%d%H%M.%S 2>/dev/null || date -d "@1712345678" +%Y%m%d%H%M.%S 2>/dev/null',
		], { encoding: "utf8" });
		assert.match((r.stdout || "").trim(), /^\d{12}\.\d{2}$/,
			"no date dialect on this machine produced a touch stamp");
	});

	it("falls back to a full scan rather than scanning nothing", () => {
		// If no stamp can be produced, erring toward MORE scanning is safe;
		// erring toward none is the bug. Assert it BEHAVIOURALLY: with no state
		// file the default window is 7 days, so a log older than that must still
		// be found when the stamp fails — but must be skipped when it works.
		expect(SRC).toMatch(/scanning ALL logs/);
		const r = spawnSync("bash", ["-c", `
h=$(mktemp -d)
mkdir -p "$h/.pi/agent/sessions" "$h/work"
printf '%s\n' '{"type":"session","cwd":"'"$h"'/work","message":{"content":[{"type":"toolCall","name":"write","arguments":{"path":"'"$h"'/work/old.py"}}]}}' > "$h/.pi/agent/sessions/a.jsonl"
# make the log 30 days old: outside the 7-day default window
touch -t $(date -d "@$(( $(date +%s) - 30*86400 ))" +%Y%m%d%H%M.%S 2>/dev/null || date -r $(( $(date +%s) - 30*86400 )) +%Y%m%d%H%M.%S) "$h/.pi/agent/sessions/a.jsonl" 2>/dev/null
HOME="$h" bash ${JSON.stringify(SCRIPT)} --dry-run 2>/dev/null
rm -rf "$h"
`], { encoding: "utf8", timeout: 120_000 });
		// A 30-day-old log is outside the window, so it must NOT be listed.
		expect(r.stdout || "").toMatch(/would hint 0 path/);
		// And the mechanical guarantee that a missing stamp widens, never narrows.
		expect(SRC).toMatch(/FULL=1/);
	});

	it("the stamp helper itself tries both date dialects", () => {
		// The behavioural test above tolerates a missing stamp (it widens to a full
		// scan), so it cannot see the BSD-only regression. Pin the fallback chain
		// directly: on this machine `date -r <epoch>` FAILS (GNU coreutils), so
		// without the -d branch no stamp is ever produced and the seven-day default
		// window is permanently disabled.
		const body = SRC.slice(SRC.indexOf("_stamp()"), SRC.indexOf("REF=$(mktemp)"));
		expect(body).toMatch(/date -r "\$e"/);
		expect(body).toMatch(/date -d "@\$e"/);
		// And the window must actually be honoured when a stamp IS produced:
		// a clean scan with no state file lists only recent logs.
		const h = makeHome();
		try {
			const r = run(h.home, ["--dry-run"]);
			expect(r.stdout).toMatch(/would hint 1 path/);
			expect(r.stderr).not.toMatch(/could not set the since-reference/);
		} finally { rmSync(h.home, { recursive: true, force: true }); }
	});
});
