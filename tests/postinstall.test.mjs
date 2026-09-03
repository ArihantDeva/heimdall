// postinstall — contract: never throws, respects opt-out, wires detected
// harnesses via init --harness all --quiet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const POSTINSTALL = join(repo, "bin", "postinstall.mjs");

function makeTmpBuildDir(home) {
	const d = join(home, "empty-build");
	mkdirSync(d, { recursive: true });
	return d;
}

function strippedBinDir(home) {
	const binDir = join(home, "stripped-bin");
	mkdirSync(binDir, { recursive: true });
	return binDir;
}

function run(home, extraEnv = {}) {
	// Always redirect HEIMDALL_BUILD_DIR to a temp dir so results never depend
	// on the checkout's vendor/graft/build binary.
	// Always strip PATH to a node-only dir so cmake/compiler are absent and no
	// build is attempted (fast, deterministic). Tests that need a real PATH or
	// a real binary can pass those via extraEnv (extraEnv spreads last).
	const buildDir = extraEnv.HEIMDALL_BUILD_DIR ?? makeTmpBuildDir(home);
	const strippedPath = extraEnv.PATH ?? strippedBinDir(home);
	return spawnSync(process.execPath, [POSTINSTALL], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, HEIMDALL_BUILD_DIR: buildDir, PATH: strippedPath, ...extraEnv },
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

// ---------------------------------------------------------------------------
// New tests for 0.9.0 graftd handling in postinstall
// ---------------------------------------------------------------------------

// Stripped PATH helper (no cmake, no compiler, no git)
function strippedPath(home) {
	const binDir = join(home, "empty-bin");
	mkdirSync(binDir, { recursive: true });
	return binDir;
}

test("postinstall: HEIMDALL_NO_BUILD=1 → output contains skipped message, exit 0", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-postinstall-"));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		const r = run(home, { HEIMDALL_NO_BUILD: "1" });
		assert.equal(r.status, 0, `stderr: ${r.stderr}`);
		assert.ok(
			(r.stdout ?? "").includes("HEIMDALL_NO_BUILD=1") ||
			(r.stdout ?? "").includes("skipped"),
			`expected skipped message in stdout: ${r.stdout}`,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("postinstall: working fake graftd at ~/.local/bin/graftd → output contains 'graftd ready' and 'existing', exit 0", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-postinstall-"));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		// Install a working fake graftd
		const graftdDir = join(home, ".local", "bin");
		mkdirSync(graftdDir, { recursive: true });
		writeFileSync(
			join(graftdDir, "graftd"),
			"#!/bin/sh\necho 'model_path: /nonexistent/probe.gguf'\necho 'hardware_accel: false'\nexit 0\n",
		);
		chmodSync(join(graftdDir, "graftd"), 0o755);

		// Stripped PATH so no toolchain (we want it to use existing, not build)
		const stripped = strippedPath(home);
		const r = run(home, { PATH: `${stripped}:${process.env.PATH}` });
		assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
		const out = r.stdout ?? "";
		assert.ok(
			out.includes("graftd ready") || out.includes("ready"),
			`expected 'ready' in stdout: ${out}`,
		);
		assert.ok(
			out.includes("existing"),
			`expected 'existing' in stdout: ${out}`,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("postinstall: broken graftd + no toolchain → output contains 'SETUP NEEDED', exit 0, broken file left in place", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-postinstall-"));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		// Install a broken fake graftd
		const graftdDir = join(home, ".local", "bin");
		mkdirSync(graftdDir, { recursive: true });
		const brokenPath = join(graftdDir, "graftd");
		writeFileSync(brokenPath, "#!/bin/sh\nexit 1\n");
		chmodSync(brokenPath, 0o755);

		// Stripped PATH: no cmake, no compiler, no git
		const stripped = strippedPath(home);
		const r = run(home, { PATH: stripped });
		assert.equal(r.status, 0, `postinstall must always exit 0; stderr: ${r.stderr}`);
		const out = (r.stdout ?? "") + (r.stderr ?? "");
		assert.ok(
			out.includes("SETUP NEEDED"),
			`expected SETUP NEEDED in output: ${out}`,
		);
		// Broken file should still exist (left in place, not deleted)
		assert.ok(existsSync(brokenPath), "broken graftd file should still be at original path");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("postinstall: broken canonical + working build-dir graftd → 'installed from', exit 0, .bak exists, canonical works", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-postinstall-"));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });

		// Broken canonical at $HOME/.local/bin/graftd
		const canonicalDir = join(home, ".local", "bin");
		mkdirSync(canonicalDir, { recursive: true });
		const canonical = join(canonicalDir, "graftd");
		writeFileSync(canonical, "#!/bin/sh\nexit 1\n");
		chmodSync(canonical, 0o755);

		// Working graftd at $HEIMDALL_BUILD_DIR/graftd
		const buildDir = join(home, "fake-build");
		mkdirSync(buildDir, { recursive: true });
		const buildGraftd = join(buildDir, "graftd");
		writeFileSync(
			buildGraftd,
			"#!/bin/sh\necho 'model_path: /nonexistent/probe.gguf'\necho 'hardware_accel: false'\nexit 0\n",
		);
		chmodSync(buildGraftd, 0o755);

		// Stripped PATH — no cmake/compiler/git, so a build would fail loudly
		const emptyBin = join(home, "empty-bin");
		mkdirSync(emptyBin, { recursive: true });

		const r = run(home, {
			HEIMDALL_BUILD_DIR: buildDir,
			PATH: emptyBin,
		});
		assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);

		const out = r.stdout ?? "";
		assert.ok(
			out.includes(`graftd ready: ${canonical} (installed from`),
			`expected 'graftd ready: ${canonical} (installed from' in stdout:\n${out}`,
		);

		// .bak file must exist (broken canonical was backed up)
		const files = readdirSync(canonicalDir);
		const bak = files.find((f) => f.startsWith("graftd.bak-"));
		assert.ok(bak != null, `no graftd.bak-* file in ${canonicalDir}: [${files.join(", ")}]`);

		// Canonical must now work (run it directly)
		const probe = spawnSync(canonical, ["--check-config", "/tmp/nonexistent.yaml"], {
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(probe.status, 0, `canonical graftd should exit 0 after install, got ${probe.status}`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
