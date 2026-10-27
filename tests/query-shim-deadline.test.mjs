// query-shim-deadline.test.mjs — the warm-worker client must have a real
// deadline, and must degrade LOUDLY.
//
// WHY THIS EXISTS (measured 2026-10-23)
// bin/query-shim.py had no test. Two properties matter and neither was checked:
//
// 1. THE TIMEOUT WAS PER-RECV, NOT A DEADLINE.
//    sock.settimeout(T) applies to EACH socket operation, so a worker that sends
//    one byte at a time resets the clock on every recv(). Measured against a
//    server trickling a byte every 0.3s with HEIMDALL_QUERY_TIMEOUT=1: the call
//    took 7.7s and exited 0. With the default 90s and a stalled worker that is an
//    unbounded search, and every caller of kb-search.sh blocks on it.
//
// 2. THE EXIT CODE IS THE SHELL'S ONLY SIGNAL.
//    Exit 0 means "answered" (hits may legitimately be empty); exit 1 means
//    "worker unreachable / error" and kb-search.sh falls back to the cold path.
//    So a shim that answers 0 on a stalled or malformed exchange silently makes a
//    degraded search look complete.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SHIM = join(REPO, "bin", "query-shim.py");
const python = plainPython();

// Start a unix-socket server that runs `onConn`, then invoke the shim against it.
// Returns { code, stdout, stderr, elapsedMs }.
async function withServer(onConn, { timeout = "1", args = ["hello"] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "shim-sock-"));
	const sockPath = join(dir, "q.sock");
	const server = createServer((conn) => onConn(conn));
	await new Promise((res, rej) => {
		server.once("error", rej);
		server.listen(sockPath, res);
	});
	const started = Date.now();
	try {
		const child = spawn(python, [SHIM, ...args], {
			env: { ...process.env, HEIMDALL_QUERY_SOCK: sockPath, HEIMDALL_QUERY_TIMEOUT: timeout },
		});
		let stdout = "", stderr = "";
		child.stdout.on("data", (d) => { stdout += d; });
		child.stderr.on("data", (d) => { stderr += d; });
		const code = await new Promise((res) => child.on("close", res));
		return { code, stdout, stderr, elapsedMs: Date.now() - started };
	} finally {
		await new Promise((res) => server.close(res));
		rmSync(dir, { recursive: true, force: true });
	}
}

const reply = (obj) => Buffer.from(JSON.stringify(obj) + "\n");

describe("query-shim: a stalled worker cannot extend the deadline", () => {
	it("a trickled reply is cut off at the deadline, not per-byte", async () => {
		// The regression: 40 bytes at 0.3s each is 12s of wall clock, and each
		// byte arrives well inside a 1s per-recv timeout.
		const r = await withServer((conn) => {
			conn.once("data", () => {
				const bytes = reply({ ok: true, hits: [] });
				let i = 0;
				const tick = () => {
					if (i >= bytes.length) { conn.end(); return; }
					conn.write(bytes.subarray(i, i + 1));
					i += 1;
					setTimeout(tick, 300);
				};
				tick();
			});
		}, { timeout: "1" });
		// 1s deadline; allow generous slack for process start on a loaded runner.
		expect(r.elapsedMs).toBeLessThan(4000);
		expect(r.code).not.toBe(0);   // must report failure, so the caller falls back
	});

	it("a normal reply is passed through unchanged", async () => {
		const r = await withServer((conn) => {
			conn.once("data", () => conn.end(reply({
				ok: true, hits: [{ title: "T", path: "/p/x.py", score: 0.5 }],
			})));
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("[0.5] T — /p/x.py");
	});

	it("an empty result set is a SUCCESS, not a failure", async () => {
		// Exit 0 means "answered"; hits may legitimately be empty. Over-correcting
		// to exit 1 on no hits would make every empty search fall back to the slow
		// path.
		const r = await withServer((conn) => conn.once("data", () => conn.end(reply({ ok: true, hits: [] }))));
		expect(r.code).toBe(0);
		expect(r.stdout.trim()).toBe("");
	});

	it("an error reply exits 1 so the shell falls back", async () => {
		const r = await withServer((conn) => conn.once("data", () => conn.end(reply({ ok: false, error: "boom" }))));
		expect(r.code).toBe(1);
		expect(r.stderr).toMatch(/boom/);
	});

	it("a malformed reply exits 1 rather than printing nothing and succeeding", async () => {
		const r = await withServer((conn) => conn.once("data", () => conn.end("not json\n")));
		expect(r.code).toBe(1);
	});

	it("an absent socket exits 1", async () => {
		// No server at all: the shim must report unreachable, so kb-search.sh
		// falls back to the cold path instead of treating silence as "no hits".
		const gone = join(mkdtempSync(join(tmpdir(), "nosock-")), "missing.sock");
		const child = spawn(python, [SHIM, "hello"], {
			env: { ...process.env, HEIMDALL_QUERY_SOCK: gone, HEIMDALL_QUERY_TIMEOUT: "2" },
		});
		let stderr = "";
		child.stderr.on("data", (d) => { stderr += d; });
		const code = await new Promise((res) => child.on("close", res));
		rmSync(dirname(gone), { recursive: true, force: true });
		expect(code).toBe(1);
		expect(stderr).toMatch(/unreachable/);
	});
});
