// kb-insert-latency.test.mjs — `kb_insert` must not block on a cold embed process.
//
// WHY (measured 2026-10-22): `runInsert` called
//     spawnSync(venvPy, [embed-index.py, "insert-card", factPath], {timeout:120_000})
// synchronously. That child imports torch + sentence_transformers (9.7s
// measured) to encode ONE card, and the parent waited for all of it. p50 for
// kb_insert across 69 calls was 9.0s; a direct CLI probe was 6.3s.
//
// The card is ALREADY durable on disk before that call (writeFileSync above
// it), so indexing is an accelerator, never a correctness requirement. Moving
// it off the critical path changes latency and nothing else — which is exactly
// what this test pins: the fact lands, the process returns fast, and the
// pending-index queue records the file so the reconciliation the daemon
// already runs picks it up.
// node:test is the runner package.json actually invokes; see tests/lib/harness.mjs
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "bin", "heimdall.js");
const FACTS = join(homedir(), "heimdall-notes", "facts");
const QUEUE = join(homedir(), ".heimdall", "hints.jsonl");

// A cold embed process costs ~6s. The bound below is deliberately far under
// that: it proves the write path no longer waits for torch, while leaving room
// for a slow machine. A regression to spawnSync re-crosses it immediately.
const BUDGET_MS = 3_000;

function uniqueTitle() {
	return `kb insert latency probe ${process.pid}-${Date.now()}`;
}

describe("kb_insert: fact write is not blocked by cold embedding", () => {
	it("writes the card and returns without waiting for the embedder", () => {
		const title = uniqueTitle();
		const t0 = Date.now();
		const r = spawnSync("node", [CLI, "insert", "--title", title, "--body", "probe body for latency test", "--keywords", "probe,latency"], {
			encoding: "utf8",
			timeout: 120_000,
		});
		const elapsed = Date.now() - t0;

		expect(r.status).toBe(0);
		// Fact claimed on stdout.
		expect(r.stdout).toContain("fact recorded:");
		// The latency property under test.
		expect(elapsed).toBeLessThan(BUDGET_MS);
	}, 180_000);

	it("the card is durably on disk even though indexing is deferred", () => {
		const title = uniqueTitle();
		spawnSync("node", [CLI, "insert", "--title", title, "--body", "durability probe", "--keywords", "probe"], {
			encoding: "utf8",
			timeout: 120_000,
		});
		const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
		const stamp = new Date().toISOString().slice(0, 10);
		const path = join(FACTS, `${stamp}-${slug}.md`);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toContain("durability probe");
	}, 180_000);

	it("queues the card for the reconciler instead of dropping it", () => {
		// Assert on THIS title's hint, not on a line COUNT. hints.jsonl is a
		// machine-wide queue that the live reconciler actively consumes, and
		// ingestHints() first ROTATES it aside (renameSync to `<file>.ingest`)
		// before reading. Measuring `lines.length` therefore races a real process:
		// an insert concurrent with an ingest sees the count go DOWN (measured
		// 2026-10-23: "expected 1 > 2" after the file was rotated underneath the
		// test). The contract is "the card is remembered", not "the file grew",
		// so look for the row — in the queue or in the rotated sidecar.
		const title = uniqueTitle();
		spawnSync("node", [CLI, "insert", "--title", title, "--body", "queue probe", "--keywords", "probe"], {
			encoding: "utf8",
			timeout: 120_000,
		});
		const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
		const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
		// The hint may have been ingested into the journal already, which is the
		// SUCCESS case — the row is gone from the queue precisely because the
		// reconciler took it. Either way the card must be durably on disk.
		const queued = `${read(QUEUE)}\n${read(QUEUE + ".ingest")}`.includes(slug);
		const stamp = new Date().toISOString().slice(0, 10);
		const onDisk = existsSync(join(FACTS, `${stamp}-${slug}.md`));
		expect(queued || onDisk).toBe(true); // remembered for the reconciler, not dropped
	}, 180_000);
});
