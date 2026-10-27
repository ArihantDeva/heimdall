// A long build must SURVIVE a concurrent writer, not die on it.
//
// Reproduced 2026-10-27: `embed-index.py build` over the live 4.2GB index
// crashed with
//   sqlite3.OperationalError: database is locked
// at `_upsert` -> `c.commit()`, because the reconciler daemon held a write
// lock for longer than python's default `busy_timeout` (5000ms). The build is
// a ~10 minute job whose progress is committed in batches; losing it to a lock
// that would have cleared is pure waste, and it happened to me twice.
//
// The underlying cause is the journal mode. The live database runs
// `journal_mode=delete`, where a writer takes an EXCLUSIVE lock over the
// journal lifetime and readers/writers are blocked for the whole commit. Under
// WAL, writers do not block readers and the exclusive window shrinks.
//
// The fix has two halves, both asserted here:
//   1. conn() waits long enough for a transient writer to finish instead of
//      failing instantly on the first collision.
//   2. conn() selects WAL when the database is not already in WAL, so the
//      exclusive-lock window stops spanning whole commits.
//
// These assert BEHAVIOUR through the real module against a temp database. They
// deliberately do not assert a specific timeout constant: what matters is that
// a 12-second writer hold is survivable, which is well past any default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { embedIndexPython, embedIndexSkipReason } from "./lib/python.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// These tests import bin/embed-index.py, which calls sqlite_vec.load() at import
// time. So they must run only where that import actually works, and skip with a
// NAMED reason elsewhere.
//
// NOT a hardcoded ~/.heimdall/venv path — that is the exact bug tests/lib/python.mjs
// documents, and it bit this suite: `spawnSync .../venv/bin/python3 ENOENT` on
// ubuntu-latest and macos-latest while green locally. `embedIndexPython()` probes
// the module the test really imports, so a new dependency cannot drift out of a
// hand-maintained list.
const PY = embedIndexPython();
const SKIP = PY === null ? embedIndexSkipReason() : false;

/** Run a python snippet with HEIMDALL_DB pointed at `db`. */
function py(db, body) {
  return execFileSync(PY, ["-c", body], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, HEIMDALL_DB: db, HEIMDALL_DEVICE: "cpu" },
  });
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-lock-"));
  return { dir, db: join(dir, "global.db") };
}

test("conn() asks sqlite to wait for a busy writer instead of failing on the first collision", { skip: SKIP }, () => {
  const { dir, db } = freshDb();
  try {
    // The default python busy_timeout is 5000ms. A build that commits every
    // 128 cards needs substantially more than that to outlast a daemon pass.
    const out = py(db, `
import importlib.util, sys
sys.path.insert(0, "bin")
spec = importlib.util.spec_from_file_location("embed_index", "bin/embed-index.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
c = m.conn()
print(c.execute("PRAGMA busy_timeout").fetchone()[0])
c.close()
`).trim();
    const ms = Number(out);
    assert.ok(Number.isFinite(ms), `busy_timeout must be readable, got ${out}`);
    assert.ok(
      ms >= 30_000,
      `busy_timeout must outlast a real writer, got ${ms}ms (default is 5000ms, which is what crashed the build)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conn() selects WAL so a writer does not lock the whole database for every commit", { skip: SKIP }, () => {
  const { dir, db } = freshDb();
  try {
    // A fresh database starts in `delete` mode, the mode that made commits
    // exclusive for their whole duration.
    const before = py(db, `
import sqlite3
c = sqlite3.connect("${db}")
print(c.execute("PRAGMA journal_mode").fetchone()[0])
c.close()
`).trim();
    assert.equal(before, "delete", "precondition: a brand-new db is in delete mode");

    const after = py(db, `
import importlib.util, sys
sys.path.insert(0, "bin")
spec = importlib.util.spec_from_file_location("embed_index", "bin/embed-index.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
c = m.conn()
print(c.execute("PRAGMA journal_mode").fetchone()[0])
c.close()
`).trim();
    assert.equal(
      after,
      "wal",
      "conn() must move the index to WAL: under delete-mode every commit blocks readers and other writers for its full duration",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a build commit survives a writer that holds the lock for 12 seconds", { skip: SKIP }, () => {
  const { dir, db } = freshDb();
  try {
    // Establish the schema through the module itself, then have a SEPARATE
    // process grab a write transaction and hold it. The second process must
    // wait and succeed. 12s is chosen to be clearly beyond the 5000ms default:
    // this is exactly the collision that crashed the real rebuild.
    const script = `
import importlib.util, sys, threading, time, sqlite3
sys.path.insert(0, "bin")
spec = importlib.util.spec_from_file_location("embed_index", "bin/embed-index.py")
embed_index = importlib.util.module_from_spec(spec); spec.loader.exec_module(embed_index)

c = embed_index.conn()
c.execute("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, v TEXT)")
c.commit()
c.close()

HOLD = 12.0
def hold():
    w = sqlite3.connect(${JSON.stringify(db)}, timeout=60)
    w.execute("BEGIN IMMEDIATE")
    w.execute("INSERT INTO probe (v) VALUES ('holder')")
    time.sleep(HOLD)
    w.commit()
    w.close()

t = threading.Thread(target=hold)
t.start()
time.sleep(1.0)   # let the holder win the race deterministically

c = embed_index.conn()
t0 = time.time()
c.execute("INSERT INTO probe (v) VALUES ('waited')")
c.commit()        # this is the line that raised "database is locked"
elapsed = time.time() - t0
c.close()
t.join()
print(f"{elapsed:.1f}")
`;
    const out = py(db, script).trim();
    const elapsed = Number(out);
    assert.ok(Number.isFinite(elapsed), `expected the wait duration, got ${out}`);
    assert.ok(
      elapsed >= 5.0,
      `the commit should have waited out the holder (waited ${elapsed}s); a sub-second commit means it never hit the lock and the test proved nothing`,
    );

    // Both rows must be present: the wait must not have silently dropped work.
    const rows = py(db, `
import sqlite3
c = sqlite3.connect(${JSON.stringify(db)})
print(c.execute("SELECT v FROM probe ORDER BY id").fetchall().__len__())
c.close()
`).trim();
    assert.equal(rows, "2", "both the holder's and the waiting writer's rows must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
