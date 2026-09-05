// tests/insert-retention.test.mjs — issue #7 contract: `heimdall insert`
// must persist body + keywords durably (fact card file), regardless of
// venv presence. The semantic upsert is best-effort; the FILE is the record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEIMDALL_JS = join(ROOT, "bin", "heimdall.js");

function runInsert(home) {
	return spawnSync(process.execPath, [HEIMDALL_JS, "insert",
		"--title", "retention probe",
		"--body", "XYZZY-RETENTION-BODY unique marker content",
		"--keywords", "probe,retention-test"], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },  // isolated facts dir
		timeout: 120_000,
	});
}

test("insert persists body and keywords in fact card (no venv needed)", () => {
	const home = mkdtempSync(join(tmpdir(), "insert-retention-"));
	try {
		const r = runInsert(home);
		assert.equal(r.status, 0, `insert failed: ${r.stderr}`);
		const out = r.stdout.match(/fact recorded: (\S+)/);
		assert.ok(out, `no fact path in stdout: ${r.stdout} ${r.stderr}`);
		assert.ok(existsSync(out[1]), "fact file missing");
		const text = readFileSync(out[1], "utf8");
		assert.ok(text.includes("XYZZY-RETENTION-BODY"), "body lost");
		assert.ok(text.includes("probe, retention-test"), "keywords lost");
		assert.ok(text.includes("# retention probe"), "title lost");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
