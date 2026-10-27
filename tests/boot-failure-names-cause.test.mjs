// boot-failure-names-cause.test.mjs — a server that fails to boot must say why.
//
// WHY THIS EXISTS (measured 2026-10-23)
// Two suites start query-server.py and wait for its socket, both with
// stdio: "ignore". When the server could not boot they failed with:
//
//     "server did not start"                      (fast-search, after 120s)
//     "expected false to be true"                 (deadline test, after 120s)
//
// Both messages are true and both name nothing. The actual reason — a missing
// model cache, an import error, a bad socket path — had been written to the
// child's stderr and discarded. Worse, the wait loop kept polling for the full
// timeout after the child had already exited, so a 1-second failure took two
// minutes to report.
//
// Fixed by capturing stderr and breaking out of the loop as soon as the child
// exits. Verified: 128s -> 18s with the cause in the message.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PY = plainPython();

// Mirror of the boot-wait shape both suites use.
function bootWait({ captureStderr, breakOnExit, failAfterMs = 8_000 }) {
	return new Promise((resolve) => {
		const child = spawn(PY, ["-c", 'import sys; sys.stderr.write("BOOM: missing model cache\\n"); sys.exit(3)'], {
			stdio: captureStderr ? ["ignore", "ignore", "pipe"] : "ignore",
		});
		let err = "";
		if (captureStderr) child.stderr?.on("data", (d) => { err = (err + d).slice(-2000); });
		const t0 = Date.now();
		const tick = () => {
			if (breakOnExit && child.exitCode !== null) {
				return resolve({ elapsed: Date.now() - t0, exited: child.exitCode, err });
			}
			if (Date.now() - t0 >= failAfterMs) {
				return resolve({ elapsed: Date.now() - t0, exited: child.exitCode, err });
			}
			setTimeout(tick, 100);
		};
		tick();
	});
}

describe("a failed boot reports the reason, not just the symptom", () => {
	it("captures the child's stderr instead of discarding it", async () => {
		const r = await bootWait({ captureStderr: true, breakOnExit: true });
		expect(r.err).toContain("BOOM: missing model cache");
		expect(r.exited).toBe(3);
	});

	it("stops waiting once the child has exited", async () => {
		// Without this the loop polls its whole budget for a process that is gone.
		const r = await bootWait({ captureStderr: true, breakOnExit: true, failAfterMs: 30_000 });
		expect(r.elapsed).toBeLessThan(5_000);
	});

	it("demonstrates the old behaviour was slow AND silent", async () => {
		// The contrast is the point: same failure, no capture, no early exit.
		const slow = await bootWait({ captureStderr: false, breakOnExit: false, failAfterMs: 2_500 });
		expect(slow.err).toBe("");            // reason discarded
		expect(slow.elapsed).toBeGreaterThanOrEqual(2_400); // and it waited anyway
	});

	it("both boot-waiting suites capture stderr and break on exit", () => {
		for (const file of ["fast-search.test.mjs", "query-server.test.mjs"]) {
			const src = readFileSync(join(REPO, "tests", file), "utf8");
			// stdio: "ignore" throws away the only channel that says why.
			expect(src, `${file} still discards the child's stderr`).not.toMatch(
				/spawn\(VENV_PY,[\s\S]{0,120}?stdio:\s*"ignore"/,
			);
			expect(src, `${file} does not capture stderr`).toMatch(/stderr\?\.on\("data"/);
			// Must BREAK the wait loop, not merely mention exitCode. A previous
			// version of this assertion matched the bare string "exitCode !== null"
			// anywhere in the file, so deleting the early exit still passed.
			expect(src, `${file} does not break the wait loop when the child exits`).toMatch(
				/if \([\w.]*exitCode !== null\);?\s*(?:break|return false)/,
			);
		}
	});
});
