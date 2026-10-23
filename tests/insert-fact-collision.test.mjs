// insert-fact-collision.test.mjs — recording a fact must never destroy a fact.
//
// WHY THIS EXISTS (measured 2026-10-23)
// `heimdall insert` (kb_insert's CLI) writes the durable card to
//
//     ~/heimdall-notes/facts/<YYYY-MM-DD>-<slug>.md
//
// where slug is `title.toLowerCase().replace(/[^a-z0-9]+/g,"-")`. Distinct
// titles collapse to the same slug — "a b", "a-b" and "a/b" all become "a-b" —
// so a second insert on the same day hit the same path and writeFileSync
// overwrote it. Measured: three inserts, ONE file on disk, two facts gone, every
// run exiting 0 with "fact recorded:". The code's own comment says the file is
// the durable record, so this is data loss, not a cache miss.
//
// The fix disambiguates with a counter (base.md, base-2.md, base-3.md).
import { describe, it, expect } from "./lib/harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "bin", "heimdall.js");

function sandbox() {
	const home = mkdtempSync(join(tmpdir(), "heimdall-insert-"));
	mkdirSync(join(home, ".graft", "profiles", "default"), { recursive: true });
	mkdirSync(join(home, "knowledge-base"), { recursive: true });
	return home;
}

function insert(home, title, body) {
	return spawnSync(process.execPath, [CLI, "insert", "--title", title, "--body", body], {
		encoding: "utf8", timeout: 120_000,
		env: { ...process.env, HOME: home },
	});
}

function facts(home) {
	const dir = join(home, "heimdall-notes", "facts");
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
			.map((f) => ({ name: f, body: readFileSync(join(dir, f), "utf8") }));
	} catch {
		return [];
	}
}

describe("insert: a new fact never overwrites an existing one", () => {
	it("keeps both facts when two titles slug identically", () => {
		const home = sandbox();
		const a = insert(home, "a b", "FIRST BODY");
		const b = insert(home, "a-b", "SECOND BODY");
		expect(a.status, a.stderr).toBe(0);
		expect(b.status, b.stderr).toBe(0);

		const all = facts(home);
		const joined = all.map((f) => f.body).join("\n");
		// The regression: the first body vanished and only one file existed.
		expect(all.length, `files: ${all.map((f) => f.name).join(", ")}`).toBe(2);
		expect(joined).toContain("FIRST BODY");
		expect(joined).toContain("SECOND BODY");
	});

	it("keeps every fact across a three-way slug collision", () => {
		const home = sandbox();
		for (const [t, body] of [["a b", "ONE"], ["a-b", "TWO"], ["a/b", "THREE"]]) {
			const r = insert(home, t, body);
			expect(r.status, `${t}: ${r.stderr}`).toBe(0);
		}
		const all = facts(home);
		expect(all.length, `files: ${all.map((f) => f.name).join(", ")}`).toBe(3);
		const joined = all.map((f) => f.body).join("\n");
		for (const body of ["ONE", "TWO", "THREE"]) expect(joined).toContain(body);
	});

	it("keeps both versions when the same title is recorded twice", () => {
		// Re-recording a fact is normal (a decision refined later). Neither copy
		// may silently replace the other.
		const home = sandbox();
		insert(home, "same title", "v1");
		insert(home, "same title", "v2");
		const all = facts(home);
		expect(all.length).toBe(2);
		const joined = all.map((f) => f.body).join("\n");
		expect(joined).toContain("v1");
		expect(joined).toContain("v2");
	});

	it("still uses the plain name when there is no collision", () => {
		// The fix must not rename the common case; a stable, predictable path is
		// part of the contract (other tooling resolves facts by filename).
		const home = sandbox();
		insert(home, "unique thing", "body");
		const all = facts(home);
		expect(all.length).toBe(1);
		expect(all[0].name).toMatch(/^\d{4}-\d{2}-\d{2}-unique-thing\.md$/);
	});

	it("preserves the title verbatim, including quotes and apostrophes", () => {
		// The slug mangles punctuation; the card CONTENT must not.
		const home = sandbox();
		insert(home, `Don't break: it's "quoted"`, "body");
		const all = facts(home);
		expect(all.length).toBe(1);
		expect(all[0].body).toContain(`# Don't break: it's "quoted"`);
	});

	it("never writes outside the facts directory", () => {
		// A title of "../../../escape" must not traverse out of the facts dir.
		const home = sandbox();
		const r = insert(home, "../../../escape", "body");
		expect(r.status, r.stderr).toBe(0);
		const all = facts(home);
		expect(all.length).toBe(1);
		expect(all[0].name).not.toContain("..");
		expect(all[0].name).not.toContain("/");
	});
});
