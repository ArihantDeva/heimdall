// warm-readiness-contract.test.mjs — "ping ok" is not "search is warm".
//
// WHY THIS EXISTS (measured 2026-10-23)
// query-server.py binds its socket immediately, then builds a 416MB vector
// snapshot for 135,490 x 768 vectors on a BACKGROUND thread. Measured on this
// machine:
//
//     model warm in 0.8s
//     vector snapshot ready: 135490 x 768 (416MB)      ~5s later
//     first search query:  4815ms
//     second:              1329ms
//     third:                205ms
//
// `ping` reported only ok/pid/model, so a caller had no way to ask whether the
// semantic leg was usable. A test that pinged and immediately searched landed on
// the cold fallback — 4815ms against a 10s deadline — and under load blew the
// deadline and degraded to lexical-only. That surfaced as the intermittent
// "both legs represented" failure, which blamed the wrong thing.
//
// ping now reports `warm` (snapshot usable) and `loading` (build in flight), so
// callers gate on a fact instead of an assumption.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { existsSync, readFileSync } from "node:fs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(REPO, "bin", "query-server.py");
const VENV_PY = join(homedir(), ".heimdall", "venv", "bin", "python3");
const canRun =
	existsSync(VENV_PY) && existsSync(join(homedir(), ".heimdall", "global.db"));

const DIR = mkdtempSync(join(tmpdir(), "heimdall-warm-"));
const SOCK = join(DIR, "warm.sock");

function rpc(req, sock = SOCK, timeoutMs = 30_000) {
	return new Promise((resolve) => {
		const s = createConnection(sock);
		let buf = "";
		const t = setTimeout(() => { try { s.destroy(); } catch {} resolve({ error: "client timeout" }); }, timeoutMs);
		s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
		s.on("data", (d) => {
			buf += d;
			if (buf.includes("\n")) {
				clearTimeout(t);
				try { s.destroy(); } catch {}
				try { resolve(JSON.parse(buf.split("\n")[0])); } catch (e) { resolve({ error: String(e) }); }
			}
		});
		s.on("error", (e) => { clearTimeout(t); resolve({ error: e.code }); });
	});
}

describe.skipIf(!canRun)("ping reports readiness, not just liveness", () => {
	it("distinguishes a booted worker from a warm one", async () => {
		const child = spawn(VENV_PY, [SERVER, "--socket", SOCK], { stdio: "ignore" });
		try {
			// Wait for the socket to exist at all.
			let up = false;
			for (let i = 0; i < 600; i++) {
				if (existsSync(SOCK)) {
					const r = await rpc({ op: "ping" }, SOCK, 5_000);
					if (r && !r.error) { up = true; break; }
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			expect(up, "server never answered ping").toBe(true);

			const first = await rpc({ op: "ping" });
			// The field must EXIST. A missing field is what made "warm" an
			// assumption; undefined !== false, so presence is part of the contract.
			expect(typeof first.warm, "ping must report warmth").toBe("boolean");
			expect(typeof first.loading).toBe("boolean");
			// The snapshot is either usable or still building — never both.
			expect(first.warm && first.loading).toBe(false);

			// Wait for readiness and confirm it flips.
			let last = first;
			for (let i = 0; i < 240; i++) {
				last = await rpc({ op: "ping" });
				if (last.warm) break;
				await new Promise((r) => setTimeout(r, 250));
			}
			expect(last.warm, "the snapshot never became usable").toBe(true);
			expect(last.loading).toBe(false);
		} finally {
			try { child.kill(); } catch {}
		}
	}, 180_000);

});

// NOT gated on live state: this reads source text, so it must run in CI too.
// Leaving it inside the skipIf block above would have traded real coverage for a
// skip, which is the same mistake as counting a skip as a fix.
describe("warmth gate is present in every boot-waiting suite", () => {
	it("fast-search and query-server wait for warm, not just the socket", () => {
		for (const file of ["fast-search.test.mjs", "query-server.test.mjs"]) {
			const src = readFileSyncSafe(join(REPO, "tests", file));
			expect(src, `${file} does not consult r.warm`).toMatch(/r\.warm/);
		}
	});

	it("ping reports warmth as a boolean, never a truthy guess", () => {
		const src = readFileSyncSafe(SERVER);
		expect(src).toMatch(/"warm":\s*_VEC\["mat"\] is not None/);
		expect(src).toMatch(/"loading":\s*bool\(_VEC\["loading"\]\)/);
	});
});

function readFileSyncSafe(p) {
	return readFileSync(p, "utf8");
}
