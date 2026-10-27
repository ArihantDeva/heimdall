import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../bin/lib/journal.mjs";

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-enqueue-stmt-"));
  const s = { file: join(dir, "journal.db"), path: join(dir, "source.py") };
  s.journal = new Journal(s.file);
  t.after(() => { s.journal.close(); rmSync(dir, { recursive: true, force: true }); });
  return s;
}
function countHintPrepares(t, journal) {
  const counts = { queue: 0, generation: 0 };
  const prepare = journal.db.prepare.bind(journal.db);
  t.mock.method(journal.db, "prepare", (sql) => {
    if (sql.includes("INSERT INTO queue")) counts.queue++;
    if (sql.includes("INSERT INTO paths")) counts.generation++;
    return prepare(sql);
  });
  return counts;
}
const queued = (journal, path) => journal.db.prepare("SELECT * FROM queue WHERE path = ?").get(path);

// Fixed structural work, not latency or a performance/quality benchmark.
test("fixed hint SQL is prepared once while each call binds its current path and timestamp", (t) => {
  const { journal, path } = sandbox(t);
  const counts = countHintPrepares(t, journal);
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  journal.enqueue(path, "first");
  now = 2_000;
  journal.enqueue(path + ".other", "other");
  now = 3_000;
  journal.enqueue(path, "later");
  assert.deepEqual(counts, { queue: 1, generation: 1 });
  assert.equal(journal.queueDepth(), 2);
  assert.equal(journal.generation(path), 2);
  assert.equal(journal.generation(path + ".other"), 1);
  assert.equal(queued(journal, path).enqueued_at, 3_000);
  assert.equal(queued(journal, path).reason, "first", "retain the original coalesced reason");
  assert.equal(queued(journal, path + ".other").reason, "other");
});

test("compiled statements belong to their Journal connection, not a module-wide cache", (t) => {
  const a = sandbox(t);
  const b = sandbox(t);
  const ac = countHintPrepares(t, a.journal);
  const bc = countHintPrepares(t, b.journal);
  a.journal.enqueue(a.path, "a");
  a.journal.enqueue(a.path, "a-again");
  b.journal.enqueue(a.path, "b"); // same path, separate authoritative database
  b.journal.enqueue(b.path, "b-other");
  assert.deepEqual(ac, { queue: 1, generation: 1 });
  assert.deepEqual(bc, { queue: 1, generation: 1 });
  assert.equal(a.journal.queueDepth(), 1);
  assert.equal(a.journal.generation(a.path), 2);
  assert.equal(b.journal.queueDepth(), 2);
  assert.equal(b.journal.generation(a.path), 1);
  assert.equal(queued(a.journal, a.path).reason, "a");
  assert.equal(queued(b.journal, a.path).reason, "b");
});

test("dequeue then re-enqueue rebinds the reused statement without resurrecting old metadata", (t) => {
  const { journal, path } = sandbox(t);
  journal.enqueue(path, "old");
  journal.dequeue(path);
  journal.enqueue(path + ".other", "other");
  journal.enqueue(path, "new");
  assert.equal(queued(journal, path).reason, "new");
  assert.equal(queued(journal, path + ".other").reason, "other");
  assert.equal(journal.generation(path), 2);
  assert.equal(journal.queueDepth(), 2);
});

test("schema changes and execution errors still affect a previously prepared generation statement", (t) => {
  const { journal, path } = sandbox(t);
  journal.enqueue(path, "initial"); // prepare both before adding a trigger
  journal.db.exec(`CREATE TEMP TRIGGER reject_generation BEFORE UPDATE ON paths
    BEGIN SELECT RAISE(ABORT, 'generation rejected'); END`);
  assert.throws(() => journal.enqueue(path, "blocked"), /generation rejected/);
  assert.equal(journal.generation(path), 1);
  journal.db.exec("DROP TRIGGER reject_generation");
  journal.enqueue(path, "retry");
  assert.equal(journal.generation(path), 2);
  assert.equal(journal.queueDepth(), 1);
  assert.equal(journal.db.prepare("PRAGMA synchronous").get().synchronous, 2, "FULL durability unchanged");
});

test("a statement remains usable after a binding error", (t) => {
  const { journal, path } = sandbox(t);
  assert.throws(() => journal.enqueue(path, { invalid: "non-scalar binding" }));
  assert.equal(journal.queueDepth(), 0);
  assert.equal(journal.generation(path), 0);
  journal.enqueue(path, "valid");
  assert.equal(queued(journal, path).reason, "valid");
  assert.equal(journal.generation(path), 1);
});

test("failed preparation is retried rather than cached as a broken generation statement", (t) => {
  const { journal, path } = sandbox(t);
  const prepare = journal.db.prepare.bind(journal.db);
  const failure = new Error("injected preparation failure");
  let reject = true;
  t.mock.method(journal.db, "prepare", (sql) => {
    if (sql.includes("INSERT INTO paths") && reject) { reject = false; throw failure; }
    return prepare(sql);
  });
  assert.throws(() => journal.enqueue(path, "first"), (err) => err === failure);
  journal.enqueue(path, "retry");
  assert.equal(journal.generation(path), 1);
  assert.equal(journal.queueDepth(), 1);
  assert.equal(queued(journal, path).reason, "first");
});

test("close stays idempotent, closed handles refuse writes, and a reopened Journal uses fresh statements", (t) => {
  const s = sandbox(t);
  const old = s.journal;
  old.enqueue(s.path, "initial");
  old.close();
  assert.doesNotThrow(() => old.close());
  assert.throws(() => old.enqueue(s.path, "closed"));
  s.journal = new Journal(s.file);
  const counts = countHintPrepares(t, s.journal);
  s.journal.enqueue(s.path, "reopened");
  assert.deepEqual(counts, { queue: 1, generation: 1 });
  assert.equal(s.journal.generation(s.path), 2);
  assert.equal(queued(s.journal, s.path).reason, "initial");
});
