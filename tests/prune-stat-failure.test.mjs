// prune-stat-failure.test.mjs — a failed stat() must never prune a live file.
//
// WHY THIS EXISTS (measured 2026-10-23)
// The build walk did:
//     try: st = p.stat()
//     except OSError: continue
// `seen.add(cid)` is what tells _prune_stale "this file still exists". Skipping
// it put a LIVE file into the vanished list, and the tail prune ran
// DELETE FROM cards / DELETE FROM vec. A stat() failure does not mean absence:
// ELOOP (symlink loop), EACCES on a parent, EIO, or a TOCTOU recreate all land
// in that branch. This is the same class as the failed-find prune and the
// unreadable-dimension DROP found the same day: a destructive action gated on
// a signal that cannot distinguish "absent" from "could not tell".
import { describe, it, expect } from "./lib/harness.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(join(REPO, "bin", "embed-index.py"), "utf8");

const fnBody = (name) => {
	const i = SRC.indexOf(`def ${name}(`);
	if (i < 0) return "";
	const j = SRC.indexOf("\ndef ", i + 5);
	return SRC.slice(i, j === -1 ? undefined : j);
};

describe("prune: a failed stat must not be read as a deletion", () => {
	it("the stat() failure branch adds the card to `seen` (keeps it)", () => {
		const loop = fnBody("_build_inner");
		expect(loop.length).toBeGreaterThan(0);
		// Locate the stat() try/except inside the walk.
		const iStat = loop.indexOf("st = p.stat()");
		expect(iStat).toBeGreaterThan(-1);
		// Scope the check to THIS except block only. An earlier version widened it
		// to 900 characters, which reaches the unrelated seen.add() further down
		// the loop — so reverting to `except OSError: continue` still passed.
		const iExcept = loop.indexOf("except OSError", iStat);
		expect(iExcept).toBeGreaterThan(iStat);
		// the block ends at the next dedent to column 8
		const after = loop.slice(iExcept + "except OSError".length);
		const endRel = after.search(/\n {8}\S/);
		const block = endRel < 0 ? after : after.slice(0, endRel);
		expect(block.length).toBeGreaterThan(0);
		expect(loop.slice(iExcept, iExcept + 20)).toMatch(/except OSError as e/);
		// Strip comments before asserting. Two mutations hid behind prose: the
		// block's own explanatory comment contains the words "seen.add(cid)" and
		// "continue", so a text match survived deleting the real statement.
		const code = block.split("\n")
			.map((l) => l.replace(/#.*$/, ""))
			.join("\n");
		expect(code).toMatch(/seen\.add\(cid\)/);       // real statement, not prose
		expect(code).toMatch(/stat_failures\.append/);   // and reported
	});

	it("the prune still deletes genuinely absent files", () => {
		// Guard against over-correcting: making everything survive would turn
		// the pruner into dead code and grow the index forever.
		const prune = fnBody("_prune_stale");
		expect(prune).toMatch(/DELETE FROM cards/);
		expect(prune).toMatch(/if cid not in seen/);
	});

	it("stat failures are reported, not silently absorbed", () => {
		const loop = fnBody("_build_inner");
		expect(loop).toMatch(/WARN .*could not be stat/);
		expect(loop).toMatch(/were KEPT \(not pruned\)/);
	});

	it("dataless files are still added to seen unconditionally", () => {
		// The other walk branch was already correct; a regression here would
		// prune every iCloud placeholder.
		const loop = fnBody("_build_inner");
		const iDat = loop.indexOf("for p in dataless:");
		expect(iDat).toBeGreaterThan(-1);
		const region = loop.slice(iDat, iDat + 400);
		expect(region).toMatch(/seen\.add\(cid\)/);
	});
});
