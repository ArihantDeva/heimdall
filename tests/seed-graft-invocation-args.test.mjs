// seed-graft-invocation-args.test.mjs — the argv handed to `graft` is the contract.
//
// WHY THIS EXISTS (measured 2026-10-23)
// seed-graft.sh builds a graft insert from a TSV row: a path, a purpose and a
// keyword list, each of which can contain spaces ("my file.md", "purpose here").
// It assembles them into a bash array:
//
//     args=(--title "$title" --body "$body")
//
// Nothing tested that array. The existing tests cover --dry-run and a source
// reduction of the delete/rollback ordering, but no test ever ran the INSERT
// path against a stub `graft` and looked at the argv. Verified: unquoting the
// assembly (`args=(--title $title --body $body)`) splits the title into five
// separate arguments and the whole 679-test suite still passed.
//
// This drives the real script with a recording stub on PATH and asserts the
// argument boundaries, which is the only place a quoting bug can be seen.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// Run seed-graft.sh against a stub `graft` that records one line per argv item.
function seedGraft({ row, args = [], makeFile = true }) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-seedargs-"));
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	mkdirSync(join(home, ".graft"), { recursive: true });
	mkdirSync(join(home, "bin"), { recursive: true });
	writeFileSync(join(home, "knowledge-base", ".inventory.tsv"), row);
	const rel = row.split("\t")[0];
	if (makeFile) writeFileSync(join(home, rel), "x");

	const stub = join(home, "bin", "graft");
	writeFileSync(stub, [
		"#!/bin/bash",
		// One ARG line per element so boundaries are visible; "stats" answers 0
		// because the script probes the daemon before doing anything.
		'hdr="$1"; shift',
		'printf "CALL %s\\n" "$hdr" >> "$HOME/calls.log"',
		'for a in "$@"; do printf "ARG %s\\n" "$a" >> "$HOME/calls.log"; done',
		'case "$hdr" in stats) exit 0 ;; esac',
		"exit 0",
	].join("\n"));
	chmodSync(stub, 0o755);

	const r = spawnSync("bash", [join(REPO, "bin", "seed-graft.sh"), ...args], {
		encoding: "utf8", timeout: 120_000,
		env: { ...process.env, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}` },
	});
	const logPath = join(home, "calls.log");
	const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
	// Split into calls; each call is its argv list.
	const calls = log.split("CALL ").filter(Boolean).map((c) => c.trim().split("\n").map((l) => l.replace(/^ARG /, "")));
	return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), calls };
}

describe("seed-graft hands graft one argument per field, spaces and all", () => {
	it("keeps a title containing spaces as a single argv element", () => {
		const { calls } = seedGraft({ row: "my file.md\tpurpose here\tkw1,kw2\n" });
		const insert = calls.find((c) => c[0] === "insert");
		expect(insert, `no insert call; calls: ${JSON.stringify(calls)}`).toBeTruthy();
		const title = insert[insert.indexOf("--title") + 1];
		// The whole point: this must be ONE element, not five.
		expect(title).toBe("my file.md — purpose here");
		const body = insert[insert.indexOf("--body") + 1];
		expect(body).toContain("my file.md — purpose here");
		expect(body).toContain("purpose here");
	});

	it("passes one --keyword per keyword", () => {
		const { calls } = seedGraft({ row: "a.md\tsome purpose\tkw1,kw2\n" });
		const insert = calls.find((c) => c[0] === "insert");
		const kws = insert.reduce((acc, a, i) => (insert[i - 1] === "--keyword" ? acc.concat(a) : acc), []);
		expect(kws).toEqual(["kw1", "kw2"]);
	});

	it("keeps a purpose containing a comma-and-space intact", () => {
		const { calls } = seedGraft({ row: "a.md\tfirst, second\t\n" });
		const insert = calls.find((c) => c[0] === "insert");
		const title = insert[insert.indexOf("--title") + 1];
		expect(title).toBe("a.md — first, second");
	});

	it("keeps a keyword containing a space intact", () => {
		// A keyword like "machine learning" must stay one argv element. Without
		// this case, unquoting the keyword loop goes unnoticed: single-token
		// keywords look identical quoted or not.
		const { calls } = seedGraft({ row: "a.md\tsome purpose\tmachine learning,nlp\n" });
		const insert = calls.find((c) => c[0] === "insert");
		const kws = insert.reduce((acc, a, i) => (insert[i - 1] === "--keyword" ? acc.concat(a) : acc), []);
		expect(kws).toEqual(["machine learning", "nlp"]);
	});

	it("does not insert when the row's file is missing", () => {
		const { calls, out } = seedGraft({ row: "gone.md\tsome purpose\t\n", makeFile: false });
		expect(calls.some((c) => c[0] === "insert")).toBe(false);
		expect(out).toMatch(/skip missing/);
	});
});
