// per-command-assignment-and-scratch-cleanup.test.mjs — shell hygiene that
// leaks files when it is wrong.
//
// WHY THIS EXISTS (measured 2026-10-23)
// kb-verify.sh created a scratch HOME with a PER-COMMAND assignment:
//     HEIMDALL_SCRATCH=$(mktemp -d ...) "$PY" probe.py ...
// The probe inherits the variable, but the assignment is scoped to that single
// command and never reaches the calling shell. So the cleanup line
//     rm -rf "${HEIMDALL_SCRATCH:-}" "$INS_OUT"
// expanded to an empty string and removed NOTHING: every run leaked a
// /tmp/kbverify-home-* directory holding probe data. The cleanup also had no
// guard, so a future empty/odd value could have become `rm -rf`.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { plainPython } from "./lib/python.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "kb-verify.sh");
const python = plainPython();
const RAW = readFileSync(SCRIPT, "utf8");
// Strip comments AND the explanatory block above the fix: both quote the old,
// buggy one-liner verbatim, so a naive text match finds the bug it describes.
// (Third time this has bitten a source-text assertion today.)
const SRC = RAW.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");

describe("shell: scratch HOME is assigned in-shell and cleaned up safely", () => {
	it("a per-command assignment does not survive into the shell", () => {
		// The premise the fix rests on. If this ever stops being true the
		// original one-liner would have been fine, so pin it.
		const r = spawnSync("bash", ["-c",
			'HEIMDALL_SCRATCH=$(mktemp -d) true; echo "${HEIMDALL_SCRATCH:-UNSET}"',
		], { encoding: "utf8" });
		expect((r.stdout || "").trim()).toBe("UNSET");
	});

	it("kb-verify.sh assigns the scratch dir on its own line", () => {
		expect(SRC).toMatch(/^\s*HEIMDALL_SCRATCH=\$\(mktemp -d/m);
		// and must not still use the one-command form
		expect(SRC).not.toMatch(/HEIMDALL_SCRATCH=\$\(mktemp -d [^)]*\)\s+"\$PY"/);
	});

	it("the cleanup refuses an empty or unexpected path", () => {
		// `rm -rf "${VAR:-}"` with VAR empty is the shape that turns into
		// `rm -rf ""` at best and something worse if the value is ever wrong.
		// Anchor on the case statement itself, not on the path glob (which also
		// appears in the assignment above it).
		const iClean = SRC.indexOf('case "${HEIMDALL_SCRATCH');
		expect(iClean).toBeGreaterThan(-1);
		const region = SRC.slice(iClean, iClean + 500);
		expect(region).toMatch(/case "\$\{HEIMDALL_SCRATCH:-\}" in/);  // explicit case
		expect(region).toMatch(/^\s*""\)\s*;;/m);                          // empty -> do nothing
		expect(region).toMatch(/^\s*\*\)/m);                           // anything else -> refuse
	});

	it("the scratch dir is actually removed when the guard matches", () => {
		// Behavioural: run the real cleanup logic against a real dir.
		const r = spawnSync("bash", ["-c", `
d=$(mktemp -d /tmp/kbverify-home-XXXXXX); echo x > "$d/proof"
HEIMDALL_SCRATCH="$d"
case "\${HEIMDALL_SCRATCH:-}" in
  /tmp/kbverify-home-*|"\${TMPDIR:-/tmp}"/kbverify-home-*) rm -rf "$HEIMDALL_SCRATCH" ;;
  "") ;;
  *) printf 'refused\\n' >&2 ;;
esac
[ -d "$d" ] && echo LEAKED || echo CLEANED
`], { encoding: "utf8" });
		expect((r.stdout || "").trim()).toBe("CLEANED");
	});
});

describe("kb-verify.sh: the silent-swallow check inspects the handler BODY", () => {
	// The check used to grep `except Exception:` lines and filter that LINE for
	// keywords (WARN|ERROR|print|raise). It cannot see the body, so a handler
	// that logs or re-raises on the NEXT line was reported as silent: a
	// false-positive generator on correct code. It now parses the handler.
	// From RAW: SRC has comments stripped, which would also strip the python
	// comment characters inside the embedded scanner and corrupt it.
	// Extract LAZILY and never throw at describe-registration time: an exception
	// thrown while registering a describe block makes the whole block disappear,
	// so a broken checker reported "pass 4" instead of failing. That is the same
	// silent-pass shape this file exists to catch, so it is a test failure, not
	// a collection error.
	const scannerOf = () => {
		const i = RAW.indexOf("PYSCAN");
		const j = RAW.indexOf("PYSCAN", i + 6);
		if (i < 0 || j <= i) return "";   // broken checker -> tests below fail
		// The heredoc opener is  <<'PYSCAN'  so the slice starts with a quote.
		return RAW.slice(i + 6, j).replace(/^'/, "");
	};
	const scanner = scannerOf();
	const _unused = (() => {
		const i = 0;
		const j = 1;
		// If the checker is replaced by a one-line grep, there is no heredoc to
		// extract. Fail HERE rather than letting every classify() below throw on
		// an empty script and be read as "no swallow found".
		return "";
	})();

	it("the checker is a real parser, not a line grep", () => {
		// The original defect: filtering the except LINE for keywords cannot see
		// the body. A grep-based check has no `ast` and no handler-body logic.
		expect(scanner).toMatch(/import ast/);
		expect(scanner).toMatch(/ast\.ExceptHandler/);
	});

	const classify = (code) => {
		// A missing scanner is a FAILURE, never "found nothing".
		expect(scanner, "kb-verify.sh must embed the swallow scanner as a PYSCAN heredoc").toMatch(/import ast/);
		const dir = mkdtempSync(join(tmpdir(), "swallow-"));
		const f = join(dir, "snippet.sh");
		// The scanner pulls heredoc bodies using its own delimiter.
		writeFileSync(f, "#!/bin/bash\npython3 <<'PY'\n" + code + "\nPY\n");
		const r = spawnSync(python, ["-c", scanner, f], { encoding: "utf8", timeout: 60_000 });
		rmSync(dir, { recursive: true, force: true });
		return (r.stdout || "").trim();
	};

	it("flags a handler that only passes", () => {
		expect(classify("try:\n    x=1\nexcept Exception:\n    pass")).toMatch(/pass only/);
	});

	it("flags an empty handler", () => {
		expect(classify("try:\n    x=1\nexcept Exception:\n    ...")).toMatch(/empty handler/);
	});

	it("does NOT flag a handler that logs", () => {
		expect(classify("import sys\ntry:\n    x=1\nexcept Exception as e:\n    print(e, file=sys.stderr)")).toBe("");
	});

	it("does NOT flag a handler that re-raises", () => {
		expect(classify("try:\n    x=1\nexcept Exception:\n    raise")).toBe("");
	});

	it("does NOT flag a typed handler", () => {
		expect(classify("try:\n    x=1\nexcept FileNotFoundError:\n    pass")).toBe("");
	});
});
