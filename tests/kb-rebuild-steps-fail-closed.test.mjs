// kb-rebuild-steps-fail-closed.test.mjs — a rebuild must not report 6/6 over a
// partial restore.
//
// WHY THIS EXISTS (measured 2026-10-23)
// kb-rebuild.sh was hardened to fail closed in steps 1-3 (backup, node list,
// restore): six explicit status checks, each `|| die`. Steps 4-6 were left as
//     bash "$HERE/seed-graft.sh" 2>&1 | tail -1
//     bash "$HERE/sync-edits.sh" --full 2>&1 | tail -1
//     python3 "$HERE/kb-stale-scan.py" 2>&1 | tail -1
// with no pipefail and no status inspection anywhere. Demonstrated by running
// exactly those lines against failing commands: all three fail, the script still
// prints "== 6/6 verify", "REBUILD COMPLETE" and exits 0.
//
// A rebuild's whole job is fidelity. Reporting success over an incomplete graph is
// worse than failing loudly, because the caller stops looking.
//
// The prune is deliberately NOT fatal: exit 1 there usually means the mass-delete
// circuit breaker refused (see tests/stale-scan-mass-guard-behaviour.test.mjs),
// which is the guard working, not a failure.
import { describe, it, expect } from "./lib/harness.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "kb-rebuild.sh");
const SRC = readFileSync(SCRIPT, "utf8");

// The step 4-6 region, extracted so assertions are about that block specifically
// rather than "somewhere in a 200-line script".
function steps46() {
	const start = SRC.indexOf('echo "== 4/6');
	if (start < 0) throw new Error("could not find step 4");
	// The block runs through the prune's status note, which is its last line.
	const end = SRC.indexOf('[ "$PRUNE_RC" -eq 0 ]');
	if (end < 0) throw new Error("could not find the prune status note");
	return SRC.slice(start, end);
}

describe("kb-rebuild steps 4-6: failures are not swallowed", () => {
	it("captures the re-seed exit status", () => {
		// The bug shape was piping straight into tail, which discards the status.
		const block = steps46();
		expect(block).toMatch(/SEED_OUT=\$\(bash "\$HERE\/seed-graft\.sh" 2>&1\); SEED_RC=\$\?/);
	});

	it("captures the edit-sync exit status", () => {
		expect(steps46()).toMatch(/SYNC_OUT=\$\(bash "\$HERE\/sync-edits\.sh" --full 2>&1\); SYNC_RC=\$\?/);
	});

	it("captures the prune exit status", () => {
		expect(steps46()).toMatch(/PRUNE_OUT=\$\(python3 "\$HERE\/kb-stale-scan\.py" 2>&1\); PRUNE_RC=\$\?/);
	});

	it("aborts the run when re-seed or sync failed", () => {
		expect(SRC).toMatch(/\[ "\$SEED_RC" -ne 0 \] \|\| \[ "\$SYNC_RC" -ne 0 \]/);
		expect(SRC).toMatch(/die "re-seed \(exit \$SEED_RC\) or edit sync \(exit \$SYNC_RC\) failed/);
	});

	it("does NOT abort on a refused mass prune", () => {
		// Over-correcting here would turn the circuit breaker into a rebuild
		// failure, making a protective refusal look like a broken run.
		const tail = SRC.slice(SRC.indexOf('if [ "$SEED_RC"'));
		expect(tail).not.toMatch(/PRUNE_RC"? -ne 0 \] \|\|.*die/);
		expect(tail).toMatch(/\[ "\$PRUNE_RC" -eq 0 \] \|\| echo "   note: stale prune exited/);
	});

	it("still reports the final node/edge counts", () => {
		// The fix must not drop the verify output the operator reads.
		expect(steps46()).toMatch(/nodes:.*n_nodes/);
	});
});
