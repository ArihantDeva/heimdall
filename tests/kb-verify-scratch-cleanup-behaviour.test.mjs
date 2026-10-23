// kb-verify-scratch-cleanup-behaviour.test.mjs — the cleanup must never delete
// a path it does not recognise.
//
// WHY THIS EXISTS (measured 2026-10-23)
// per-command-assignment-and-scratch-cleanup.test.mjs asserts the shape of the
// guard: that a `case` on ${HEIMDALL_SCRATCH:-} exists, that "".) does nothing,
// and that a `*)` branch is present. It never checks what `*)` DOES. Verified
// against the real script: replacing the refusal
//
//     *) printf 'refusing to remove unexpected scratch path: %s\n' ... >&2 ;;
//
// with
//
//     *) rm -rf "$HEIMDALL_SCRATCH" ;;
//
// — i.e. letting the unguarded branch delete anything it is handed — passes the
// whole suite, 10/10. Demonstrated concretely: with that branch, running the
// case statement against a directory of real data removes it.
//
// `printf ... >&2` versus `rm -rf` is the entire distance between a guard and a
// catastrophe, and only the presence of `*)` was pinned. Same class as the
// mass-delete breaker (#57): the shape was asserted, the behaviour was not.
//
// This extracts the REAL case block from bin/kb-verify.sh and executes it, so
// the branch bodies are what is tested — not a copy of them.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "kb-verify.sh");

// Pull the cleanup's `case ... esac` straight out of the script. Executing the
// extracted text is what makes this a behaviour test rather than a rewrite.
function cleanupBlock() {
	const raw = readFileSync(SCRIPT, "utf8");
	const start = raw.indexOf('case "${HEIMDALL_SCRATCH');
	if (start < 0) throw new Error("could not find the scratch cleanup case block");
	const end = raw.indexOf("esac", start);
	if (end < 0) throw new Error("could not find the end of the case block");
	return raw.slice(start, end + 4);
}

// Run the real cleanup against a given HEIMDALL_SCRATCH value inside a sandbox,
// and report whether the target directory survived.
function cleanup(target, env = {}) {
	const block = cleanupBlock();
	const r = spawnSync("/bin/bash", ["-c", block], {
		encoding: "utf8", timeout: 60_000,
		env: { ...process.env, HOME: tmpdir(), HEIMDALL_SCRATCH: target, ...env },
	});
	return { status: r.status, err: r.stderr || "", survived: existsSync(target) };
}

function scratchLike(name) {
	// A path shaped like the scratch dirs the script itself creates. It must sit
	// under /tmp or under ${TMPDIR:-/tmp}, because those are the two the guard
	// accepts — mkdtempSync(tmpdir(), ...) lands under macOS's per-user TMPDIR,
	// which matches the second glob only when TMPDIR is passed through.
	const base = name.startsWith("kbverify-home-") ? "/tmp" : tmpdir();
	const d = mkdtempSync(join(base, name));
	writeFileSync(join(d, "proof"), "x");
	return d;
}

describe("kb-verify scratch cleanup: unrecognised paths are never removed", () => {
	it("removes a real /tmp/kbverify-home-* scratch dir", () => {
		const d = scratchLike("kbverify-home-");
		const got = cleanup(d);
		expect(got.survived, `scratch dir was not cleaned up`).toBe(false);
	});

	it("does nothing when the variable is empty", () => {
		// `rm -rf ""` is at best a no-op and at worst something far worse; the
		// empty branch must stay empty.
		const r = spawnSync("/bin/bash", ["-c", cleanupBlock()], {
			encoding: "utf8", timeout: 60_000,
			env: { ...process.env, HEIMDALL_SCRATCH: "" },
		});
		expect(r.status).toBe(0);
	});

	it("leaves an unrelated scratch dir alone when the variable is empty", () => {
		// Concurrency: a second kb-verify run (or any earlier one) may have its
		// own live scratch dir. With HEIMDALL_SCRATCH empty the guard must do
		// NOTHING — not sweep the prefix. Verified that a branch which removes
		// "${TMPDIR}/kbverify-home-*" from the empty case destroys another run's
		// directory, so this is a real data-loss path, not a theoretical one.
		const other = mkdtempSync(join("/tmp", "kbverify-home-"));
		writeFileSync(join(other, "proof"), "another run's data");
		try {
			const r = spawnSync("/bin/bash", ["-c", cleanupBlock()], {
				encoding: "utf8", timeout: 60_000,
				env: { ...process.env, HEIMDALL_SCRATCH: "", TMPDIR: "/tmp" },
			});
			expect(r.status).toBe(0);
			expect(existsSync(other), "an empty HEIMDALL_SCRATCH swept another run's scratch dir").toBe(true);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("REFUSES to delete a directory that is not a scratch dir", () => {
		// The whole point of the guard. An unexpected value — a typo, a stale
		// export, someone else's variable — must leave the directory alone.
		const d = scratchLike("precious-data-");
		try {
			const got = cleanup(d);
			expect(got.survived, "an unrecognised path was DELETED — this is the rm -rf catastrophe").toBe(true);
			expect(got.err).toMatch(/refusing/i);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("refuses a scratch-shaped path outside the allowed roots", () => {
		// A path that merely LOOKS like the scratch prefix but lives elsewhere
		// must not be swept up by a sloppy glob.
		const home = mkdtempSync(join(tmpdir(), "heimdall-scratch-"));
		const d = join(home, "kbverify-home-elsewhere");
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "proof"), "x");
		try {
			const got = cleanup(d);
			expect(got.survived, "deleted a scratch-shaped path outside the allowed roots").toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("refuses a bare filesystem root", () => {
		// The catastrophic input. Never actually deleted (the guard refuses), but
		// assert the branch reports a refusal rather than exiting silently.
		const r = spawnSync("/bin/bash", ["-c", cleanupBlock()], {
			encoding: "utf8", timeout: 60_000,
			env: { ...process.env, HEIMDALL_SCRATCH: "/" },
		});
		expect(r.stderr).toMatch(/refusing/i);
		expect(existsSync("/")).toBe(true);
	});
});
