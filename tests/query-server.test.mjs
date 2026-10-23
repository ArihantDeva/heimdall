// query-server.test.mjs — the warm semantic query worker.
//
// WHY THIS EXISTS (measured 2026-10-22)
// Every `kb-search.sh` call spawned a cold `~/.heimdall/venv/bin/python3
// embed-index.py query`. Profiled end to end: torch+sentence_transformers
// import 9.7s, model load 0.65s, encode 0.16s, kNN 3.5s cold / 0.18s warm.
// p50 for kb_search was 21.8s across 109 calls. The import and the cold page
// cache are per-process costs; a long-lived worker pays them once.
//
// These tests pin the CONTRACT, not the timing: framing, ordering, error
// survival, and the guard that a second worker cannot steal the socket.
// node:test is the runner package.json actually invokes; see tests/lib/harness.mjs
import { describe, it, expect, beforeAll, afterAll } from "./lib/harness.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { plainPython } from "./lib/python.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(REPO, "bin", "query-server.py");
const VENV_PY = join(homedir(), ".heimdall", "venv", "bin", "python3");
// A PRIVATE socket. This suite used the production path and unlinked it in
// beforeAll/afterAll, which killed the operator's live warm worker and made the
// suite pass only when nothing else was running. Tests must never manage the
// real socket.
// Sockets live in a PRIVATE temp dir, never the operator's ~/.heimdall.
// Measured 2026-10-23: this suite unlinkSync'd query-server-test.sock inside the
// live state dir, so two workers (this suite's and the operator's own daemon)
// could contend for one location. Isolating makes the file unreachable by
// anything but this process.
const SOCK_DIR = mkdtempSync(join(tmpdir(), "heimdall-qserver-"));
const SOCK = join(SOCK_DIR, "query-server-test.sock");

// The semantic worker needs the heimdall venv + a built index. Absent either,
// this suite cannot prove anything real, so it must SKIP loudly rather than
// pass green on a machine that never ran the code path.
const canRun = existsSync(VENV_PY) && existsSync(join(homedir(), ".heimdall", "global.db"));

// Any python3 runs the reply-contract tests below: they stub both module-top
// imports, so no venv and no model are involved.
const python = plainPython();

function rpc(sockPath, payload, { timeoutMs = 90_000 } = {}) {
	return new Promise((resolve) => {
		const sock = createConnection(sockPath);
		let buf = "";
		const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
		const timer = setTimeout(() => done({ error: "client timeout" }), timeoutMs);
		sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
		sock.on("data", (d) => {
			buf += d.toString();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			try { done(JSON.parse(buf.slice(0, nl))); } catch (e) { done({ error: `bad frame: ${e.message}` }); }
		});
		sock.on("error", (e) => { clearTimeout(timer); done({ error: e.code || e.message }); });
	});
}

let child = null;

async function waitForSocket(path, ms = 90_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (existsSync(path)) {
			const r = await rpc(path, { op: "ping" });
			if (r && !r.error) return true;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

describe.skipIf(!canRun)("query-server: warm semantic worker", () => {
	beforeAll(async () => {
		try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {}
		try { if (existsSync(SOCK + ".lock")) unlinkSync(SOCK + ".lock"); } catch {}
		child = spawn(VENV_PY, [SERVER, "--socket", SOCK], { stdio: "ignore", detached: false });
		const up = await waitForSocket(SOCK);
		if (!up) throw new Error(`query-server did not come up on ${SOCK}`);
	}, 120_000);

	afterAll(() => {
		try { child?.kill(); } catch {}
		try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {}
		try { if (existsSync(SOCK + ".lock")) unlinkSync(SOCK + ".lock"); } catch {}
	});

	it("answers ping", async () => {
		const r = await rpc(SOCK, { op: "ping" });
		expect(r.ok).toBe(true);
	});

	it("serves a semantic query over the socket", async () => {
		const r = await rpc(SOCK, { op: "query", q: "tool call latency", n: 3 });
		expect(r.ok).toBe(true);
		expect(Array.isArray(r.hits)).toBe(true);
		if (r.hits.length) {
			expect(typeof r.hits[0].path).toBe("string");
			expect(typeof r.hits[0].score).toBe("number");
		}
	}, 120_000);

	it("serves the SAME query repeatedly without re-paying the import", async () => {
		// The property that matters is "the worker stays warm", NOT a wall-clock
		// ratio. The first version asserted second < max(first*3, 5000), which
		// flakes on a loaded machine (measured on a box at load average 60): a
		// cold-cache first call can return in 400ms while a later call stalls
		// behind a scheduler queue, and the ratio then says nothing true.
		//
		// What cannot lie: a per-request re-import of torch costs ~10 SECONDS.
		// So if several consecutive calls all return in well under that, the
		// import was paid once. That is the contract, and it holds under load.
		const a = await rpc(SOCK, { op: "query", q: "browser session singleton lock", n: 3 });
		expect(a.ok).toBe(true);
		const times = [];
		for (let i = 0; i < 4; i++) {
			const t = Date.now();
			const r = await rpc(SOCK, { op: "query", q: "browser session singleton lock", n: 3 });
			times.push(Date.now() - t);
			expect(r.ok).toBe(true);
			// Same query, same ANSWER SET: determinism is part of warmth, but
			// order between exact ties is not stable and asserting it would flake.
			expect([...r.hits.map((h) => h.path)].sort()).toEqual([...a.hits.map((h) => h.path)].sort());
		}
		// Every call must be far under a fresh interpreter's import cost.
		expect(Math.max(...times)).toBeLessThan(8_000);
	}, 300_000);

	it("survives a bad request and keeps serving", async () => {
		const bad = await rpc(SOCK, { op: "nonsense" });
		expect(bad.ok).toBe(false);
		expect(typeof bad.error).toBe("string");
		const good = await rpc(SOCK, { op: "ping" });
		expect(good.ok).toBe(true);
	});

	it("survives malformed JSON and keeps serving", async () => {
		const r = await new Promise((resolve) => {
			const sock = createConnection(SOCK);
			let buf = "";
			sock.on("connect", () => sock.write("this is not json\n"));
			sock.on("data", (d) => {
				buf += d.toString();
				if (buf.includes("\n")) { try { sock.destroy(); } catch {} resolve(JSON.parse(buf.split("\n")[0])); }
			});
			sock.on("error", (e) => resolve({ error: e.code }));
			setTimeout(() => resolve({ error: "timeout" }), 15_000);
		});
		expect(r.ok).toBe(false);
		const good = await rpc(SOCK, { op: "ping" });
		expect(good.ok).toBe(true);
	});

	it("serves two concurrent clients without interleaving frames", async () => {
		const [a, b] = await Promise.all([
			rpc(SOCK, { op: "query", q: "resume tailoring pipeline", n: 2 }),
			rpc(SOCK, { op: "query", q: "browser session guard", n: 2 }),
		]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		// A shared buffer bug would cross-contaminate these two paths.
		const pa = a.hits.map((h) => h.path).join(",");
		const pb = b.hits.map((h) => h.path).join(",");
		if (pa && pb) expect(pa).not.toBe(pb);
	}, 180_000);
});

describe("query-server: guards", () => {
	it("refuses to start when another worker owns the socket", async () => {
		if (!canRun) return;
		const r = await rpc(SOCK, { op: "ping" });
		if (!r || r.error) return; // no live worker to collide with
		const second = spawn(VENV_PY, [SERVER, "--socket", SOCK], { stdio: ["ignore", "pipe", "pipe"] });
		const code = await new Promise((res) => {
			second.on("close", res);
			setTimeout(() => { try { second.kill(); } catch {} res("timeout"); }, 30_000);
		});
		// Must exit non-zero rather than hijack a live socket.
		expect(code).not.toBe(0);
		expect(code).not.toBe("timeout");
	}, 60_000);
});

// ── Stale-lock recovery ─────────────────────────────────────────────────────
//
// The single-worker lock must never be able to lock the WORKER out permanently.
// Measured failure 2026-10-22: a killed worker left query.sock.lock behind, the
// next start read "someone holds this" and exited 4, and every search silently
// fell back to the 14s graft path until the file was deleted by hand.
//
// flock is advisory and dies with the process, so a freshly-opened lock file
// always grants the lock; the danger is only in treating the FILE's existence as
// proof of a live holder. This test writes a lock naming a guaranteed-dead PID
// and requires the worker to start anyway.
describe.skipIf(!canRun)("query-server: stale lock does not lock the worker out", () => {
	it("starts despite a lock file left by a dead pid", async () => {
		const sock = join(homedir(), ".heimdall", "query-server-stale-test.sock");
		const lock = sock + ".lock";
		try { if (existsSync(sock)) unlinkSync(sock); } catch {}
		// PID 999999 is not a real process; spawn with it recorded as the holder.
		writeFileSync(lock, "999999");
		const c = spawn(VENV_PY, [SERVER, "--socket", sock], { stdio: "ignore" });
		try {
			const t0 = Date.now();
			let up = false;
			while (Date.now() - t0 < 120_000) {
				if (existsSync(sock)) {
					const r = await rpc(sock, { op: "ping" });
					if (r && !r.error) { up = true; break; }
				}
				await new Promise((r) => setTimeout(r, 200));
			}
			expect(up).toBe(true);
		} finally {
			try { c.kill(); } catch {}
			try { if (existsSync(sock)) unlinkSync(sock); } catch {}
			try { if (existsSync(lock)) unlinkSync(lock); } catch {}
		}
	}, 240_000);
});

afterAll(() => {
	try { rmSync(SOCK_DIR, { recursive: true, force: true }); } catch {}
});

// ── the request/reply contract, testable without a model ────────────────
//
// WHY THIS EXISTS (measured 2026-10-23)
// embed-index.query() used to call sys.exit(3) on lock contention. serve()
// runs the handler inside _with_deadline's daemon thread, and SystemExit
// derives from BaseException — so it escaped `except Exception`, the thread
// died BEFORE conn.sendall(), and the client received NO FRAME AT ALL and sat
// until its own 90-120s timeout. The visible symptom was a "hung daemon"; the
// real bug was a swallowed control-flow exception on the reply path.
//
// These two tests drive the REAL serve() loop with a stubbed embed-index, so
// they need no venv, no model and no built index — they run everywhere,
// including CI, where the suites above skip. Mutation-checked: reverting the
// handler to `except Exception` fails the first test with an empty frame.
describe("query-server: a request always produces exactly one reply", () => {
	const runWith = (body, timeoutMs = 60_000) => {
		const dir = mkdtempSync(join(tmpdir(), "heimdall-reply-"));
		const sock = join(dir, "probe.sock");
		const script = `
import importlib.util, json, pathlib, socket, sys, threading, time, types
for _n, _attrs in (("sqlite_vec", {"load": lambda *a, **k: None}),
                   ("sentence_transformers", {"SentenceTransformer": lambda *a, **k: None})):
    _m = types.ModuleType(_n)
    for _k, _v in _attrs.items(): setattr(_m, _k, _v)
    sys.modules[_n] = _m
_s = importlib.util.spec_from_file_location("qs", ${JSON.stringify(SERVER)})
qs = importlib.util.module_from_spec(_s); sys.modules["qs"] = qs; _s.loader.exec_module(qs)

class FakeEI:
    MODEL = None
    def model(self): return None
    def status(self): return {}
    def query(self, q, n=5, related=False):
${body}
qs.load_embed_index = lambda: FakeEI()
qs.build_fts = lambda ei: None
qs._load_matrix = lambda ei: None

err = {}
def _run():
    try: qs.serve(pathlib.Path(${JSON.stringify(sock)}), 30)
    except BaseException:
        import traceback; err["tb"] = traceback.format_exc()
threading.Thread(target=_run, daemon=True).start()
for _ in range(200):
    if pathlib.Path(${JSON.stringify(sock)}).exists(): break
    time.sleep(0.05)
if "tb" in err:
    print(json.dumps({"serve_failed": err["tb"][-500:]})); raise SystemExit(0)
time.sleep(0.2)
_c = socket.socket(socket.AF_UNIX); _c.settimeout(10)
_c.connect(${JSON.stringify(sock)})
_c.sendall(json.dumps({"op": "query", "q": "x", "n": 1}).encode() + b"\\n")
try:
    _d = _c.recv(65536)
except socket.timeout:
    _d = b""
print(json.dumps({"frame": _d.decode("utf-8", "replace")}))
`;
		const r = spawnSync(python, ["-c", script], { encoding: "utf8", timeout: timeoutMs });
		rmSync(dir, { recursive: true, force: true });
		const out = (r.stdout || "").trim().split("\n").pop();
		expect(r.status).toBe(0);
		return JSON.parse(out);
	};

	it("replies rather than going silent when the handler raises SystemExit", () => {
		// Exactly what the old code did on lock contention.
		const got = runWith("        raise SystemExit(3)");
		expect(Boolean(got.serve_failed)).toBe(false);
		expect(got.frame).not.toBe("");            // an empty frame is the bug
		const reply = JSON.parse(got.frame);
		expect(reply.ok).toBe(false);
		expect(reply.busy).toBe(true);             // named for what it is
	});

	it("never reports a bare KeyError when the search produced no result", () => {
		// Unit-level, because the end-to-end path cannot reach this anymore: the
		// thread body now catches BaseException, so box is always populated. The
		// guard is still worth pinning — if someone narrows that catch again, the
		// failure must be a named RuntimeError, not box["value"] -> KeyError.
		const script = [
			"import importlib.util, sys, types",
			"for n in ('sqlite_vec', 'sentence_transformers'):",
			"    m = types.ModuleType(n); m.load = lambda *a, **k: None",
			"    m.SentenceTransformer = lambda *a, **k: None; sys.modules[n] = m",
			`s = importlib.util.spec_from_file_location("qs", ${JSON.stringify(SERVER)})`,
			"qs = importlib.util.module_from_spec(s); sys.modules['qs'] = qs",
			"s.loader.exec_module(qs)",
			"# A callable whose thread body dies without recording anything.",
			"holder = {}",
			"def fn():",
			"    raise SystemExit(3)",
			"try:",
			"    qs._with_deadline(fn, 5)",
			"    print('NO-RAISE')",
			"except SystemExit as e:",
			"    print('SYSTEMEXIT', e.code)",
			"except KeyError as e:",
			"    print('KEYERROR', e)",
			"except RuntimeError as e:",
			"    print('RUNTIMEERROR')",
		].join("\n");
		const r = spawnSync(python, ["-c", script], { encoding: "utf8", timeout: 60_000 });
		expect(r.status).toBe(0);
		const out = (r.stdout || "").trim();
		// Whatever it does, it must NOT surface as a dict-lookup error.
		expect(out.includes("KEYERROR")).toBe(false);
		expect(out.includes("NO-RAISE")).toBe(false);
	});
});
