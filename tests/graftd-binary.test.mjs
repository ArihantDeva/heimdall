// graftd-binary — asserts graftd has no dynamic llama/ggml deps, no RPATH/RUNPATH,
// and still works correctly after binary relocation to a fresh directory.
//
// Follows the same helper pattern and three-candidate lookup as setup.test.mjs.
// If none of the three candidate paths holds a graftd binary, every test skips
// silently — the same convention used by "rendered config passes graftd --check-config"
// in setup.test.mjs.  On the user's Mac, where a broken dynamic build exists, this
// test fails with the dyld error (the intended red state before the static fix).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync, rmSync, copyFileSync, chmodSync,
	writeFileSync, existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfig, defaultChoices } from "../bin/lib/setup.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function tmpHome() {
	const home = mkdtempSync(join(tmpdir(), "heimdall-graftd-"));
	return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// --- locate graftd (same three candidates as setup.test.mjs) ---
const graftd = [
	join(repo, "vendor", "graft", "build", "graftd"),
	join(process.env.HOME || "", "Repos", "graft-cpp", "build", "graftd"),
	join(process.env.HOME || "", ".local", "bin", "graftd"),
].find((p) => existsSync(p));

test("graftd is self-contained: no dynamic llama/ggml deps and runs after relocation", () => {
	if (!graftd) return; // binary not built yet — skip silently

	const platform = process.platform;

	// (i) No dynamic llama/ggml library dependency
	if (platform === "linux") {
		const lddOut = execFileSync("ldd", [graftd], { encoding: "utf8" });
		assert.doesNotMatch(lddOut, /libllama|libggml/,
			"ldd must show no libllama or libggml dynamic dependency");
	} else if (platform === "darwin") {
		const otoolOut = execFileSync("otool", ["-L", graftd], { encoding: "utf8" });
		assert.doesNotMatch(otoolOut, /libllama|libggml/,
			"otool -L must show no libllama or libggml dynamic dependency");
	}

	// (ii) No RPATH / RUNPATH entries
	if (platform === "linux") {
		const elfOut = execFileSync("readelf", ["-d", graftd], { encoding: "utf8" });
		assert.doesNotMatch(elfOut, /RPATH|RUNPATH/,
			"ELF dynamic section must have no RPATH or RUNPATH entry");
	} else if (platform === "darwin") {
		const otoolLOut = execFileSync("otool", ["-l", graftd], { encoding: "utf8" });
		assert.doesNotMatch(otoolLOut, /LC_RPATH/,
			"Mach-O must have no LC_RPATH load commands");
	}

	// (iii) Binary relocates: copy to a fresh temp dir and run --check-config there
	const { home, cleanup } = tmpHome();
	try {
		const hw = { platform: "linux", cores: 2, arm: false, accel: "cpu", instances: 1 };
		const cfg = join(home, "config.yaml");
		writeFileSync(cfg, renderConfig(hw, defaultChoices(hw, "/models/probe.gguf")));

		const relocBin = join(home, "graftd");
		copyFileSync(graftd, relocBin);
		chmodSync(relocBin, 0o755);

		const out = execFileSync(relocBin, ["--check-config", cfg], { encoding: "utf8" });
		assert.match(out, /model_path:/,
			"relocated graftd --check-config must print model_path:");
	} finally {
		cleanup();
	}
});
