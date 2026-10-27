// insert-searchable-roundtrip.test.mjs — the core product property had no test.
//
// Gap found 2026-10-23 while auditing what `npm test` actually executes.
// `tests/kbverify_insert_probe.py` performs the write→read roundtrip
// (insert_card a card, then query for its unique marker), but it is invoked ONLY
// by `bin/kb-verify.sh`, and NOTHING runs that: no test file, not ci.yml, not
// mise.toml. So the single most important behaviour of the product — "I indexed
// something, can I find it again?" — was verifiable only by a human running a
// script by hand. Every suite could be green while insert and query disagreed
// about where the index lives.
//
// TWO tests, deliberately, because they answer different questions and one of
// them cannot run in CI:
//
//   STRUCTURAL (runs in CI): stubs the encoder, exercises the real
//     insert_card → _upsert → vec table → query plumbing. The encoder is the one
//     part replaced, and it is not what "can I find what I inserted" is about —
//     the wiring is. This catches the outage that matters (a lost write, a path
//     key mismatch, a query hitting the wrong table) on a machine with no model.
//
//   END-TO-END (skips without a model): the shipping probe, real
//     SentenceTransformer, real embedding geometry. This is the fidelity check
//     and it is honest about needing ~100MB of torch + a model, which is why it
//     is not forced into CI.
//
// Neither asserts against a reimplementation of the logic: both drive the
// shipping module. A copy of the logic would test the copy — the mistake that
// made an earlier fixture pass for the wrong reason.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canLoadSqliteVec, embedIndexPython, embedIndexSkipReason, sqliteVecPython } from "./lib/python.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE = join(repoRoot, "tests", "kbverify_insert_probe.py");
const EMBED = join(repoRoot, "bin", "embed-index.py");
const BIN = join(repoRoot, "bin");

const REAL_PY = embedIndexPython();

/**
 * A python that can LOAD sqlite_vec — enough for the structural test, since that
 * one supplies its own encoder. On macOS the bundled sqlite3 is built
 * --disable-loadable-extensions, so this is Linux-only in practice; that is a
 * property of the platform, not something to work around.
 */
const VEC_PY = sqliteVecPython();

test("insert_card → query roundtrip works with every encoder stubbed out",
  { skip: VEC_PY ? false : "no python here can load sqlite_vec" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "heimdall-insert-structural-"));
  try {
    // Bag-of-words stub constrained to a fixed vocab: shared tokens give a real
    // cosine similarity, so the k-NN path runs for real. Only the model is fake.
    const script = `
import importlib.util, os, pathlib, sys, types
scratch = pathlib.Path(${JSON.stringify(scratch)})
os.environ["HEIMDALL_DB"] = str(scratch / "db.sqlite")
os.environ["HEIMDALL_HOME"] = str(scratch)
os.environ["HEIMDALL_LOCK"] = str(scratch / "lock")
sys.path.insert(0, ${JSON.stringify(BIN)})
import sqlite3, sqlite_vec
probe = sqlite3.connect(":memory:"); probe.enable_load_extension(True); sqlite_vec.load(probe)

DIM = 768
VOCAB = {}
class Stub:
    """Deterministic encoder: one dimension per vocab token. No model download."""
    def _vec(self, text):
        v = [0.0] * DIM
        for tok in str(text).lower().split():
            tok = "".join(ch for ch in tok if ch.isalnum())
            if not tok: continue
            VOCAB.setdefault(tok, len(VOCAB) % DIM)
            v[VOCAB[tok]] += 1.0
        n = sum(x * x for x in v) ** 0.5
        return [x / n for x in v] if n else v
    # The real SentenceTransformer returns ONE ROW PER TEXT (a list of lists).
    # Returning a flat vector made _flat_vec see floats instead of a row and
    # blow up — the stub must match the shape the caller unpacks, not a guess.
    def encode(self, text, normalize_embeddings=True, show_progress_bar=False):
        if isinstance(text, str):
            return self._vec(text)
        return [self._vec(t) for t in text]
\u0023 embed-index.py does "from sentence_transformers import SentenceTransformer" at
\u0023 MODULE TOP, so replacing model() afterwards is too late: the import fails
\u0023 first on a machine without torch. Register a fake module in sys.modules
\u0023 BEFORE the exec so the top-level import resolves to the stub.
fake = types.ModuleType("sentence_transformers")
fake.SentenceTransformer = lambda *a, **k: Stub()
sys.modules["sentence_transformers"] = fake

spec = importlib.util.spec_from_file_location("embed_index_probe", ${JSON.stringify(EMBED)})
m = importlib.util.module_from_spec(spec); sys.modules["embed_index_probe"] = m
spec.loader.exec_module(m)

m.model = lambda: Stub()
m._ram_ok = lambda *a, **k: True

card = scratch / "probe-fact.md"
card.write_text("# verify probe\\n\\nzzverify zzmarker unique content\\n", encoding="utf-8")
rc = m.insert_card(str(card))
print("INSERT_RC", rc)
c = sqlite3.connect(str(scratch / "db.sqlite"))
print("CARDS", c.execute("select count(*) from cards").fetchone()[0])
hits = m.query("zzverify zzmarker unique", n=2)
print("HITS", len(hits or []))
print("VERDICT", "SEARCHABLE" if rc == 0 and hits else "BROKEN")
`;
    const r = spawnSync(VEC_PY, ["-c", script], { encoding: "utf8", timeout: 300_000 });
    assert.equal(r.status, 0, `structural roundtrip crashed.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // insert_card must report success AND leave a row: a write that cannot be
    // read back is the failure mode this exists for.
    assert.match(r.stdout, /INSERT_RC 0/, `insert_card() did not report success:\n${r.stdout}`);
    assert.match(r.stdout, /CARDS 1/, `insert_card() left no row in cards:\n${r.stdout}`);
    assert.match(r.stdout, /VERDICT SEARCHABLE/,
      "insert_card() stored a card that query() could not find again — the write " +
      `path and the read path disagree about the index.\n${r.stdout}\n${r.stderr}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a card inserted with the real embedding model is searchable by its content",
  { skip: REAL_PY ? false : embedIndexSkipReason() }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "heimdall-insert-roundtrip-"));
  const out = join(scratch, "verdict.txt");
  try {
    // The probe reads HEIMDALL_SCRATCH and writes a scratch DB/lock under it,
    // so the operator's real ~/.heimdall index is never touched.
    const r = spawnSync(REAL_PY, [PROBE, EMBED, out], {
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, HEIMDALL_SCRATCH: scratch },
    });
    assert.equal(r.status, 0,
      `the insert probe crashed (exit ${r.status}).\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const verdict = readFileSync(out, "utf8").split("\n")[0].trim();
    // The probe's own vocabulary: INSERT-SEARCHABLE or INSERT-BROKEN.
    assert.equal(verdict, "INSERT-SEARCHABLE",
      "insert_card() stored a card that query() could not find again — the " +
      `write path and the read path disagree about the index.\n${readFileSync(out, "utf8").slice(0, 600)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
