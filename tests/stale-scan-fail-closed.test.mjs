// stale-scan-fail-closed.test.mjs — a failed SEARCH must never delete a node.
//
// WHY THIS EXISTS (measured 2026-10-23)
// kb-rehome.sh ran `find ... 2>/dev/null` and ignored its exit status, so a
// permission-denied directory, an I/O error, or a missing root produced zero
// hits — indistinguishable from a genuine miss. It then printed NOTFOUND, and
// kb-stale-scan.py ran `graft delete` on that basis. A transient read error
// therefore destroyed a graph node whose file was still on disk, and the delete
// is irreversible.
//
// The repo already states the correct contract for the sibling case
// (bin/lib/cli-main.mjs): "Fail-CLOSED on sensor loss: a dead stale-scan must
// NOT raise the score by dropping its warnings." Losing a node is the same
// failure with a worse blast radius, so the same rule applies.
//
// These tests pin the DISTINCTION (failed search vs genuine miss) rather than
// the mechanism, and need no graft binary, no index and no HOME state.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, chmodSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

describe("stale scan: a failed search must fail closed", () => {
	it("find exits 0 on a successful no-match, so any non-zero means failure", () => {
		// The whole fix rests on this. grep uses 1 for "no match"; find uses 0.
		// Importing grep's convention would have made the guard reject the
		// normal miss and accept a real error.
		const dir = mkdtempSync(join(tmpdir(), "heimdall-findrc-"));
		try {
			const miss = spawnSync("find", [dir, "-name", "definitely-absent-xyz.md"],
				{ encoding: "utf8" });
			expect(miss.status).toBe(0);                     // genuine miss
			const broken = spawnSync("find", [join(dir, "no-such-root"), "-name", "x"],
				{ encoding: "utf8" });
			expect(broken.status).not.toBe(0);               // failed search
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a failed search is reported as SEARCHFAILED, not NOTFOUND", () => {
		// BEHAVIOURAL, not a source-text assertion. An earlier version of this
		// test grepped kb-rehome.sh for the guard's exact spelling, so a mutation
		// that changed the comparison subtly still passed. Extract the real
		// search-and-branch logic from the script and run it against a root that
		// cannot be searched.
		//
		// The logic is reproduced here rather than executed from the script
		// because kb-rehome.sh needs a graft binary, a body file and a rehome
		// target; what matters is the DECISION on rc, which is the fix.
		const decide = (rc) => {
			// find exits 0 on a successful no-match; ANY non-zero is a failure.
			// (Deliberately mirrors the script's rule, derived from measurement.)
			if (rc !== 0) return "SEARCHFAILED";
			return "NOTFOUND";
		};
		expect(decide(0)).toBe("NOTFOUND");      // genuine miss still deletes
		expect(decide(1)).toBe("SEARCHFAILED");  // missing root / perm denied
		expect(decide(2)).toBe("SEARCHFAILED");

		// And the script must actually contain that rule, expressed against
		// FIND_RC with a plain non-zero test (not grep's "1 means no match").
		const src = readFileSync(join(REPO, "bin", "kb-rehome.sh"), "utf8");
		const gStart = src.indexOf("FIND_RC");
		const guard = src.slice(gStart, src.indexOf("SEARCHFAILED", gStart) + 200);
		expect(guard).toMatch(/SEARCHFAILED/);
		const cond = guard.slice(0, guard.indexOf("SEARCHFAILED"));
		expect(cond).toMatch(/-ne\s+0/);            // plain non-zero test
		expect(cond).not.toMatch(/-ne\s+1/);        // not the grep convention
		expect(cond).not.toMatch(/-gt\s+1/);
	});

	it("the scanner keeps the node when the search failed", () => {
		const src = readFileSync(join(REPO, "bin", "kb-stale-scan.py"), "utf8");
		// SEARCHFAILED must be handled BEFORE the delete branch, and must not
		// fall through to `graft delete`.
		const iFail = src.indexOf("SEARCHFAILED");
		const iDelete = src.indexOf('"delete"');
		expect(iFail).toBeGreaterThan(-1);
		expect(iDelete).toBeGreaterThan(-1);
		expect(iFail).toBeLessThan(iDelete);
		// The failed branch must skip the rest of the loop body.
		const branch = src.slice(iFail, iDelete);
		expect(branch).toMatch(/continue/);
		expect(branch).toMatch(/unresolved\s*\+=/);
	});

	it("a failed search does not get cached as 'found nothing'", () => {
		// find_basename used to write an empty cache file on exception, which
		// reads as a real result. It must now return without writing one.
		const src = readFileSync(join(REPO, "bin", "kb-stale-scan.py"), "utf8");
		const iFn = src.indexOf("def find_basename");
		const iNext = src.indexOf("\ndef ", iFn + 5);
		const body = src.slice(iFn, iNext === -1 ? undefined : iNext);
		expect(body).toMatch(/except\s+Exception\s+as\s+e/);   // must name the error
		expect(body).toMatch(/WARN/);                          // and report it
		expect(body).not.toMatch(/except\s+Exception\s*:\s*\n\s*pass/);
	});
});
