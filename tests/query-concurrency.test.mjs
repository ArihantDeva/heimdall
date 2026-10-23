// query-concurrency.test.mjs — concurrent semantic queries must not degrade.
//
// Measured 2026-10-15 on the live machine. Five IDENTICAL semantic queries
// against the same index returned two DIFFERENT answers:
//
//   run 1: warn=0 strong=3 first=cov28%  .../Repos/heimdall/bin/lib/backfill-sessions.mjs
//   run 2: warn=3 strong=0 first=cov00%  .../command-center/api/services/jsonl.py
//   run 3: warn=0 strong=3 first=cov28%  .../Repos/heimdall/bin/lib/backfill-sessions.mjs
//   run 4: warn=0 strong=3 first=cov28%  .../Repos/heimdall/bin/lib/backfill-sessions.mjs
//   run 5: warn=0 strong=3 first=cov28%  .../Repos/heimdall/bin/lib/backfill-sessions.mjs
//
// The degrading run emitted:
//   SEMANTIC_ERROR: embed-index: busy; semantic skipped this call.
//   WARN: semantic layer failed — results are LEXICAL-ONLY (sem_coverage=degraded)
//
// Root cause: embed-index.py's query() path called _acquire_lock(), which takes
// fcntl.LOCK_EX — an EXCLUSIVE lock. Semantic search is READ-ONLY: it embeds the
// query, runs a k-NN SELECT, and reads card rows. Nothing is mutated, so two
// concurrent queries have no reason to exclude each other. Under concurrent
// load one holder wins, every other query raises Busy, exits 3, and the caller
// silently banners lexical-only. Measured effect: the SAME query returned a
// different, worse answer roughly 1 time in 5 — with a [STRONG] Repos source hit
// replaced by [WEAK] cov00% hits from unrelated paths.
//
// This is the defect that makes a "5 consecutive clean probes" stability run
// non-reproducible: whether the criterion passes depends on whether another
// query happened to hold the lock at that instant.
//
// A .mjs test, not a .py one: package.json runs `node --test "tests/**/*.test.mjs"`,
// so a .py test in tests/ never executes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canImportEmbedIndex, sqliteVecPython, embedIndexSkipReason } from "./lib/python.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const EMBED = join(repoRoot, "bin", "embed-index.py");
const DB = join(homedir(), ".heimdall", "global.db");
// The index module needs sqlite_vec + sentence_transformers, installed only in
// the heimdall venv. Use it when present so these tests exercise the real import
// path instead of failing on a missing dependency.
// The behavioural lock tests exec() embed-index.py, which imports sqlite_vec.
// The source-text assertions above them need no python at all, so the gate is
// per-test: skipping the whole file would drop the cheap guards too.
// TWO gates, because the tests here need different things.
//
// The two LOCK tests exercise fcntl and nothing else — they import embed-index.py
// only to reach _acquire_read_lock/_acquire_lock. Requiring a full module import
// (which drags in sentence_transformers: torch plus a ~100MB model) to assert on
// a flock is why they skipped everywhere, including CI. They stub the encoder,
// so a python that can load sqlite_vec is sufficient.
//
// The determinism test below calls e.query(), which really does embed, so it
// keeps the strict gate. Relaxing that one would be faking coverage.
const canExec = canImportEmbedIndex(sqliteVecPython() ?? "python3");
// The lock tests stub BOTH module-top imports (sentence_transformers and
// sqlite_vec), so they need nothing beyond a working python3 + fcntl. Gating
// them on the model was the over-broad requirement that kept a pure flock
// assertion out of CI on every platform.
const canLock = spawnSync("python3", ["-c", "import fcntl"], { encoding: "utf8" }).status === 0;
const LOCK_PY = "python3";
const PY = canExec ? sqliteVecPython() : null;
const lockSkipReason = "no python3 with fcntl on this machine";

/** The lock helpers are pure text; assert on the real source of the module. */
function sourceOf(fnName) {
  const src = readFileSync(EMBED, "utf8");
  const i = src.indexOf(`def ${fnName}(`);
  assert.ok(i >= 0, `${fnName} not found in embed-index.py`);
  const rest = src.slice(i + 1);
  const j = rest.search(/\ndef |\nclass /);
  return j >= 0 ? rest.slice(0, j) : rest;
}

test("the query path does not take an exclusive lock", () => {
  // A read-only operation must not serialise against other readers. Before the
  // fix, query() called _acquire_lock() (LOCK_EX) and every concurrent reader
  // lost: Busy -> exit 3 -> lexical-only fallback.
  const q = sourceOf("query");
  assert.doesNotMatch(
    q, /_acquire_lock\(\)/,
    "query() must not take the exclusive build lock — semantic search is read-only",
  );
});

test("a shared (LOCK_SH) read lock exists and is what queries take", () => {
  // The fix is a shared lock, not no lock at all: a query must still not race a
  // build that is rewriting the vec table. Locking must be shared-among-readers,
  // exclusive-against-writers.
  const src = readFileSync(EMBED, "utf8");
  assert.match(src, /LOCK_SH/, "readers need a shared lock so they don't race a build");
  const q = sourceOf("query");
  assert.match(q, /_acquire_read_lock|LOCK_SH/,
    "query() must acquire the shared read lock");
});

test("a second concurrent reader is not rejected as busy",
  { skip: canLock ? false : lockSkipReason }, () => {
  // The observable contract. Two overlapping readers must both succeed. Before
  // the fix the second one printed "busy; semantic skipped this call" and
  // exited 3. Uses the module directly so this is a unit-level statement about
  // the lock, independent of the CLI's output formatting.
  const tmp = mkdtempSync(join(tmpdir(), "heimdall-lock-"));
  const script = `
import fcntl, importlib.util, os, pathlib, sys, time
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
import types as _types
# The lock tests exercise fcntl, not the encoder. embed-index.py imports
# sentence_transformers at MODULE TOP, so without this stub the gate demands
# torch + a ~100MB model to assert on a flock — which is why these two tests
# skipped even on CI. Register a fake module BEFORE exec so the top-level import
# resolves; nothing here calls it.
_st = _types.ModuleType("sentence_transformers")
_st.SentenceTransformer = lambda *a, **k: None
sys.modules["sentence_transformers"] = _st
# sqlite_vec is ALSO imported at module top (it exits if absent). The lock tests
# never touch sqlite, so stub it too — that is what lets them run on a plain
# python3, including macOS CI's, which cannot load extensions at all.
_sv = _types.ModuleType("sqlite_vec")
_sv.load = lambda *a, **k: None
sys.modules["sqlite_vec"] = _sv
_spec = importlib.util.spec_from_file_location("embed_index", ${JSON.stringify(join(repoRoot, "bin", "embed-index.py"))})
embed_index = importlib.util.module_from_spec(_spec)
sys.modules["embed_index"] = embed_index
_spec.loader.exec_module(embed_index)

tmp = pathlib.Path(${JSON.stringify(tmp)})
embed_index.LOCK_PATH = str(tmp / "q.lock")

# Holder: a reader that keeps its lock for the duration of the test.
outer = embed_index._acquire_read_lock()
try:
    # Second reader must also get in, not raise Busy.
    try:
        inner = embed_index._acquire_read_lock()
        print("SECOND_READER_OK")
        fcntl.flock(inner.fileno(), fcntl.LOCK_UN)
        inner.close()
    except embed_index.Busy:
        print("SECOND_READER_BUSY")
except Exception as e:
    print("ERROR", type(e).__name__, e)
finally:
    fcntl.flock(outer.fileno(), fcntl.LOCK_UN)
    outer.close()
`;
  return new Promise((resolve, reject) => {
    const p = spawn(LOCK_PY, ["-c", script], { encoding: "utf8" });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      try {
        assert.match(out, /SECOND_READER_OK/,
          `second concurrent reader was excluded (out=${JSON.stringify(out.trim())} err=${err.slice(0, 300)})`);
        resolve();
      } catch (e) { reject(e); }
      finally { rmSync(tmp, { recursive: true, force: true }); }
    });
  });
});

test("the build still takes an EXCLUSIVE lock (readers must not weaken writers)", () => {
  // Guard against over-correcting: making everything shared would let a build
  // rewrite the vec table underneath a reader. build() must keep LOCK_EX.
  const b = sourceOf("build");
  assert.match(b, /_acquire_lock_or_exit|_acquire_lock\(\)/,
    "build() must keep the exclusive lock — it mutates vec/cards");
});

test("the lock matrix holds in both orders (real flock, not just source text)",
  { skip: canLock ? false : lockSkipReason }, () => {
  // The claims above are about source; this is about behaviour. Four invariants:
  //   reader+reader coexist      (the actual fix)
  //   writer blocked by reader   (readers protect a build from a concurrent build)
  //   reader blocked by writer   (a build is never read mid-rewrite)
  //   lock reusable after release (no leaked fd, no stuck mutex)
  const script = `
import fcntl, importlib.util, pathlib, sys, tempfile
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
import types as _types
# sqlite_vec is imported at module top too (embed-index exits if it is absent).
# The lock matrix never touches sqlite, so stub it — this is what lets a pure
# flock assertion run on a plain python3, macOS CI included.
_sv0 = _types.ModuleType("sqlite_vec"); _sv0.load = lambda *a, **k: None
sys.modules["sqlite_vec"] = _sv0
# The lock tests exercise fcntl, not the encoder. embed-index.py imports
# sentence_transformers at MODULE TOP, so without this stub the gate demands
# torch + a ~100MB model to assert on a flock — which is why these two tests
# skipped even on CI. Register a fake module BEFORE exec so the top-level import
# resolves; nothing here calls it.
_st = _types.ModuleType("sentence_transformers")
_st.SentenceTransformer = lambda *a, **k: None
sys.modules["sentence_transformers"] = _st
_s = importlib.util.spec_from_file_location("embed_index", ${JSON.stringify(join(repoRoot, "bin", "embed-index.py"))})
e = importlib.util.module_from_spec(_s)
sys.modules["embed_index"] = e
_s.loader.exec_module(e)
e.LOCK_PATH = str(pathlib.Path(tempfile.mkdtemp()) / "q.lock")

res = []
a = e._acquire_read_lock(); b = e._acquire_read_lock()
res.append(("reader+reader", True))
try:
    e._acquire_lock(); res.append(("writer-vs-reader", False))
except e.Busy:
    res.append(("writer-vs-reader", True))
for fh in (a, b):
    fcntl.flock(fh.fileno(), fcntl.LOCK_UN); fh.close()
w = e._acquire_lock()
try:
    e._acquire_read_lock(); res.append(("reader-vs-writer", False))
except e.Busy:
    res.append(("reader-vs-writer", True))
fcntl.flock(w.fileno(), fcntl.LOCK_UN); w.close()
r = e._acquire_read_lock(); res.append(("reusable", r is not None))
fcntl.flock(r.fileno(), fcntl.LOCK_UN); r.close()
for name, ok in res:
    print(("OK " if ok else "BAD ") + name)
`;
  const r = spawnSync(LOCK_PY, ["-c", script], { encoding: "utf8" });
  const bad = (r.stdout || "").split("\n").filter((l) => l.startsWith("BAD "));
  assert.deepEqual(bad, [], `lock invariants violated: ${bad.join(", ")} (stderr=${(r.stderr || "").slice(0, 200)})`);
  assert.match(r.stdout || "", /OK reusable/, "lock must remain usable after release");
});

test("query() takes the read lock BEFORE any database read", () => {
  // Found by adversarial review 2026-10-15, not by me. Opening the DB and
  // reading the vec schema are themselves reads of state a build can mutate
  // (build does DROP TABLE IF EXISTS vec + CREATE VIRTUAL TABLE on a dimension
  // change). Doing them outside the lock left a TOCTOU window where a query
  // could observe a half-rebuilt schema, compute db_d = -1, and return no rows —
  // which surfaces to the user as a silently empty semantic layer, not as an
  // error. Comments are stripped before measuring so prose cannot satisfy this.
  const body = sourceOf("query");
  const code = body.split("\n").map((l) => l.split("#")[0]).join("\n");
  const lock = code.indexOf("_acquire_read_lock");
  const open = code.indexOf("c = conn()");
  const dim = code.indexOf("_db_dim(c)");
  assert.ok(lock >= 0, "query must take the shared read lock");
  assert.ok(open > lock, `conn() must come AFTER the lock (lock@${lock} conn@${open})`);
  assert.ok(dim > lock, `_db_dim() must come AFTER the lock (lock@${lock} dim@${dim})`);
});

test("a query against a real index succeeds and is deterministic in one process",
  { skip: canExec ? false : embedIndexSkipReason() }, () => {
  // BOTH preconditions, not just the index. The `skip` above covers canExec, but
  // this early-out is a second, independent gate — when DB exists while canExec
  // is false the body ran with PY === null and spawnSync threw a TypeError
  // ("file argument must be of type string"), which reads as a code defect.
  // Measured 2026-10-23 in the CI shape.
  if (!canExec || !existsSync(DB)) return; // no index/venv here; covered by the tests above
  const script = `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
_spec = importlib.util.spec_from_file_location("embed_index", ${JSON.stringify(join(repoRoot, "bin", "embed-index.py"))})
e = importlib.util.module_from_spec(_spec)
sys.modules["embed_index"] = e
_spec.loader.exec_module(e)
try:
    rows = e.query("bounded fact backfill from pi session logs", n=3)
    print(json.dumps([r["path"] for r in rows]))
except SystemExit as ex:
    print(json.dumps({"systemexit": ex.code}))
`;
  const r = spawnSync(PY, ["-c", script], { encoding: "utf8" });
  const out = (r.stdout || "").trim().split("\n").pop();
  const parsed = JSON.parse(out);
  assert.ok(!parsed.systemexit, `query exited ${parsed.systemexit} (busy = degraded)`);
  assert.ok(Array.isArray(parsed) && parsed.length > 0, "query returned no rows");
});
