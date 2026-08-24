// index-bootstrap — `heimdall index`: one-command corpus bootstrap for a new
// user. Discovers git repos under $HOME (depth-bounded), runs `graft build`
// in each (per-repo code graph; skipped if graft CLI absent), then runs
// embed-index.py build once for the global semantic index. Every failure
// degrades to a per-repo "skipped" line — indexing is best-effort by design.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const BIN_DIR = join(dirname(new URL(import.meta.url).pathname), "..");

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
 */
export function runIndex({ root = homedir(), embedScript = null, quietGraft = false } = {}) {
	const repos = discoverRepos(root);
	const hasGraft = graftAvailable();
	const results = [];

	for (const repo of repos) {
		if (!hasGraft) {
			results.push({ repo, status: "skipped", detail: "graft unavailable — npm i -g @nanonets/graft" });
			continue;
		}
		try {
			spawnSync("graft", ["build"], { cwd: repo, stdio: "ignore", timeout: 120_000 });
			results.push({ repo, status: "ok", detail: "graft graph built" });
		} catch {
			results.push({ repo, status: "failed", detail: "graft build error" });
		}
	}

	// global embed index (best-effort; needs ~/.heimdall/venv)
	let embedNote = "embed: skipped";
	const py = join(homedir(), ".heimdall", "venv", "bin", "python3");
	const script = embedScript ?? join(BIN_DIR, "embed-index.py");
	if (existsSync(py) && existsSync(script)) {
		try {
			spawnSync(py, [script, "build"], { stdio: "ignore", timeout: 600_000 });
			embedNote = "embed: global.db built/updated";
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
