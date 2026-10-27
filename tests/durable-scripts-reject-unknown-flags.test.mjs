// durable-scripts-reject-unknown-flags.test.mjs — a typo'd --dry-run is not a rehearsal.
//
// WHY THIS EXISTS (measured 2026-10-23)
// Both durable-mutation scripts parsed flags by testing each one explicitly and
// ignoring everything else:
//
//     # sync-edits.sh
//     for a in "$@"; do
//       [ "$a" = "--dry-run" ] && DRY=1
//       [ "$a" = "--full" ] && FULL=1
//     done
//
//     # seed-graft.sh
//     DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
//
// No else branch. So `--dry-runn` (one letter short) fell through, DRY stayed 0,
// and the run proceeded PAST the dry-run branch at line 113 to actually hint
// paths and ADVANCE the durable high-water mark in $STATE. A rehearsal the
// operator believes is safe, performing permanent work. seed-graft is worse: it
// deletes and re-inserts graph rows.
//
// Same class as #52's CLI flags and #53's leading-token guard.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function run(script, args, { home, tsv = false } = {}) {
	const h = home ?? mkdtempSync(join(tmpdir(), "heimdall-durable-"));
	mkdirSync(join(h, ".graft"), { recursive: true });
	if (tsv) {
		mkdirSync(join(h, "knowledge-base"), { recursive: true });
		writeFileSync(join(h, "knowledge-base", ".inventory.tsv"), "a.md\tpurpose\tkw\n");
	}
	const r = spawnSync("bash", [join(REPO, "bin", script), ...args], {
		encoding: "utf8", timeout: 180_000, env: { ...process.env, HOME: h },
	});
	return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), home: h };
}

describe("a typo'd --dry-run does not become the real thing", () => {
	it("sync-edits refuses --dry-runn instead of running for real", () => {
		const r = run("sync-edits.sh", ["--dry-runn"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("--dry-runn");
		// The state file is only written by a real run. A refusal must not touch it.
		expect(existsSync(join(r.home, ".graft", ".last-sync"))).toBe(false);
	});

	it("sync-edits still accepts --dry-run", () => {
		const r = run("sync-edits.sh", ["--dry-run"]);
		expect(r.status, r.out.slice(0, 200)).toBe(0);
	});

	it("sync-edits still accepts --full", () => {
		const r = run("sync-edits.sh", ["--full"]);
		// --full is a real run; it may exit nonzero for unrelated reasons on a
		// sandbox HOME, but it must NOT be rejected as an unknown option.
		expect(r.out).not.toMatch(/unknown option/);
	});

	it("seed-graft refuses --dry-runn", () => {
		const r = run("seed-graft.sh", ["--dry-runn"], { tsv: true });
		expect(r.status).toBe(2);
		expect(r.out).toContain("--dry-runn");
	});

	it("seed-graft names the flag typo even when its TSV is missing", () => {
		// Argument validation belongs before environment preconditions: otherwise
		// a typo is reported as "no inventory file" and the operator debugs the
		// wrong thing. Found by running it without a TSV.
		const r = run("seed-graft.sh", ["--dry-runn"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("unknown option");
		expect(r.out).not.toMatch(/no .*inventory\.tsv/);
	});

	it("seed-graft still accepts --dry-run", () => {
		const r = run("seed-graft.sh", ["--dry-run"], { tsv: true });
		expect(r.out).not.toMatch(/unknown option/);
	});

	it("every durable script with a flag loop has an else that refuses", () => {
		// Structural: the pattern that caused this is a flag test with no fallback.
		// Strip comments first: an earlier version of this check used a fixed
		// character window and my own explanatory comment pushed the real code
		// past it. Compare the guard's POSITION relative to the loop instead of
		// relying on proximity.
		for (const file of ["sync-edits.sh", "seed-graft.sh"]) {
			const raw = readFileSync(join(REPO, "bin", file), "utf8");
			const src = raw.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
			const loop = src.indexOf('for a in "$@"; do');
			const guard = src.indexOf("unknown option");
			expect(loop, `${file} has no flag loop`).toBeGreaterThan(-1);
			expect(guard, `${file} lost its unknown-option rejection`).toBeGreaterThan(-1);
			// The guard must live inside the loop, i.e. after it starts.
			expect(guard, `${file}: guard is not inside the flag loop`).toBeGreaterThan(loop);
		}
	});
});
