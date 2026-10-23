// prune-mass-delete-guard.test.mjs — no single build may silently delete the
// whole index.
//
// WHY THIS EXISTS (measured 2026-10-23)
// Three separate error-path bugs that day each fed _prune_stale a wrong `seen`:
// an unchecked find, an unreadable vector dimension, a failed stat(). Each was
// fixed on its own, but the CLASS remained: _prune_stale trusts whatever `seen`
// it is given, and `known` is the entire index (135,213 cards on this machine).
// bin/embed-index.py resolves HOME_ROOT from $HEIMDALL_HOME and never validates
// it, so pointing that at a wrong or half-mounted path makes the walk return
// nothing, `seen` empty, and _prune_stale deletes EVERY ROW.
//
// A circuit breaker belongs at the chokepoint, not at each caller: mass
// deletion is never something one build should do quietly.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const python = plainPython();

// Drives the REAL _prune_stale against a real in-memory sqlite schema.
const run = (seenFraction, env = {}) => {
	const script = [
		"import importlib.util, json, os, sqlite3, sys, tempfile, types",
		`sys.path.insert(0, ${JSON.stringify(join(REPO, "bin"))})`,
		"for n in ('sqlite_vec', 'sentence_transformers'):",
		"    m = types.ModuleType(n); m.load = lambda *a, **k: None",
		"    m.SentenceTransformer = lambda *a, **k: None; sys.modules[n] = m",
		`s = importlib.util.spec_from_file_location("ei", ${JSON.stringify(join(REPO, "bin", "embed-index.py"))})`,
		"ei = importlib.util.module_from_spec(s); sys.modules['ei'] = ei",
		"s.loader.exec_module(ei)",
		"import pathlib",
		"ei.STATE_PATH = pathlib.Path(tempfile.mktemp(suffix='.json'))",
		"N = 100",
		"c = sqlite3.connect(':memory:')",
		"c.execute('CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT, title TEXT, body TEXT, sha1 TEXT, root TEXT, mtime REAL, size INTEGER)')",
		"c.execute('CREATE TABLE vec (x)')",
		"for i in range(N):",
		"    c.execute('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?)', (f'id{i}', f'/p/{i}', 't', 'b', 's', '/p', 0.0, 1))",
		"    c.execute('INSERT INTO vec VALUES (?)', (i,))",
		"c.commit()",
		"known = {f'id{i}': (f'id{i}', 0.0, 1) for i in range(N)}",
		`keep = int(N * ${seenFraction})`,
		"seen = {f'id{i}' for i in range(keep)}",
		"ei._prune_stale(c, known, seen)",
		"print(json.dumps({'remaining': c.execute('SELECT count(*) FROM cards').fetchone()[0], 'N': N}))",
	].join("\n");
	const r = spawnSync(python, ["-c", script], {
		encoding: "utf8", timeout: 60_000,
		env: { ...process.env, ...env },
	});
	expect(r.status).toBe(0);
	return JSON.parse((r.stdout || "").trim().split("\n").pop());
};

describe("prune: one build cannot delete the whole index", () => {
	it("refuses when every card looks vanished (the wrong-HEIMDALL_HOME case)", () => {
		// seen empty -> without the guard this deletes 100/100.
		const got = run(0);
		expect(got.remaining).toBe(got.N);
	});

	it("refuses when most of the index looks vanished", () => {
		const got = run(0.1);          // 90% stale
		expect(got.remaining).toBe(got.N);
	});

	it("still prunes a normal amount of churn", () => {
		// Guard against over-correcting: if this refused a 2% prune, the index
		// would grow forever and dead rows would keep surfacing in k-NN.
		const got = run(0.98);         // 2% stale
		expect(got.remaining).toBe(98);
	});

	it("allows a mass prune when it is explicitly intended", () => {
		const got = run(0, { HEIMDALL_PRUNE_ALLOW_MASS: "1" });
		expect(got.remaining).toBe(0);
	});

	it("refuses by default, i.e. the env var is opt-IN not opt-out", () => {
		// A guard that defaults to permissive protects nobody.
		const got = run(0, { HEIMDALL_PRUNE_ALLOW_MASS: "" });
		expect(got.remaining).toBe(got.N);
	});
});
