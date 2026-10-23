// stale-node-absence-and-mass-guard.test.mjs — the graph's delete path.
//
// WHY THIS EXISTS (measured 2026-10-23)
// kb-stale-scan.py decides a node is dead with `not os.path.exists(p)` and then
// runs `graft delete` on it. Two independent problems:
//
//   1. os.path.exists() returns False for a permission error, an I/O error or a
//      dead symlink — not only for absence. Reproduced: chmod 000 on a parent
//      directory makes exists() false while the file is still there, so the
//      node was deleted with its file present on disk.
//   2. The delete loop had NO bound of any kind. A wrong DB path, an unmounted
//      volume or an unreadable tree makes every path look dead at once and the
//      whole graph goes in one silent pass.
//
// These are the same class as the SQL pruner bugs fixed earlier the same day, on
// the other destructive sink.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const python = plainPython();
const SCRIPT = join(REPO, "bin", "kb-stale-scan.py");

// Drive the real helper, not a copy of its logic.
const absentProbe = () => {
	const dir = mkdtempSync(join(tmpdir(), "heimdall-absent-"));
	const present = join(dir, "here.md");
	const gone = join(dir, "gone.md");
	const lockedDir = join(dir, "locked");
	writeFileSync(present, "x");
	mkdirSync(lockedDir);
	const inside = join(lockedDir, "f.md");
	writeFileSync(inside, "y");
	chmodSync(lockedDir, 0o000);
	const code = [
		"import importlib.util, json, sys",
		`s = importlib.util.spec_from_file_location("ks", ${JSON.stringify(SCRIPT)})`,
		"m = importlib.util.module_from_spec(s); sys.modules['ks'] = m; s.loader.exec_module(m)",
		`print(json.dumps({`,
		`  "present": m._definitely_absent(${JSON.stringify(present)}),`,
		`  "gone": m._definitely_absent(${JSON.stringify(gone)}),`,
		`  "locked": m._definitely_absent(${JSON.stringify(inside)}),`,
		"}))",
	].join("\n");
	const r = spawnSync(python, ["-c", code], { encoding: "utf8", timeout: 60_000 });
	try { chmodSync(lockedDir, 0o755); } catch {}
	rmSync(dir, { recursive: true, force: true });
	expect(r.status).toBe(0);
	return JSON.parse((r.stdout || "").trim().split("\n").pop());
};

describe("stale scan: deletion is bounded and never guesses", () => {
	it("only a provably absent path counts as dead", () => {
		const got = absentProbe();
		expect(got.present).toBe(false);   // there -> keep
		expect(got.gone).toBe(true);       // ENOENT -> delete is correct
	});

	it("an unreadable path is KEPT, not treated as missing", () => {
		// This is the bug: os.path.exists() said False here, so the node was
		// deleted while the file sat on disk. A stat-based check sees EACCES and
		// must answer "not provably absent".
		const got = absentProbe();
		expect(got.locked).toBe(false);
	});

	it("the scan refuses to delete most of the graph in one pass", () => {
		const src = readFileSync(SCRIPT, "utf8");
		expect(src).toMatch(/MASS_DELETE_FRACTION\s*=\s*0\.5/);
		expect(src).toMatch(/HEIMDALL_PRUNE_ALLOW_MASS/);
		// The refusal must happen BEFORE the graft delete call.
		const iGuard = src.indexOf("REFUSING to delete");
		const iDelete = src.indexOf('"graft", "delete"');
		expect(iGuard).toBeGreaterThan(-1);
		expect(iDelete).toBeGreaterThan(-1);
		expect(iGuard).toBeLessThan(iDelete);
	});

	it("the guard is opt-in: an unset variable refuses", () => {
		// A guard that defaults to permissive protects nobody. Check the whole
		// condition, not just the presence of a `!= "1"` somewhere: an earlier
		// version of this test passed a mutation that renamed the variable to
		// HEIMDALL_BLOCK_MASS (opt-out semantics) because the shape `!= "1"`
		// was unchanged.
		const src = readFileSync(SCRIPT, "utf8");
		const iGuard = src.indexOf("REFUSING to delete");
		const cond = src.slice(src.lastIndexOf("if total", iGuard), iGuard);
		expect(cond).toMatch(/HEIMDALL_PRUNE_ALLOW_MASS/);   // the agreed name
		expect(cond).toMatch(/!= "1"/);                      // set-to-force
	});

	it("the scan CALLS the absence helper, not os.path.exists", () => {
		// The helper being correct is worthless if the caller still uses
		// os.path.exists. An earlier version of this file only probed the
		// helper, so reverting the caller to the original bug still passed.
		const src = readFileSync(SCRIPT, "utf8");
		expect(src).toMatch(/_definitely_absent\(p\)/);
		// and the old shape must be gone from the dead-path computation
		expect(src).not.toMatch(/dead\s*=\s*\[p for p in paths if not os\.path\.exists\(p\)\]/);
	});

	it("still deletes a genuinely dead node", () => {
		// Over-correcting would turn the scanner into a no-op and leave dead
		// nodes in the graph forever. The delete call must remain reachable.
		const src = readFileSync(SCRIPT, "utf8");
		expect(src).toMatch(/subprocess\.run\(\["graft", "delete", id_hex\]/);
	});
});
