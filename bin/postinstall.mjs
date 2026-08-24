// postinstall.mjs — best-effort auto-setup after `npm i -g @arihantdeva/heimdall`.
// Detects installed harnesses and wires their adapters WITHOUT any network,
// interactivity, or failure surface: every error is swallowed (opt-out via
// HEIMDALL_NO_AUTOINIT=1). npm must never see a nonzero exit from this.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.HEIMDALL_NO_AUTOINIT === "1") {
	process.exit(0);
}

try {
	const heimdallJs = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "heimdall.js");
	const res = spawnSync(process.execPath, [heimdallJs, "init", "--harness", "all", "--quiet"], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env },
	});
	if (res.stdout?.trim()) console.log("[heimdall] enforcement stacks wired:", res.stdout.trim().split("\n").join(", "));
	// non-zero from init is fine here — install still succeeds
} catch {
	// never fail the install
}
process.exit(0);
