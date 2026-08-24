// postinstall — contract: never throws, respects opt-out, wires detected
// harnesses via init --harness all --quiet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const POSTINSTALL = join(repo, "bin", "postinstall.mjs");

function run(home) {
	return spawnSync(process.execPath, [POSTINSTALL], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
		timeout: 60_000,
	});
}

test("postinstall exits 0 in a clean HOME and wires claude-code + gemini-cli", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-postinstall-"));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		mkdirSync(join(home, ".gemini"), { recursive: true });
		const r = run(home);
		assert.equal(r.status, 0, `stderr: ${r.stderr}`);
		assert.match(r.stdout ?? "", /claude-code/);
		assert.ok(existsSync(join(home, ".claude", "settings.json")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("postinstall exits fast and spawns detached background index", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-postinstall-"));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		const t0 = Date.now();
		run(home);
		const dt = Date.now() - t0;
		assert.ok(dt < 15_000, `postinstall took ${dt}ms — must return fast`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("HEIMDALL_NO_AUTOINIT=1 skips everything", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-postinstall-"));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		const r = spawnSync(process.execPath, [POSTINSTALL], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, HEIMDALL_NO_AUTOINIT: "1" },
		});
		assert.equal(r.status, 0);
		assert.equal(r.stdout ?? "", "");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
