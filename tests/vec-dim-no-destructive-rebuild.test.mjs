// vec-dim-no-destructive-rebuild.test.mjs — an unreadable dimension must never
// authorize a DROP TABLE.
//
// WHY THIS EXISTS (measured 2026-10-23)
// _db_dim() returned -1 for three different situations:
//     no vec table at all          -> -1   (a rebuild is correct and additive)
//     vec present, dimension wrong -> N    (a rebuild is correct)
//     vec present, DDL unparseable -> -1   (a rebuild DESTROYS every card)
// init() branches on `_db_dim(c) != DIM` and, on a mismatch, DROPs `cards`.
// Reproduced: a healthy 768-dim index whose `vec` DDL spelled the dimension
// float32[768] (a form vec0 accepts) parsed as -1, so init() dropped `cards`
// and lost all 500 rows even though the dimension was never wrong.
//
// The fix separates the sentinels: -1 means "absent", -2 means "unreadable",
// and the destructive path calls _db_dim_strict(), which raises rather than
// guessing. The test pins the DISTINCTION, which is the whole bug.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const python = plainPython();

// Drives the real module. sqlite_vec / sentence_transformers are stubbed at
// module top, so no venv, no model and no extension loading are needed — this
// runs on any python3, including in CI.
const probe = () => {
	const script = [
		"import importlib.util, json, os, sqlite3, sys, tempfile, types",
		`sys.path.insert(0, ${JSON.stringify(join(REPO, "bin"))})`,
		"for n in ('sqlite_vec', 'sentence_transformers'):",
		"    m = types.ModuleType(n); m.load = lambda *a, **k: None",
		"    m.SentenceTransformer = lambda *a, **k: None; sys.modules[n] = m",
		`s = importlib.util.spec_from_file_location("ei", ${JSON.stringify(join(REPO, "bin", "embed-index.py"))})`,
		"ei = importlib.util.module_from_spec(s); sys.modules['ei'] = ei",
		"s.loader.exec_module(ei)",
		"cases = [",
		"    ('absent', None),",
		"    ('canonical', 'CREATE TABLE vec (embedding float[768])'),",
		"    ('float32',   'CREATE TABLE vec (embedding float32[768])'),",
		"    ('spaces',    'CREATE TABLE vec (embedding float[ 768 ])'),",
		"    ('garbage',   'CREATE TABLE vec (id INTEGER)'),",
		"]",
		"out = {}",
		"for label, ddl in cases:",
		"    p = tempfile.mktemp(suffix='.db'); c = sqlite3.connect(p)",
		"    if ddl: c.execute(ddl)",
		"    d = ei._db_dim(c)",
		"    try:",
		"        strict = ei._db_dim_strict(c)",
		"    except RuntimeError:",
		"        strict = 'RAISE'",
		"    out[label] = {'dim': d, 'strict': strict}",
		"    c.close(); os.unlink(p)",
		"print(json.dumps(out))",
	].join("\n");
	const r = spawnSync(python, ["-c", script], { encoding: "utf8", timeout: 60_000 });
	expect(r.status).toBe(0);
	return JSON.parse((r.stdout || "").trim().split("\n").pop());
};

describe("vec dimension: an unreadable dimension must not authorize a rebuild", () => {
	it("accepts every spelling vec0 accepts, so a healthy index is not misread", () => {
		const got = probe();
		// The bug: float32[768] parsed as -1 and triggered a full rebuild.
		expect(got.canonical.dim).toBe(768);
		expect(got.float32.dim).toBe(768);
		expect(got.spaces.dim).toBe(768);
	});

	it("reports absence and unreadability as DIFFERENT values", () => {
		const got = probe();
		expect(got.absent.dim).toBe(-1);                 // absent: rebuild is safe
		expect(got.garbage.dim).not.toBe(-1);            // unreadable is NOT absent
		expect(got.garbage.dim).toBe(-2);
	});

	it("raises instead of guessing on the path that drops tables", () => {
		const got = probe();
		// init() calls _db_dim_strict(). For an absent vec it must proceed (-1);
		// for an unreadable one it must refuse, because proceeding means DROP.
		expect(got.absent.strict).toBe(-1);
		expect(got.garbage.strict).toBe("RAISE");
	});

	it("init() uses the strict reader, not the lenient one", () => {
		// Structural guard: if someone swaps _db_dim_strict back to _db_dim in
		// init(), the raise above stops protecting the DROP TABLEs.
		const src = spawnSync("cat", [join(REPO, "bin", "embed-index.py")], { encoding: "utf8" }).stdout;
		const iInit = src.indexOf("def init(");
		const body = src.slice(iInit, src.indexOf("\ndef ", iInit + 5));
		expect(body).toMatch(/_db_dim_strict\s*\(/);
		expect(body).not.toMatch(/if\s+_db_dim\s*\(c\)\s*!=/);
	});
});
