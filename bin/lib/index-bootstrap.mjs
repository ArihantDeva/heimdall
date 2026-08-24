// index-bootstrap — `heimdall index`: one-command corpus bootstrap for a new
// user. Discovers git repos under $HOME (depth-bounded), runs `graft build`
// in each (per-repo code graph; skipped if graft CLI absent), then runs
// embed-index.py build once for the global semantic index. Every failure
// degrades to a per-repo "skipped" line — indexing is best-effort by design.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Depth-bounded git-repo discovery. Skips node_modules/.git/vendor/hidden dirs except .git itself. */
export function discoverRepos(root, { maxDepth = 3, maxRepos = 200 } = {}) {
	const out = [];
	const SKIP = new Set(["node_modules", ".venv", "venv", "dist", "build", "__pycache__", ".cache"]);
	const walk = (dir, depth) => {
		if (depth > maxDepth || out.length >= maxRepos) return;
		let entries;
		try { entries = readdirSync(dir); } catch { return; }
		for (const e of entries) {
			if (out.length >= maxRepos) return;
			if (e === ".git") {
				out.push(dir);
				continue;
			}
			if (e.startsWith(".") || SKIP.has(e)) continue;
			const p = join(dir, e);
			let st;
			try { st = statSync(p); } catch { continue; }
			if (st.isDirectory()) walk(p, depth + 1);
		}
	};
	walk(root, 0);
	return out;
}

function graftAvailable() {
	try {
		execFileSync("graft", ["--version"], { stdio: "ignore", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Build indexes. Returns { repos: [{repo, status, detail}], embed: string }.
 * root: where to scan (default HOME). embedScript: path to embed-index.py.
 * budgetMs: wall-clock cap for the whole run (default 20 min) — the postinstall
 * path runs this unattended, so it must self-terminate. Kill a running one:
 *   pkill -f 'heimdall.js index'
 */
export function runIndex({ root = homedir(), embedScript = null, budgetMs = 20 * 60_000 } = {}) {
	const deadline = Date.now() + budgetMs;
	const repos = discoverRepos(root);
	const hasGraft = graftAvailable();
	const results = [];

	for (const repo of repos) {
		if (Date.now() > deadline) {
			results.push({ repo, status: "skipped", detail: "time budget exhausted — rerun heimdall index" });
			continue;
		}
		if (!hasGraft) {
			results.push({ repo, status: "skipped", detail: "graft unavailable — npm i -g @nanonets/graft" });
			continue;
		}
	try {
		const r = spawnSync("graft", ["build"], { cwd: repo, stdio: "ignore", timeout: 120_000 });
		if (r.status !== 0 || r.error) {
			results.push({ repo, status: "failed", detail: r.error?.message ?? `graft build exit ${r.status}` });
		} else {
			results.push({ repo, status: "ok", detail: "graft graph built" });
		}
	} catch (e) {
		results.push({ repo, status: "failed", detail: e.message?.split("\n")[0] ?? "graft build error" });
	}
	}

	// global embed index (best-effort; needs ~/.heimdall/venv)
	let embedNote = "embed: skipped";
	const py = join(homedir(), ".heimdall", "venv", "bin", "python3");
	const script = embedScript ?? join(BIN_DIR, "embed-index.py");
	if (existsSync(py) && existsSync(script)) {
		try {
			const remaining = Math.max(60_000, deadline - Date.now());
			const r = spawnSync(py, [script, "build"], { stdio: "ignore", timeout: remaining });
			embedNote = r.status !== 0 || r.error ? `embed: failed (${r.error?.message ?? `exit ${r.status}`})` : "embed: global.db built/updated";
		} catch {
			embedNote = "embed: failed (see ~/.heimdall)";
		}
	} else if (!existsSync(script)) {
		embedNote = "embed: embed-index.py not found in package";
	} else {
		embedNote = "embed: venv missing (~/.heimdall/venv) — run heimdall doctor";
	}

	return { repos: results, embed: embedNote };
}
