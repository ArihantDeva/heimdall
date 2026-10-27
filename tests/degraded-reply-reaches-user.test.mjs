// degraded-reply-reaches-user.test.mjs — the user-facing half of sem_coverage.
//
// WHY THIS EXISTS (measured 2026-10-23)
// Iteration #47 made query-server report sem_coverage=degraded, but only TESTS
// consumed it. The real user path dropped it twice:
//
//   query-server.py  → {"ok": true, "sem_coverage": "degraded", "hits": [...]}
//   query-shim.py    → read only ok + hits, so the field died at the transport
//   kb-search.sh     → printed "retrieve (warm fused: lexical + semantic)"
//                      UNCONDITIONALLY, for a lexical-only answer
//
// So a person running kb-search got a search advertised as complete while the
// semantic leg had blown its deadline. The shim's own docstring promises this
// never happens ("A missing worker must NEVER silently degrade the semantic leg
// to lexical-only") — a degraded reply is the same failure with the worker still
// alive.
//
// Verified end to end against a stub worker that returns a degraded reply.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SHIM = join(REPO, "bin", "query-shim.py");
const PY = plainPython();

const STUB = `
import json, os, socket, tempfile, sys
d = tempfile.mkdtemp(); sock = os.path.join(d, "q.sock")
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(sock); s.listen(5)
print(sock, flush=True)
while True:
    c, _ = s.accept(); buf = b""
    while b"\\n" not in buf:
        b = c.recv(65536)
        if not b: break
        buf += b
    c.sendall((json.dumps({
        "ok": True,
        "sem_coverage": os.environ.get("STUB_COVERAGE", "degraded"),
        "hits": [{"score": 1.5, "title": "t", "path": "/x.py", "leg": "lexical"}],
    }) + "\\n").encode())
    c.close()
`;

// Drive the real shim against a stub worker, and report what a user would see.
function shimAgainst(coverage) {
	return new Promise((resolve) => {
		const worker = spawn(PY, ["-c", STUB], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STUB_COVERAGE: coverage } });
		let sock = "";
		worker.stdout.on("data", (d) => {
			sock += d;
			if (!sock.includes("\n")) return;
			const path = sock.split("\n")[0].trim();
			const r = spawnSync(PY, [SHIM, "--fused", "q", "-n", "3"], {
				encoding: "utf8", env: { ...process.env, HEIMDALL_QUERY_SOCK: path }, timeout: 30_000,
			});
			try { worker.kill(); } catch {}
			resolve({ stdout: r.stdout || "", stderr: r.stderr || "", status: r.status });
		});
		setTimeout(() => { try { worker.kill(); } catch {} resolve({ stdout: "", stderr: "", status: -1 }); }, 25_000);
	});
}

describe("a degraded reply is not presented as a complete search", () => {
	it("the shim reports LEXICAL-ONLY on stderr when the server degrades", async () => {
		const r = await shimAgainst("degraded");
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/LEXICAL-ONLY/);
		expect(r.stderr).toMatch(/sem_coverage=degraded/);
	});

	it("still prints the hits (degrading is not failing)", async () => {
		const r = await shimAgainst("degraded");
		expect(r.stdout).toContain("/x.py");
	});

	it("stays silent when coverage is ok", async () => {
		// Over-reporting would train the reader to ignore the warning.
		const r = await shimAgainst("ok");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toMatch(/LEXICAL-ONLY/);
	});

	it("kb-search.sh keeps the shim's stderr and changes the header", () => {
		const src = readFileSync(join(REPO, "bin", "kb-search.sh"), "utf8");
		// 2>/dev/null here would discard the only carrier of the signal.
		expect(src).not.toMatch(/query-shim\.py[\s\S]{0,160}?2>\/dev\/null/);
		expect(src).toMatch(/2>"\$FAST_ERR"/);
		expect(src).toMatch(/LEXICAL-ONLY — semantic leg degraded/);
	});

	it("kb-search.sh cleans up the temp file on BOTH paths", () => {
		// The first version put the rm inside the success branch and leaked one
		// file per failed search (verified: before=0 after=1).
		const src = readFileSync(join(REPO, "bin", "kb-search.sh"), "utf8");
		// A successful reply now survives until the shared verdict pass: the
		// EXIT trap owns that file instead of deleting it before it is read.
		// warm-search-identity.test.mjs also checks the real temp directory.
		const successHandoff = src.includes('FAST_INPUT="$FAST_ERR"');
		const successTrap = src.includes('trap \'[ -z "$FAST_INPUT" ] || rm -f "$FAST_INPUT"\' EXIT');
		const failureRm = /else\s*\n\s*rm -f "\$FAST_ERR"/.test(src);
		expect(failureRm, "no cleanup on the failure path").toBe(true);
		expect(successHandoff && successTrap, "warm payload must be cleaned after verification").toBe(true);
	});
});
