// postinstall.mjs — best-effort auto-setup after `npm i -g @arihantdeva/heimdall`.
// Three jobs, all fire-and-forget:
//   1. wire enforcement stacks into detected harnesses (sync, fast)
//   2. ensure graftd is present (find existing or build from source)
//   3. spawn a DETACHED background `heimdall index` so the user's memory
//      corpus builds while they keep working (never blocks npm install)
// Every error is swallowed; opt out with HEIMDALL_NO_AUTOINIT=1. npm must
// never see a nonzero exit from this script.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

if (process.env.HEIMDALL_NO_AUTOINIT === "1") {
	process.exit(0);
}

try {
	const HERE = dirname(fileURLToPath(import.meta.url));   // bin/
	const ROOT = dirname(HERE);                              // repo root
	const heimdallJs = join(HERE, "heimdall.js");
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

	// 2. Ensure graftd is present (synchronous, bounded by HEIMDALL_BUILD_TIMEOUT_MS).
	const { ensureGraftd } = await import("./lib/graft-build.mjs");
	const { detectHardware, writeProbeConfig } = await import("./lib/setup.mjs");
	const home = process.env.HOME ?? os.homedir();
	const logFile = join(home, ".heimdall", "bootstrap.log");
	try { mkdirSync(join(home, ".heimdall"), { recursive: true }); } catch { /* best effort */ }

	if (process.env.HEIMDALL_NO_BUILD === "1") {
		console.log("[heimdall] graftd build skipped (HEIMDALL_NO_BUILD=1)");
	} else {
		const hw = detectHardware();
		const { configPath, cleanup: cleanupProbe } = writeProbeConfig();
		try {
			const result = await ensureGraftd({
				configPath,
				accel: hw.accel,
				allowBuild: true,
				log: (msg) => console.log(msg),
				env: process.env,
				home,
				pkgRoot: ROOT,
			});
			if (result.ok) {
				if (result.source === "built") {
					const secs = Math.round((result.elapsedMs ?? 0) / 1000);
					console.log(`[heimdall] graftd ready: ${result.path} (built in ${secs}s)`);
				} else if (result.source === "installed") {
					console.log(`[heimdall] graftd ready: ${result.path} (installed from ${result.from})`);
				} else {
					console.log(`[heimdall] graftd ready: ${result.path} (existing)`);
				}
			} else {
				console.log(result.message ?? "SETUP NEEDED\nRun: heimdall setup");
			}
		} finally {
			cleanupProbe();
		}
	}

	// 3. detached background bootstrap index (graft build per repo + embed build).
	//    Logs to ~/.heimdall/bootstrap.log; survives npm exiting.
	const log = openSync(logFile, "a");
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
