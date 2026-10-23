// search-header-tells-truth.test.mjs — the search banner must not advertise a
// retrieval leg that is not configured.
//
// WHY THIS EXISTS (measured 2026-10-23)
// bin/kb-search.sh prints a header describing which legs will answer:
//
//     == retrieve (per-repo graft + global semantic): <query>
//
// On a machine without the semantic layer the very next line said
//
//     SEMANTIC_ERROR: not-configured (venv or global.db missing)
//
// so the banner promised a leg that the next line admitted was absent. Iteration
// 50 fixed exactly this lie on the daemon path, where "warm fused: lexical +
// semantic" was printed unconditionally; the non-daemon fallback still claimed
// both legs. A person reading the first line believes the answer fused semantic
// retrieval when it was lexical only.
//
// The wording is now decided by the SAME test that gates the leg (SEM_READY), so
// the banner and the leg cannot disagree. Both directions are pinned: claiming
// more than ran is a lie, and claiming less would be its own false alarm.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainPython } from "./lib/python.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "bin", "heimdall.js");
const PY = plainPython();

// A sandbox HOME with one indexed repo and a stub `graft`, so search reaches the
// banner instead of exiting early on "no repos".
function sandbox({ semantic }) {
	const home = mkdtempSync(join(tmpdir(), "heimdall-banner-"));
	mkdirSync(join(home, ".graft", "profiles", "default"), { recursive: true });
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	mkdirSync(join(home, "Repos", "demo", "graft"), { recursive: true });
	writeFileSync(join(home, "Repos", "demo", "notes.md"), "deployment notes\n");
	mkdirSync(join(home, "bin"), { recursive: true });
	writeFileSync(join(home, "bin", "graft"), "#!/bin/bash\nexit 0\n");
	chmodSync(join(home, "bin", "graft"), 0o755);

	if (semantic) {
		mkdirSync(join(home, ".heimdall", "venv", "bin"), { recursive: true });
		writeFileSync(join(home, ".heimdall", "venv", "bin", "python3"), "#!/bin/bash\nexit 0\n");
		chmodSync(join(home, ".heimdall", "venv", "bin", "python3"), 0o755);
		const r = spawnSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE cards (path TEXT)")
c.commit(); c.close()
`, join(home, ".heimdall", "global.db")], { encoding: "utf8", timeout: 60_000 });
		if (r.status !== 0) throw new Error(r.stderr);
	} else {
		mkdirSync(join(home, ".heimdall"), { recursive: true });
	}
	return home;
}

function search(home) {
	const r = spawnSync(process.execPath, [CLI, "search", "deployment"], {
		encoding: "utf8", timeout: 180_000,
		env: { ...process.env, HOME: home, GRAFT: join(home, "bin", "graft") },
	});
	return (r.stdout || "") + (r.stderr || "");
}

const banner = (out) => (out.split("\n").find((l) => l.startsWith("== retrieve")) || "");

describe("search banner: it claims exactly the legs that are configured", () => {
	it("does not advertise the semantic leg when it is not configured", () => {
		const out = search(sandbox({ semantic: false }));
		const b = banner(out);
		expect(b, "no banner found").toBeTruthy();
		// The lie: banner says "+ global semantic" while the next line says
		// SEMANTIC_ERROR: not-configured.
		expect(b).not.toMatch(/global semantic\)/);
		expect(b).toMatch(/NOT configured/);
	});

	it("says plainly that only the graft leg is answering", () => {
		const out = search(sandbox({ semantic: false }));
		expect(banner(out)).toMatch(/graft only/);
	});

	it("still advertises both legs when the semantic layer IS configured", () => {
		// Over-correcting into permanent pessimism would be its own defect: a
		// working install must not be told its semantic leg is missing.
		const out = search(sandbox({ semantic: true }));
		const b = banner(out);
		expect(b).toMatch(/per-repo graft \+ global semantic/);
		expect(b).not.toMatch(/NOT configured/);
	});

	it("the banner and the SEMANTIC_ERROR line never contradict each other", () => {
		// The invariant, stated independently of the wording: if the banner claims
		// the semantic leg, the same run must not report it as unconfigured.
		for (const semantic of [false, true]) {
			const out = search(sandbox({ semantic }));
			const claimsSemantic = /global semantic\)/.test(banner(out));
			const reportsMissing = /SEMANTIC_ERROR: not-configured/.test(out);
			expect(claimsSemantic && reportsMissing,
				`semantic=${semantic}: banner claims the leg while the run reports it missing —\n${out}`
			).toBe(false);
		}
	});
});
