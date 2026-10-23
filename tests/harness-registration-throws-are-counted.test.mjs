// harness-registration-throws-are-counted.test.mjs — a describe block that
// throws must not vanish from the tally.
//
// WHY THIS EXISTS (measured 2026-10-23)
// A describe BODY runs at REGISTRATION time, before any test executes. If it
// throws — most easily from an `expect()` placed at the top of the block — node
// registers NONE of that block's children. Measured on node 26.10: five intended
// `it()`s became zero, and the run printed
//     ✖ failing tests:
//     ✖ block B: throws while REGISTERING
//     ℹ fail 0
// The process exit code is 1, so CI is not fooled. But anything reading the
// COUNTS — including this project's own experiment tooling, which parses exactly
// those lines — sees a clean run. That is the same defect as a swallowed
// exception: green while verifying nothing, and one iteration of this session
// was measured wrongly because of it.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS = join(REPO, "tests", "lib", "harness.mjs");

// Run a snippet in a real child node --test, so we measure the runner's actual
// tally rather than our own reading of it.
// A nested `node --test` (a --test run spawning another --test run) inherits
// NODE_TEST_CONTEXT and emits NO tally at all — measured: stdout length 0
// against 1513 for the same fixture launched from a plain process. Dropping the
// variable gives the child a real, independently-reported run.
const cleanEnv = () => {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return env;
};

const runFixture = (source, extraArgs = []) => {
	const dir = mkdtempSync(join(tmpdir(), "harness-reg-"));
	const f = join(dir, "fixture.test.mjs");
	writeFileSync(f, source);
	const r = spawnSync(process.execPath, ["--test", ...extraArgs, f], {
		encoding: "utf8", timeout: 120_000, env: cleanEnv(),
	});
	rmSync(dir, { recursive: true, force: true });
	const out = r.stdout || "";
	// A silent empty child must be a FAILURE here, not a silent pass: that is the
	// defect this file exists to catch.
	expect(out, "fixture produced no node --test report").toMatch(/[ℹ#] (pass|fail) \d+/);
	return out;
};

const fixture = (body) =>
	`import { describe, it, expect } from ${JSON.stringify(HARNESS)};\n${body}\n`;

// node chooses its reporter by version and TTY: node 26 (and CI's node 22 on a
// TTY) emit the spec/summary form  `ℹ pass 2` / `ℹ fail 0`, while node 22
// without a TTY emits TAP: `# pass 2` / `# fail 0`. Reading only one format
// meant this file passed on node 26 and failed on node 22 — the exact version
// ci.yml pins on BOTH legs. Parse both.
const tally = (out) => {
	const num = (label) => {
		const m = out.match(new RegExp(`^[ℹ#] ${label} (\\d+)`, "m"));
		return m ? Number(m[1]) : -1;
	};
	return { pass: num("pass"), fail: num("fail") };
};

describe("harness: a describe that throws while registering is COUNTED", () => {
	it("a healthy block still runs all its tests", () => {
		const out = runFixture(fixture(`
describe("ok", () => {
	it("a", () => expect(1).toBe(1));
	it("b", () => expect(1).toBe(1));
});`));
		const t = tally(out);
		expect(t.pass).toBe(2);
		expect(t.fail).toBe(0);
	});

	it("a block whose registration throws still produces a COUNTED failure", () => {
		// This is the bug: before the guard, `fail` read 0 here while the block's
		// five children silently disappeared.
		const out = runFixture(fixture(`
describe("boom", () => {
	expect("missing", "scanner must exist").toMatch(/import ast/);
	it("never registered", () => expect(1).toBe(1));
	it("also never registered", () => expect(1).toBe(1));
});`));
		const t = tally(out);
		expect(t.pass).toBe(0);
		expect(t.fail).toBeGreaterThanOrEqual(1);   // the whole point
	});

	it("the counted failure names the cause", () => {
		const out = runFixture(fixture(`
describe("boom", () => { expect("x").toMatch(/y/); });`));
		expect(out).toMatch(/describe threw while registering/);
	});

	it("the run still exits non-zero", () => {
		// Exit code was already correct; pin it so the guard never trades one
		// silent pass for another.
		const dir = mkdtempSync(join(tmpdir(), "harness-reg-"));
		const f = join(dir, "fixture.test.mjs");
		writeFileSync(f, fixture(`describe("boom", () => { expect("x").toMatch(/y/); });`));
		const r = spawnSync(process.execPath, ["--test", f], {
			encoding: "utf8", timeout: 120_000, env: cleanEnv(),
		});
		rmSync(dir, { recursive: true, force: true });
		expect(r.status).not.toBe(0);
	});

	it("skip semantics are not broken by the guard", () => {
		const out = runFixture(fixture(`
describe.skip("skipped", () => {
	it("must not run", () => { throw new Error("SKIP WAS LOST"); });
});
describe.skipIf(true)("skipped by predicate", () => {
	it("must not run", () => { throw new Error("SKIPIF WAS LOST"); });
});
describe("runs", () => { it("here", () => expect(1).toBe(1)); });`));
		const t = tally(out);
		expect(t.fail).toBe(0);       // a lost skip would have failed
		expect(t.pass).toBe(1);       // only the unmodified block ran
	});

	it("only semantics are not broken by the guard", () => {
		// node:test honours .only ONLY with --test-only; without it the flag is
		// inert and both blocks run. Pass it, or this test asserts nothing.
		const out = runFixture(fixture(`
describe("not selected", () => { it("nope", () => { throw new Error("ONLY WAS LOST"); }); });
describe.only("selected", () => { it("yes", () => expect(1).toBe(1)); });`), ["--test-only"]);
		const t = tally(out);
		expect(t.fail).toBe(0);
		expect(t.pass).toBe(1);
	});
});
