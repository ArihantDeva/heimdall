// unknown-flag-rejected.test.mjs — a typo'd flag must not act like the real one.
//
// WHY THIS EXISTS (measured 2026-10-23)
// cli-main.mjs already has checkFlags(), written for exactly this reason — its
// own comment says silent acceptance "turned `verify --deeph` into a plain
// `verify` — the user thinks deep audit ran." But only 6 of 20 subcommands
// called it. Measured on the rest:
//
//     init --bogus-typo        exit 0   "ok: config already present"   ← MUTATED
//     daemon --bogus-typo      exit 0   "another writer holds the lock"
//     credentials --bogus-typo exit 0   printed a full report
//
// init is the dangerous one: it writes config and installs adapters, so a
// typo'd flag did not stop the mutation — it silently performed it. And
// `daemon --dry-runn` (one letter short) would have started a REAL reconciler
// while the operator believed they had asked for a rehearsal.
//
// The daemon's own parseArgs had no else branch at all, so unknown flags fell on
// the floor there independently of checkFlags.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "bin", "heimdall.js");

function run(args, timeout = 90_000) {
	const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout });
	return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

describe("a flag the command does not know is refused, not ignored", () => {
	// Each entry: the command, a typo, and why the typo is dangerous.
	const cases = [
		["init", "--bogus-typo", "init writes config and installs adapters"],
		["daemon", "--bogus-typo", "daemon starts a real reconciler"],
		["credentials", "--bogus-typo", "exit 0 implies the filter was applied"],
	];

	for (const [cmd, typo, why] of cases) {
		it(`${cmd}: refuses ${typo} with a nonzero exit (${why})`, () => {
			const r = run([cmd, typo]);
			expect(r.status, `exit ${r.status}: ${r.out.slice(0, 300)}`).not.toBe(0);
			// Name the offending flag so the user can see the typo.
			expect(r.out).toContain(typo);
		});
	}

	it("init does not mutate when given a typo'd flag", () => {
		// The core danger: proceeding with the work anyway. A refusal that still
		// writes config would be worse than silence.
		const r = run(["init", "--bogus-typo"]);
		expect(r.status).not.toBe(0);
		expect(r.out).not.toMatch(/config already present|harness set to/);
	});

	it("a one-letter-short --dry-run is not treated as a real --dry-run", () => {
		// `daemon --dry-runn` must not start anything.
		const r = run(["daemon", "--dry-runn", "--once"]);
		expect(r.status).not.toBe(0);
	});

	it("the real flags still work", () => {
		// Over-tightening would break the tool. Pin the positives too.
		expect(run(["init", "--detect"]).status).toBe(0);
		expect(run(["credentials", "--count"]).status).toBe(0);
	});

	it("the daemon parser reports unknown options it was given", () => {
		const r = run(["daemon", "--audit-everyy", "5", "--dry-run"]);
		expect(r.status).not.toBe(0);
		expect(r.out).toMatch(/unknown option/);
	});
});
