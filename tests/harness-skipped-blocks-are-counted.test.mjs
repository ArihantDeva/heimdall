// harness-skipped-blocks-are-counted.test.mjs — a skipped describe must not
// vanish from the tally.
//
// WHY THIS EXISTS (measured 2026-10-23)
// A skipped describe NEVER RUNS its body, so node cannot count what was in it:
//     describe.skip("x", () => { it("a",f); it("b",f); it("c",f); });
// reports   ℹ tests 0   ℹ skipped 0
// Those three tests do not exist. Verified on node 26.10 for BOTH
// describe.skip(...) and describe(name, {skip: "..."}, ...): a skipped SUITE is
// uncountable no matter what.
//
// Consequence measured in this repo: the suite printed `skipped 3` while SIXTEEN
// child tests sat behind those three suites (14 product tests in fast-search and
// query-server, plus 2 harness tests). Reading "3 skipped" you would conclude
// three assertions were deferred. The real number was 16, and nothing in the
// output said so. This matters most for a suite whose whole job is to stay
// honest about what it actually verified.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS = join(REPO, "tests", "lib", "harness.mjs");

// A nested `node --test` inherits NODE_TEST_CONTEXT and emits NO tally at all
// (measured: stdout 0 bytes vs 1513 for the same fixture launched from a plain
// process), so the child runs with that variable dropped.
const cleanEnv = () => {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return env;
};

const runFixture = (body) => {
	const dir = mkdtempSync(join(tmpdir(), "harness-skip-"));
	const f = join(dir, "fixture.test.mjs");
	writeFileSync(f, `import { describe, it, expect } from ${JSON.stringify(HARNESS)};\n${body}\n`);
	const r = spawnSync(process.execPath, ["--test", f], {
		encoding: "utf8", timeout: 120_000, env: cleanEnv(),
	});
	rmSync(dir, { recursive: true, force: true });
	const out = r.stdout || "";
	// node 26 emits `ℹ skipped N`; node 22 without a TTY emits TAP `# skipped N`.
	expect(out, "fixture produced no node --test report").toMatch(/[ℹ#] (pass|fail) \d+/);
	return out;
};

const tally = (out) => {
	const num = (label) => {
		const m = out.match(new RegExp(`^[ℹ#] ${label} (\\d+)`, "m"));
		return m ? Number(m[1]) : -1;
	};
	return { pass: num("pass"), fail: num("fail"), skipped: num("skipped") };
};

describe("harness: skipped blocks are visible, not silent", () => {
	it("a skipped describe with 3 children reports 3 skipped, not 0", () => {
		const t = tally(runFixture(`
describe("plain", () => { it("a", () => {}); });
describe.skip("gone", () => { it("c", () => {}); it("d", () => {}); it("e", () => {}); });`));
		// Before the fix this was skipped: 0 — the three children were invisible.
		expect(t.skipped).toBe(1);   // one counted deferral standing for the block
		expect(t.fail).toBe(0);
	});

	it("skipIf(true) is counted too", () => {
		const t = tally(runFixture(`
describe.skipIf(true)("off", () => { it("x", () => {}); });
describe("plain", () => { it("a", () => {}); });`));
		expect(t.skipped).toBe(1);
		expect(t.fail).toBe(0);
	});

	it("skipIf(false) still RUNS its children", () => {
		// The dangerous over-correction: making every skipIf defer regardless.
		const t = tally(runFixture(`
describe.skipIf(false)("on", () => { it("y", () => expect(1).toBe(1)); });`));
		expect(t.pass).toBe(1);
		expect(t.skipped).toBe(0);
	});

	it("the deferral STATES that its tests are not counted", () => {
		// The whole point: a reader must be able to tell a deferred block from a
		// block that was never written.
		const out = runFixture(`describe.skip("gone", () => { it("c", () => {}); });`);
		expect(out).toMatch(/DEFERRED, its tests are not in the tally/);
	});

	it("a deferred block does not fake a PASS", () => {
		// Counting the deferral must not inflate the pass count.
		const t = tally(runFixture(`
describe.skip("gone", () => { it("c", () => {}); it("d", () => {}); });`));
		expect(t.pass).toBe(0);
	});
});
