// leading-flag-is-not-a-query.test.mjs — an option in the query slot is an error.
//
// WHY THIS EXISTS (measured 2026-10-23)
// kb-search.sh took the first argv token as the query:
//
//     if [ $# -eq 0 ]; then usage; exit 2; fi
//     Q="$1"
//     shift
//     while [ $# -gt 0 ]; do case "$1" in ... *) unknown option; exit 2 ;; esac; done
//
// So `kb-search --zzz-bogus` set Q to the flag, shifted it away, and left the
// option loop with NOTHING to reject. The unknown-option guard was unreachable
// for that position and the command exited 0 having searched for a typo:
//
//     kb-search --zzz-bogus   -> exit 0, results for "--zzz-bogus"
//     kb-search --scope x     -> exit 2 complaining about "x", never about the
//                                missing query
//
// The script's own comment calls out this exact failure class ("the pre-change
// `*) shift ;;` swallowed them silently, which turned `verify --deeph` into a
// plain `verify` here too") — the guard existed and simply could not see the
// first token.
//
// Also fixed here: `ingest-email --zzz-bogus` ran the ingest and exited 0.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const KB = join(REPO, "bin", "kb-search.sh");

function kb(args) {
	const r = spawnSync("bash", [KB, ...args], { encoding: "utf8", timeout: 120_000 });
	return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

describe("an option in the query slot is refused, not searched for", () => {
	it("refuses a bare unknown flag instead of treating it as the query", () => {
		const r = kb(["--zzz-bogus"]);
		expect(r.status, `exit ${r.status}`).not.toBe(0);
		expect(r.out).toMatch(/missing query|unknown option/);
	});

	it("names the real problem when the query is missing, not the flag's value", () => {
		// The old behaviour complained about "x" — the value of a flag whose
		// command had no query at all.
		const r = kb(["--scope", "x"]);
		expect(r.status).not.toBe(0);
		expect(r.out).toMatch(/missing query/i);
	});

	it("refuses -n with no query", () => {
		const r = kb(["-n", "3"]);
		expect(r.status).not.toBe(0);
		expect(r.out).toMatch(/missing query/i);
	});

	it("still accepts a real query", () => {
		const r = kb(["vector snapshot warm readiness", "-n", "1"]);
		expect(r.status, `exit ${r.status}: ${r.out.slice(0, 200)}`).toBe(0);
	});

	it("supports -- so a query may start with a dash", () => {
		// Without an escape hatch, rejecting leading flags would make it
		// impossible to search for a term like "-Werror".
		const r = kb(["--", "-Werror flag"]);
		expect(r.status, `exit ${r.status}: ${r.out.slice(0, 200)}`).toBe(0);
	});

	it("the guard runs BEFORE the token is consumed as the query", () => {
		// Strip comments first. My first version matched 'Q="$1"' inside the
		// explanatory comment that describes this very bug, so it compared the
		// guard against a line that does not execute — a source-text assertion
		// that would pass no matter where the real assignment sat.
		const src = readFileSync(KB, "utf8")
			.split("\n")
			.map((l) => l.replace(/(^|\s)#.*$/, ""))
			.join("\n");
		const guard = src.indexOf("looks like an option");
		const assign = src.indexOf('Q="$1"');
		expect(guard).toBeGreaterThan(-1);
		expect(assign).toBeGreaterThan(-1);
		// Ordering is the fix: a guard placed after the assignment cannot fire.
		expect(guard).toBeLessThan(assign);
	});

	it("ingest-email refuses an unknown flag instead of running anyway", () => {
		const CLI = join(REPO, "bin", "heimdall.js");
		const r = spawnSync(process.execPath, [CLI, "ingest-email", "--zzz-bogus"], { encoding: "utf8", timeout: 120_000 });
		expect(r.status).not.toBe(0);
		expect((r.stdout || "") + (r.stderr || "")).toContain("--zzz-bogus");
	});
});
