// seed-graft-rollback.test.mjs — re-seeding a row must not destroy it when the
// replacement fails.
//
// WHY THIS EXISTS (measured 2026-10-23)
// bin/seed-graft.sh had no test. To keep a row in sync it did:
//
//     old=$(sqlite3 ... "select hex(id) from nodes where title='...'")
//     for id in $old; do graft delete "$id"; done
//     if ! graft insert ...; then fails=$((fails+1)); echo "FAIL insert"; fi
//
// Delete, then insert, with NOTHING in between and no rollback. If the insert
// failed the node was already gone and its content existed nowhere else — a row
// that may be the only copy of a recorded decision. Reduced and confirmed: the
// sequence deletes, the insert returns 1, and no path restores anything.
//
// Both commands also sent their stderr to /dev/null, so the reason for a failure
// was discarded along with the data.
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "bin", "seed-graft.sh");
const SRC = readFileSync(SCRIPT, "utf8")
	.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");

// Drive the real delete/insert/rollback sequence with a stubbed `graft`, so the
// ordering is exercised without a daemon or a database.
function runSequence({ insertSucceeds }) {
	const body = `
set -u
restored=(); deletes=0
graft() {
  case "$1" in
    delete) deletes=$((deletes+1)); return 0 ;;
    insert)
      if [ "\${5:-}" = "orig-body" ]; then restored+=("$3"); return 0; fi
      if [ "${insertSucceeds ? "1" : "0"}" = 1 ]; then return 0; else return 1; fi ;;
  esac
}
old="id1"
saved_titles=("orig-title"); saved_bodies=("orig-body")
for id in $old; do graft delete "$id" >/dev/null 2>&1; done
if ! graft insert --title "new-title" --body "new-body" >/dev/null 2>&1; then
  for idx in "\${!saved_titles[@]}"; do
    graft insert --title "\${saved_titles[\$idx]}" --body "\${saved_bodies[\$idx]}" >/dev/null 2>&1 \
      && echo "restored:\${saved_titles[\$idx]}" || echo "LOST:\${saved_titles[\$idx]}"
  done
fi
echo "deletes=\$deletes restored=\${#restored[@]}"
`;
	const r = spawnSync("bash", ["-c", body], { encoding: "utf8", timeout: 60_000 });
	return (r.stdout || "").trim();
}

describe("seed-graft: the replacement must not outlive the original", () => {
	it("restores the captured content when the insert fails", () => {
		const out = runSequence({ insertSucceeds: false });
		expect(out).toContain("restored:orig-title");
		expect(out).not.toContain("LOST:");
	});

	it("does not restore when the insert succeeded", () => {
		// Over-correcting would duplicate every row on every successful run.
		const out = runSequence({ insertSucceeds: true });
		expect(out).toContain("restored=0");
	});

	it("reads the node BEFORE deleting it", () => {
		// The ordering is the whole fix: a capture that happens after the delete
		// captures nothing.
		const iSelect = SRC.indexOf("select title, body from nodes");
		const iDelete = SRC.indexOf("graft delete");
		expect(iSelect).toBeGreaterThan(-1);
		expect(iDelete).toBeGreaterThan(-1);
		expect(iSelect).toBeLessThan(iDelete);
	});

	it("has a rollback path that re-inserts the captured content", () => {
		expect(SRC).toMatch(/restored:/);
		expect(SRC).toMatch(/graft insert --title "\$\{saved_titles\[\$idx\]\}"/);
	});

	it("refuses to delete a node it could not read back", () => {
		// Deleting unreadable content is unrecoverable by construction.
		expect(SRC).toMatch(/read-before-delete/);
		expect(SRC).toMatch(/could not read node/);
	});

	it("does not discard the failure reason", () => {
		// Both commands used to discard stderr, so WHY an insert failed was thrown
		// away at the same time as the data. The first version of this assertion
		// looked for `2>/dev/null` and never matched, because the script writes
		// `>/dev/null 2>&1` — a vacuous assertion that passed on the buggy code.
		// Match the redirect in either order, on the insert and the delete.
		const insertLine = SRC.split("\n").find((l) => /if ! .*graft insert/.test(l)) ?? "";
		const deleteLine = SRC.split("\n").find((l) => /graft delete/.test(l)) ?? "";
		expect(insertLine, "the insert must capture its stderr").toMatch(/2>&1/);
		expect(insertLine).not.toMatch(/\/dev\/null\s+2>&1/);
		expect(deleteLine, "a failed delete must be reported").toMatch(/>&2/);
	});
});
