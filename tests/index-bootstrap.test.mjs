// index-bootstrap — `heimdall index`: discover git repos under ~/, graft-build
// each, embed-build global.db. Tolerates missing graft CLI; prints summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const HEIMDALL = join(repo, "bin", "heimdall.js");

test("index: discovers git repos under HOME, tolerates missing graft, exits 0 with summary", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-index-"));
	try {
		// two fake git repos
		for (const name of ["alpha", "beta"]) {
			const r = join(home, "Repos", name);
			mkdirSync(join(r, "src"), { recursive: true });
			writeFileSync(join(r, "src", "main.js"), "export const x = 1;\n");
			mkdirSync(join(r, ".git"), { recursive: true });
		}
		// non-repo dir must be ignored
		mkdirSync(join(home, "Repos", "not-a-repo"), { recursive: true });

		const r = spawnSync(process.execPath, [HEIMDALL, "index"], {
			encoding: "utf8",
			env: { ...process.env, HOME: home },
			timeout: 120_000,
		});
		assert.equal(r.status, 0, `stderr: ${r.stderr}`);
		assert.match(r.stdout, /alpha/);
		assert.match(r.stdout, /beta/);
		assert.doesNotMatch(r.stdout, /not-a-repo/);
		assert.match(r.stdout + r.stderr, /(graft unavailable|cards|indexed|skipped|graft graph built|embed:)/i);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, { timeout: 150_000 });

test("index --home override + json output", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-index-"));
	try {
		mkdirSync(join(home, "work", "gamma", ".git"), { recursive: true });
		const r = spawnSync(process.execPath, [HEIMDALL, "index", "--json", "--root", home], {
			encoding: "utf8",
			env: { ...process.env, HOME: home },
			timeout: 120_000,
		});
		assert.equal(r.status, 0, r.stderr);
		const parsed = JSON.parse(r.stdout);
		assert.ok(Array.isArray(parsed.repos));
		assert.ok(parsed.repos.some((x) => x.repo.endsWith("gamma")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, { timeout: 150_000 });
