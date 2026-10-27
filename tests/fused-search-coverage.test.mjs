// fused-search-coverage.test.mjs — a degraded reply must not look complete.
//
// WHY THIS EXISTS (measured 2026-10-23)
// fused_search() runs two legs (lexical + semantic) and caught every exception
// from the semantic one:
//
//     except Exception as e:
//         print("WARN: semantic layer failed — results are LEXICAL-ONLY", file=sys.stderr)
//
// then returned the lexical-only set. handle_request wrapped that in
// {"ok": True, "hits": ...}, so the reply was IDENTICAL to a healthy one that
// simply had no semantic hits. The "degraded" warning went to stderr — a
// human-facing side channel a socket client never reads.
//
// Found by running all 65 test files concurrently: contention pushed the
// semantic leg past its 10s deadline, fused_search degraded to lexical-only, and
// fast-search's "both legs represented" assertion failed with ok:true. The
// product behaviour (degrade rather than fail) is correct; presenting a partial
// answer as a complete one is not.
//
// These tests need no venv: they drive fused_search directly with a stubbed
// semantic leg, so they also run in CI where the neighbouring suites skip.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(REPO, "bin", "query-server.py");
const PY = plainPython();

// Drive the real fused_search with a fake ei whose semantic leg either works or
// throws, and print what coverage it reported.
function runCoverage({ semanticFails }) {
	const script = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("qs", ${JSON.stringify(SERVER)})
qs = importlib.util.module_from_spec(spec); spec.loader.exec_module(qs)

def lexical_hits(ei, q, n, scope=None):
    return [{"title": "t", "path": "/lex.py", "score": 1.0, "body": "b", "leg": "lexical"}]
qs.lexical_hits = lexical_hits

class EI: pass
def sem(ei, q, n=6, related=False):
    if ${semanticFails ? "True" : "False"}:
        raise qs.DeadlineExceeded("search exceeded the 10s deadline")
    return [{"title": "s", "path": "/sem.py", "score": 1.0}]
qs._semantic_hits = sem

hits = qs.fused_search(EI(), "q", n=6)
print(json.dumps({"coverage": qs._SEM_COVERAGE, "legs": sorted({h["leg"] for h in hits})}))
`;
	const r = spawnSync(PY, ["-c", script], { encoding: "utf8", timeout: 120_000 });
	return { out: r.stdout.trim(), err: r.stderr, status: r.status };
}

describe("fused_search reports whether both legs actually ran", () => {
	it("reports coverage=ok and both legs when the semantic leg works", () => {
		const { out, status } = runCoverage({ semanticFails: false });
		expect(status).toBe(0);
		const r = JSON.parse(out);
		expect(r.coverage).toBe("ok");
		expect(r.legs).toEqual(["lexical", "semantic"]);
	});

	it("reports coverage=degraded when the semantic leg fails", () => {
		const { out, status } = runCoverage({ semanticFails: true });
		expect(status).toBe(0);
		const r = JSON.parse(out);
		// Still returns hits (degrading is correct), but says so.
		expect(r.coverage).toBe("degraded");
		expect(r.legs).toEqual(["lexical"]);
	});

	it("resets the flag per request so a stale degraded cannot leak", () => {
		// A module-level flag that is only ever set to "degraded" would mark every
		// later healthy request as degraded too.
		const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("qs", ${JSON.stringify(SERVER)})
qs = importlib.util.module_from_spec(spec); spec.loader.exec_module(qs)
qs.lexical_hits = lambda ei, q, n, scope=None: [{"title":"t","path":"/l.py","score":1.0,"body":"b","leg":"lexical"}]
calls = {"n": 0}
def sem(ei, q, n=6, related=False):
    calls["n"] += 1
    if calls["n"] == 1:
        raise qs.DeadlineExceeded("boom")
    return [{"title":"s","path":"/s.py","score":1.0}]
qs._semantic_hits = sem
class EI: pass
qs.fused_search(EI(), "q"); first = qs._SEM_COVERAGE
qs.fused_search(EI(), "q"); second = qs._SEM_COVERAGE
print(json.dumps({"first": first, "second": second}))
`;
		const r = spawnSync(PY, ["-c", script], { encoding: "utf8", timeout: 120_000 });
		expect(r.status).toBe(0);
		const res = JSON.parse(r.stdout.trim());
		expect(res.first).toBe("degraded");
		expect(res.second).toBe("ok");
	});

	it("puts coverage into the socket reply, not just stderr", () => {
		// The whole defect: the client only ever sees the reply.
		const src = readFileSync(SERVER, "utf8");
		expect(src).toMatch(/"sem_coverage":\s*_SEM_COVERAGE/);
	});
});
