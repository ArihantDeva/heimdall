// postinstall.mjs — best-effort auto-setup after `npm i -g @arihantdeva/heimdall`.
// Two jobs, both fire-and-forget:
//   1. wire enforcement stacks into detected harnesses (sync, fast)
//   2. spawn a DETACHED background `heimdall index` so the user's memory
//      corpus builds while they keep working (never blocks npm install)
// Every error is swallowed; opt out with HEIMDALL_NO_AUTOINIT=1. npm must
// never see a nonzero exit from this script.
import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.HEIMDALL_NO_AUTOINIT === "1") {
	process.exit(0);
}

try {
	const heimdallJs = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "heimdall.js");
	const wired = [];

	// 1. sync wiring — only for harnesses actually detected on this machine.
	//    Wiring all blindly would litter $HOME and poison --detect forever.
	const det = spawnSync(process.execPath, [heimdallJs, "init", "--detect"], {
		encoding: "utf8",
		timeout: 15_000,
	});
	const found = (det.stdout ?? "").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("("));
	for (const h of found) {
		const r = spawnSync(process.execPath, [heimdallJs, "init", "--harness", h, "--quiet"], {
			encoding: "utf8",
			timeout: 30_000,
		});
		if (r.status === 0) wired.push(h);
	}
	if (wired.length) console.log(`[heimdall] enforcement stacks wired: ${wired.join(", ")}`);

	// 2. detached background bootstrap index (graft build per repo + embed build).
	//    Logs to ~/.heimdall/bootstrap.log; survives npm exiting.
	const log = openSync(join(process.env.HOME ?? ".", ".heimdall", "bootstrap.log"), "a");
	const child = spawn(process.execPath, [heimdallJs, "index"], {
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env },
	});
	child.unref();
	console.log("[heimdall] indexing your repos in the background (~/.heimdall/bootstrap.log) — search gets better as it fills.");
} catch {
	// never fail the install
}
process.exit(0);
