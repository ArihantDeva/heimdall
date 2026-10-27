import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../bin/lib/journal.mjs";
import { MemorySink } from "../bin/lib/sink.mjs";
import { reconcilePath, audit } from "../bin/lib/reconcile.mjs";

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-restamp-"));
  const journal = new Journal(join(dir, "journal.db"));
  const sink = new MemorySink();
  const path = join(dir, "notes.txt");
  const ctx = { journal, sink, config: { depth: "file", facts: true },
    cap: { max: "file", python: null, reason: "test" } };
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(path, "I use SQLite for storage.");
  journal.enqueue(path);
  reconcilePath(ctx, path);
  return { journal, sink, path, ctx };
}
function stamp(journal, path, extra = {}) {
  const prior = journal.getPath(path);
  return { path, startGeneration: prior.generation, hash: prior.hash,
    size: prior.size, mtimeMs: prior.mtime_ms + 10_000, depth: prior.depth,
    capMax: prior.cap_max, ...extra };
}
function ownership(journal) {
  return Object.fromEntries(["owned_nodes", "owned_edges", "pending_edges", "fact_history"].map((table) =>
    [table, journal.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test("touch/capability restamp preserves all ownership and fact text without rewriting it", (t) => {
  const { journal, sink, path, ctx } = sandbox(t);
  // Include a real fact-history row, not just empty-table equality.
  writeFileSync(path, "I prefer PostgreSQL for storage.");
  journal.enqueue(path);
  reconcilePath(ctx, path);
  assert.equal(journal.factHistory(path).length, 1);
  const file = journal.ownedNodes(path).find((n) => n.kind === "file");
  journal.db.prepare("INSERT INTO pending_edges VALUES (?, ?, ?, ?, ?)")
    .run(path, file.node_id, "future-symbol", "uses", 1);
  const before = ownership(journal);
  // Make an ownership rewrite fail observably, even if it re-inserts equal ids.
  for (const table of ["owned_nodes", "owned_edges", "pending_edges", "fact_history"]) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      journal.db.exec(`CREATE TEMP TRIGGER protect_${table}_${op} BEFORE ${op} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'ownership must not be rewritten'); END`);
    }
  }
  sink.ops.length = 0;
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  ctx.cap = { max: "graph", python: null, reason: "capability bounce" };
  journal.enqueue(path);
  const generation = journal.generation(path);
  const result = reconcilePath(ctx, path);
  assert.equal(result.action, "unchanged");
  const row = journal.getPath(path);
  assert.equal(row.generation, generation);
  assert.equal(row.cap_max, "graph");
  assert.equal(row.mtime_ms, Math.floor(statSync(path).mtimeMs));
  assert.equal(row.size, statSync(path).size);
  assert.deepEqual(ownership(journal), before, "including fact_title/body/kind and archived facts");
  assert.deepEqual(sink.ops, []);
  assert.equal(journal.queueDepth(), 0);
  assert.deepEqual(audit(ctx, { enqueue: false }), []);
  assert.deepEqual(audit(ctx, { deep: true, enqueue: false }), []);
});

test("a stale metadata stamp reports stale and retains the newer hint", (t) => {
  const { journal, path, ctx } = sandbox(t);
  const before = journal.getPath(path);
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  journal.enqueue(path);
  const restamp = journal.restamp.bind(journal);
  journal.restamp = (args) => {
    journal.enqueue(path, "newer hint during restamp");
    return restamp(args);
  };
  const result = reconcilePath(ctx, path);
  assert.equal(result.action, "stale");
  assert.equal(journal.getPath(path).mtime_ms, before.mtime_ms);
  assert.equal(journal.queueDepth(), 1);
});

test("restamp refuses changed hash/depth, stale generation, absent and untracked rows", (t) => {
  const { journal, path } = sandbox(t);
  journal.enqueue(path);
  const before = journal.getPath(path);
  const graph = ownership(journal);
  for (const extra of [{ hash: "changed" }, { depth: "graph" },
    { startGeneration: before.generation - 1 }, { path: path + ".untracked", startGeneration: 0 }]) {
    assert.equal(journal.restamp(stamp(journal, path, extra)), false);
    assert.deepEqual(journal.getPath(path), before);
    assert.equal(journal.queueDepth(), 1);
    assert.deepEqual(ownership(journal), graph);
  }
  journal.db.prepare("UPDATE paths SET state = 'absent' WHERE path = ?").run(path);
  assert.equal(journal.restamp(stamp(journal, path)), false);
  assert.equal(journal.getPath(path).state, "absent", "cannot resurrect an absent row");
  assert.equal(journal.queueDepth(), 1);
});

test("a queue-delete failure rolls back the metadata update too", (t) => {
  const { journal, path } = sandbox(t);
  journal.enqueue(path);
  const before = journal.getPath(path);
  journal.db.exec(`CREATE TEMP TRIGGER reject_dequeue BEFORE DELETE ON queue
    BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END`);
  assert.throws(() => journal.restamp(stamp(journal, path)), /injected queue failure/);
  assert.deepEqual(journal.getPath(path), before);
  assert.equal(journal.queueDepth(), 1);
  assert.equal(journal.db.prepare("PRAGMA synchronous").get().synchronous, 2, "FULL durability stays on");
});
