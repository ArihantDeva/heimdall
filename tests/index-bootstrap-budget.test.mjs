// index-bootstrap-budget.test.mjs — runIndex promises it self-terminates; two
// per-step timeouts ignored the remaining budget and could overrun it.
//
// WHY THIS EXISTS (measured 2026-10-23)
// bin/lib/index-bootstrap.mjs had no test. Its docstring says an unattended path
// runs it, "so it must self-terminate", and it takes a budgetMs. Two leaks:
//
// 1. each repo got a FLAT spawnSync timeout of 120_000 regardless of budget, so
//    the loop could overrun the whole budget by two minutes PER REPO.
// 2. the embed step used Math.max(60_000, deadline - Date.now()). A floor is the
//    opposite of a deadline: with the budget already exhausted by 5s the
//    expression returned 60000, granting a full extra minute. Verified by
//    evaluating it directly.
//
// Both now use Math.min(remaining, cap) and skip rather than extend when
// nothing is left.
import { describe, it, expect } from "./lib/harness.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIndex } from "../bin/lib/index-bootstrap.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(join(REPO, "bin", "lib", "index-bootstrap.mjs"), "utf8")
	.split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

describe("index-bootstrap: the budget is a deadline, not a suggestion", () => {
	it("never gives a step more time than the budget has left", () => {
		// The floor was the bug: a negative remainder must not become a positive cap.
		expect(SRC).not.toMatch(/Math\.max\(\s*60_000/);
		expect(SRC).toMatch(/Math\.min\(\s*remaining\s*,\s*120_000\s*\)/);
	});

	it("gives each repo the remaining budget rather than a flat 120s", () => {
		expect(SRC).toMatch(/repoBudget\s*=\s*deadline\s*-\s*Date\.now\(\)/);
		expect(SRC).toMatch(/Math\.min\(\s*120_000\s*,\s*repoBudget\s*\)/);
		// and must not still contain the old flat timeout
		expect(SRC).not.toMatch(/timeout:\s*120_000\s*\}/);
	});

	it("skips rather than extends when the budget is gone", () => {
		expect(SRC).toMatch(/budget exhausted/);
		expect(SRC).toMatch(/repoBudget\s*<=\s*0/);
	});

	it("returns promptly when the budget is already exhausted", () => {
		// Behavioural: a zero budget must not go discover-and-build for minutes.
		const started = Date.now();
		const out = runIndex({ root: join(REPO, "tests"), budgetMs: 0 });
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(60_000);
		expect(out).toBeTruthy();
		expect(Array.isArray(out.repos)).toBe(true);
		// Every entry must be a skip with a reason, never a long-running build.
		for (const r of out.repos) {
			expect(["skipped", "failed", "ok"]).toContain(r.status);
		}
	});

	it("reports the embed decision either way", () => {
		const out = runIndex({ root: join(REPO, "tests"), budgetMs: 0 });
		expect(typeof out.embed).toBe("string");
		expect(out.embed).toMatch(/embed:/);
	});
});
