// journal-v4-fact-kind.test.mjs — owned_nodes gains a fact_kind column (v4).
//
// RED for Phase 1. Spec K5 requires `--kind decision` = assertion ∪ declaration,
// but the extractor's preference/assertion/declaration/negation classification
// is NOT stored anywhere: owned_nodes.kind is the literal "fact", and
// extract.mjs:53 builds the id as `${f.id}@${nsFor(path)}` where
// f.id = "fact-" + sha256(...), so the kind is unrecoverable from the row too.
// Without a column, --kind decision is a silent no-op returning every fact.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Journal } from "../bin/lib/journal.mjs";
import { desiredState } from "../bin/lib/extract.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
void repoRoot;

test("a v3 database migrates to v4 with a fact_kind column", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-journal-v4-"));
  try {
    const j = new Journal(join(dir, "journal.db"));
    const cols = () =>
      j.db.prepare("PRAGMA table_info(owned_nodes)").all().map((r) => r.name);
    assert.ok(
      cols().includes("fact_kind"),
      "fact_kind column missing after migration",
    );
    // Pre-existing rows read NULL, not a fabricated default.
    j.commit({
      path: "/tmp/x.py", startGeneration: 0, hash: "h", size: 1, mtimeMs: 1,
      depth: "file", capMax: null, state: "present",
      nodes: [{ node_id: "n1", kind: "fact", symbol: null, line: 1, label: null, sink_id: null }],
      edges: [], pending: [],
    });
    const row = j.db.prepare("SELECT fact_kind FROM owned_nodes WHERE node_id = ?").get("n1");
    assert.equal(row.fact_kind, null, "legacy fact rows must read NULL, not a default");
    j.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extract.mjs writes the extractor's fact kind into the node", () => {
  // The precedence in facts.mjs: a preference utterance is classified
  // `preference`, an "I use ..." utterance `assertion`. Assert both, so a
  // regression that writes a constant cannot pass.
  const dir = mkdtempSync(join(tmpdir(), "heimdall-factkind-"));
  try {
    const p = join(dir, "prompt.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ text: "I prefer tabs over spaces in this repository" }),
        JSON.stringify({ text: "I use SQLite for the journal store" }),
      ].join("\n"),
    );
    // facts:true is one of the three ingest gates (the other two are
    // skipPath and promptsDir). Without it desiredState returns no fact nodes
    // at all — which is precisely the silent-zero failure the spec warns about.
    const { nodes } = desiredState(p, "file", { facts: true });
    const facts = nodes.filter((n) => n.kind === "fact");
    assert.ok(facts.length >= 2, `expected >=2 fact nodes, got ${facts.length}`);
    const kinds = new Set(facts.map((n) => n.fact_kind));
    assert.ok(kinds.has("preference"), "preference kind was not recorded");
    assert.ok(kinds.has("assertion"), "assertion kind was not recorded");
    for (const f of facts) {
      assert.ok(
        ["preference", "assertion", "declaration", "negation"].includes(f.fact_kind),
        `unexpected fact_kind ${f.fact_kind}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-fact nodes carry no fact_kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-factkind2-"));
  try {
    const p = join(dir, "notes.jsonl");
    writeFileSync(p, JSON.stringify({ text: "I prefer dark mode" }) + "\n");
    const { nodes } = desiredState(p, "file", { facts: true });
    for (const n of nodes) {
      if (n.kind !== "fact") {
        assert.equal(n.fact_kind, undefined, `non-fact node ${n.node_id} has fact_kind`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
