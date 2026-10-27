// card-change-time.test.mjs — ctime_ns as card evidence (issue: restored mtime).
//
// WHY THIS EXISTS
// The search verdict rested STRONG on size + mtime agreeing with the index card.
// mtime is trivially restorable (`os.utime`), so a same-size rewrite that also
// restored mtime was indistinguishable from the indexed content — the card kept
// its stale hash and search kept certifying bytes it had never read. ctime_ns
// (the kernel's metadata-change time) is bumped by every write AND by utime, so
// it closes exactly that hole. This file pins the plumbing end to end:
//
//   * init() migrates a legacy cards table by ADDING a NULLABLE ctime_ns column,
//     with NO backfill (a legacy row's ctime is unknowable and may already be
//     stale — inventing one would fabricate evidence).
//   * the build fast-path re-reads a file whose ctime moved, or whose card has
//     no integer ctime at all, instead of trusting size+mtime.
//   * _upsert / _dup_card / insert_card persist the ctime they stat'd.
//   * the search verdict requires an exact integer ctime match and demotes a
//     legacy/NULL/invalid card to WEAK with a reindex reason (never INDEX_ERROR).
//
// The real module is driven directly. Heavy imports/encoder and the vector
// connection are fixture seams: plain SQLite represents vec rows and rejects
// extension loading. All index state is isolated before module import. This
// runs on stdlib Python without a model/download or a coverage-hiding skip.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { plainPython } from "./lib/python.mjs";

const shellTest = process.platform === "win32" ? test.skip : test;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(repoRoot, "bin");
const EMBED = join(BIN, "embed-index.py");
const KB_SEARCH = join(repoRoot, "bin", "kb-search.sh");
const python = plainPython();

// ── the embed-index driver ──────────────────────────────────────────────────
// One python process exercises every embed-index behaviour and prints a JSON
// report; the assertions below read that report. Each check is a real call into
// the shipping module, never a reimplementation.
const embedProbe = () => {
	const script = `
import atexit, importlib.util, json, os, pathlib, shutil, sqlite3, sys, tempfile, types

# Sandbox BEFORE importing: DB-derived lock/state globals must never point at
# the operator HOME, even if a later fixture override regresses.
root = pathlib.Path(tempfile.mkdtemp(prefix="heimdall-ctime-probe-")).resolve()
atexit.register(shutil.rmtree, root, ignore_errors=True)
os.environ["HOME"] = str(root / "process-home")
os.environ["HEIMDALL_HOME"] = str(root / "home")
os.environ["HEIMDALL_DB"] = str(root / "bootstrap.db")

# Stub the two heavy imports at the boundary, exactly as the vec-dim suite does.
for n in ("sqlite_vec", "sentence_transformers"):
    m = types.ModuleType(n)
    m.load = lambda *a, **k: None
    m.SentenceTransformer = lambda *a, **k: None
    sys.modules[n] = m

sys.path.insert(0, ${JSON.stringify(BIN)})
spec = importlib.util.spec_from_file_location("ei", ${JSON.stringify(EMBED)})
ei = importlib.util.module_from_spec(spec)
sys.modules["ei"] = ei
spec.loader.exec_module(ei)

DIM = ei.DIM
encoded = {"texts": 0}

class Stub:
    def encode(self, text, normalize_embeddings=True, show_progress_bar=False):
        if isinstance(text, str):
            encoded["texts"] += 1
            return [0.0] * DIM
        encoded["texts"] += len(text)
        return [[0.0] * DIM for _ in text]

ei.model = lambda: Stub()
ei._ram_ok = lambda *a, **k: True

out = {}
ei.LOCK_PATH = root / "fixture.lock"
ei.STATE_PATH = root / "semantic-state.json"

# Model a stdlib Python whose SQLite cannot load extensions. Every connection
# is also confined to the private fixture, so accidental production conn() use
# fails safely instead of making the test depend on the operator environment.
_connect = sqlite3.connect
class PlainConnection(sqlite3.Connection):
    def enable_load_extension(self, *args, **kwargs):
        raise AttributeError("fixture SQLite has no extension-loading API")

def fixture_connect(database, *args, **kwargs):
    if str(database) != ":memory:":
        path = pathlib.Path(database).resolve()
        assert root in path.parents, "connection escaped the private fixture"
    kwargs["factory"] = PlainConnection
    return _connect(database, *args, **kwargs)
sqlite3.connect = fixture_connect

def plain(dbpath):
    # A PLAIN vec table whose declared dimension _db_dim() can parse: this keeps
    # init() from needing the real sqlite-vec extension (which would then need a
    # venv). Everything else is the shipping code path.
    c = sqlite3.connect(str(dbpath))
    c.execute("CREATE TABLE IF NOT EXISTS vec (embedding float[%d])" % DIM)
    return c

# The real insert/upsert code runs against the same plain SQLite fixture as
# build. Production conn() deliberately requires sqlite-vec; this unit does not.
ei.conn = lambda: plain(ei.DB)

# 1. fresh init() creates ctime_ns
c = plain(root / "fresh.db")
ei.init(c)
out["fresh_has_ctime"] = "ctime_ns" in [r[1] for r in c.execute("PRAGMA table_info(cards)")]
c.close()

# 2. legacy migration: ALTER adds a NULL ctime, keeps the row, backfills nothing,
#    and is idempotent.
c = plain(root / "legacy.db")
c.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, "
          "title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, "
          "root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL)")
c.execute("INSERT INTO cards (id, path, title, body, sha1, root, mtime, size) "
          "VALUES ('f:/legacy.py','/legacy.py','legacy.py','body','s1','/r',1.5,10)")
c.commit()
ei.init(c)
ei.init(c)  # must be safe to run twice
row = c.execute("SELECT id, mtime, size, ctime_ns FROM cards").fetchone()
out["legacy_has_ctime"] = "ctime_ns" in [r[1] for r in c.execute("PRAGMA table_info(cards)")]
out["legacy_row_kept"] = row[0] == "f:/legacy.py" and row[1] == 1.5 and row[2] == 10
out["legacy_ctime_null"] = row[3] is None
c.close()

# 3. build fast-path. HEIMDALL_HOME holds the corpus; the DB lives OUTSIDE it so
#    the index's own files are not discovered as content.
home = root / "home"
home.mkdir()
ei.HOME_ROOT = home
ei.DB = root / "global.db"
src = home / "src"
src.mkdir()
f = src / "a.py"
orig = "print('preview content here long enough')\\n"
f.write_text(orig)

reads = {"n": 0}
_orig_read = ei.embed_walker.read_preview
def counting(p, *a, **k):
    reads["n"] += 1
    return _orig_read(p, *a, **k)
ei.embed_walker.read_preview = counting

def build():
    c = plain(ei.DB)
    ei._build_inner(c, 5000)
    c.close()

def card_row(db, cid):
    c = sqlite3.connect(str(db))
    try:
        return c.execute("SELECT ctime_ns, size, mtime, body FROM cards WHERE id=?", (cid,)).fetchone()
    finally:
        c.close()

build()
cid = "f:" + str(f)
first_reads = reads["n"]
st = f.stat()
row = card_row(ei.DB, cid)
out["first_reads"] = first_reads
out["first_ctime_matches"] = row[0] == st.st_ctime_ns
out["first_size_matches"] = row[1] == st.st_size

# unchanged: the fast-path must skip the read entirely
build()
out["second_reads"] = reads["n"]
out["unchanged_skipped"] = reads["n"] == first_reads

# same-size rewrite that restores mtime: only ctime moves, and it must re-read
st = f.stat()
alt = orig.replace("preview", "REWRITE")
assert len(alt) == len(orig)
f.write_text(alt)
os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
st2 = f.stat()
out["rewrite_same_size"] = st2.st_size == st.st_size
out["rewrite_mtime_restored"] = st2.st_mtime_ns == st.st_mtime_ns
out["rewrite_ctime_changed"] = st2.st_ctime_ns != st.st_ctime_ns
before = reads["n"]
build()
out["changed_ctime_reread"] = reads["n"] > before
out["reread_card_ctime_matches"] = card_row(ei.DB, cid)[0] == f.stat().st_ctime_ns
out["reread_body_updated"] = "REWRITE" in card_row(ei.DB, cid)[3]

# missing ctime (legacy NULL): no evidence, so re-read and repopulate
c = sqlite3.connect(str(ei.DB))
c.execute("UPDATE cards SET ctime_ns=NULL WHERE id=?", (cid,))
c.commit()
c.close()
before = reads["n"]
encoded_before = encoded["texts"]
build()
out["missing_ctime_reread"] = reads["n"] > before
out["missing_ctime_repopulated"] = card_row(ei.DB, cid)[0] == f.stat().st_ctime_ns
out["missing_ctime_reused_vector"] = encoded["texts"] == encoded_before

# 4. _upsert / _dup_card persist the ctime they were handed
c = plain(root / "upsert.db")
ei.init(c)
f2 = src / "b.py"
f2.write_text("canonical content for the dedupe copy\\n")
st = f2.stat()
ei._upsert(c, Stub(), [("f:" + str(f2), "src/b.py", "canon body", "shaCANON",
                        st.st_mtime, st.st_size, st.st_ctime_ns)])
out["upsert_ctime"] = c.execute("SELECT ctime_ns FROM cards WHERE id=?",
                                ("f:" + str(f2),)).fetchone()[0] == st.st_ctime_ns
# Duplicate batch: vector copied from the canonical card, ctime from the tuple.
ei._upsert(c, Stub(), [("f:dup", "src/dup.py", "dup body", "shaCANON",
                        2.0, 7, 1700000000000000000)], allow_dupes=True)
drow = c.execute("SELECT ctime_ns, size FROM cards WHERE id='f:dup'").fetchone()
out["dup_ctime"] = drow is not None and drow[0] == 1700000000000000000
out["dup_size"] = drow is not None and drow[1] == 7
c.close()

# 5. insert_card records the ctime of the file it indexed
ei.DB = root / "insert.db"
plain(ei.DB).close()
card = home / "card.md"
card.write_text("# Title\\n\\nunique zzq marker content here\\n")
st = card.stat()
rc = ei.insert_card(str(card))
row = card_row(ei.DB, "f:" + str(card))
out["insert_rc"] = rc
out["insert_ctime"] = row[0] == st.st_ctime_ns
out["insert_size"] = row[1] == st.st_size

# 6. edit-during-read: insert_card stats BEFORE it reads, so a write that lands
#    mid-read leaves the card's ctime stale relative to the file — the hit stays
#    unverifiable instead of being certified with post-edit metadata.
ei.DB = root / "race.db"
plain(ei.DB).close()
race = home / "race.md"
race.write_text("AAAA original body content zzz\\n")
alt = "BBBB original body content zzz\\n"
assert len(alt) == len(race.read_text())
def racing_read(p, *a, **k):
    body = _orig_read(p, *a, **k)
    st = p.stat()
    p.write_text(alt)
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))  # restore mtime, not ctime
    return body
ei.embed_walker.read_preview = racing_read
race_before = race.stat()
rc = ei.insert_card(str(race))
after = race.stat()
row = card_row(ei.DB, "f:" + str(race))
out["race_rc"] = rc
out["race_card_body_is_old"] = "AAAA" in row[3]
out["race_card_ctime_is_preedit"] = row[0] == race_before.st_ctime_ns
out["race_ctime_changed"] = after.st_ctime_ns != race_before.st_ctime_ns
out["race_mtime_restored"] = after.st_mtime_ns == race_before.st_mtime_ns
out["race_size_preserved"] = after.st_size == race_before.st_size
out["private_lock_used"] = ei.LOCK_PATH.parent == root and ei.LOCK_PATH.is_file()
out["private_state_path"] = ei.STATE_PATH.parent == root

shutil.rmtree(root)
print(json.dumps(out))
`;
	const r = spawnSync(python, ["-c", script], { encoding: "utf8", timeout: 120_000 });
	assert.equal(r.status, 0, `embed-index probe crashed.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
	return JSON.parse((r.stdout || "").trim().split("\n").pop());
};

const embed = embedProbe();

test("init() migrates a legacy cards table non-destructively: NULL ctime, no backfill", () => {
	assert.equal(embed.fresh_has_ctime, true, "a fresh cards table must carry ctime_ns");
	assert.equal(embed.legacy_has_ctime, true, "init() must ALTER the ctime_ns column in");
	assert.equal(embed.legacy_row_kept, true, "the migration must not drop the legacy row");
	assert.equal(embed.legacy_ctime_null, true,
		"a legacy row must NOT gain ctime by a metadata-only backfill — its file may already be stale");
});

test("the build fast-path skips only when size, mtime AND integer ctime all agree", () => {
	assert.equal(embed.first_reads, 1, "the first build must read the one file exactly once");
	assert.equal(embed.first_ctime_matches, true, "the card must record the file's ctime_ns");
	assert.equal(embed.first_size_matches, true, "the card must still record the file's size");
	assert.equal(embed.unchanged_skipped, true, "an unchanged file must be skipped without a re-read");

	assert.equal(embed.rewrite_same_size, true, "fixture: the rewrite must keep the size");
	assert.equal(embed.rewrite_mtime_restored, true, "fixture: the rewrite must restore the mtime");
	assert.equal(embed.rewrite_ctime_changed, true, "fixture: the rewrite must move the ctime");
	assert.equal(embed.changed_ctime_reread, true,
		"a same-size, restored-mtime rewrite must be re-read, not fast-pathed on size+mtime");
	assert.equal(embed.reread_card_ctime_matches, true, "the re-read must refresh the stored ctime");
	assert.equal(embed.reread_body_updated, true, "a real rewrite must refresh indexed text, not just stamp metadata");

	assert.equal(embed.missing_ctime_reread, true, "a card with NULL ctime has no evidence and must be re-read");
	assert.equal(embed.missing_ctime_repopulated, true, "the re-read must repopulate the ctime");
});

test("legacy evidence is refreshed only after a real read, without re-encoding an unchanged preview", () => {
	assert.equal(embed.missing_ctime_reread, true, "metadata-only backfill would certify unverified content");
	assert.equal(embed.missing_ctime_repopulated, true, "verified metadata must be refreshed");
	assert.equal(embed.missing_ctime_reused_vector, true, "an identical, re-read preview should reuse its existing vector");
});

test("_upsert and _dup_card persist the ctime they were handed", () => {
	assert.equal(embed.upsert_ctime, true, "_upsert must store the batch tuple's ctime_ns");
	assert.equal(embed.dup_ctime, true, "_dup_card must store the duplicate's ctime_ns");
	assert.equal(embed.dup_size, true, "_dup_card must still store the duplicate's size");
});

test("insert_card records the file's ctime, and stats before it reads", () => {
	assert.equal(embed.insert_rc, 0, "insert_card must report success");
	assert.equal(embed.insert_ctime, true, "insert_card must store the file's ctime_ns");
	assert.equal(embed.insert_size, true, "insert_card must still store the file's size");

	assert.equal(embed.race_rc, 0, "insert_card must report success under a mid-read edit");
	assert.equal(embed.race_card_body_is_old, true, "fixture: the card must hold the pre-edit body");
	assert.equal(embed.race_mtime_restored, true, "fixture: the mid-read rewrite must restore mtime");
	assert.equal(embed.race_size_preserved, true, "fixture: only ctime should expose the mid-read rewrite");
	assert.equal(embed.race_ctime_changed, true, "fixture: the rewrite must actually advance ctime");
	assert.equal(embed.race_card_ctime_is_preedit, true,
		"stat must come BEFORE the read: a mid-read write must leave the card's ctime stale (unverifiable), " +
		"not paired with post-edit metadata");
});

test("the insert probe uses private lock/state paths and needs no extension-loading API", () => {
	assert.equal(embed.private_lock_used, true, "insert_card must use the fixture lock, never an operator lock");
	assert.equal(embed.private_state_path, true, "telemetry must also stay inside the fixture");
	assert.equal(embed.insert_rc, 0, "the real insert path must work with the extension-free fixture connection");
});

// ── the search verdict side ─────────────────────────────────────────────────
// A compact sandbox (same shape as tests/kb-search-identity.test.mjs): a graft
// stub returns one hit, a cards DB supplies the evidence.
function sandbox() {
	const home = mkdtempSync(join(tmpdir(), "heimdall-ctime-"));
	const graft = join(home, ".local", "bin", "graft");
	mkdirSync(dirname(graft), { recursive: true });
	copyFileSync(join(repoRoot, "tests", "fixtures", "fake-graft.sh"), graft);
	chmodSync(graft, 0o755);
	const repo = join(home, "Repos", "example");
	mkdirSync(join(repo, "graft"), { recursive: true });
	const hit = join(repo, "src", "file.py");
	mkdirSync(dirname(hit), { recursive: true });
	writeFileSync(hit, "print('indexed payload')\n");
	return { home, hit, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const MODERN_DDL = "CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, ctime_ns INTEGER)";
const LEGACY_DDL = "CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL)";

/**
 * Write one card row. `legacy` omits the ctime_ns column entirely; otherwise
 * `ctime_ns` may be a BigInt (real evidence), null (SQL NULL), or a string
 * (invalid: SQLite stores TEXT in the INTEGER column).
 */
function writeCard(home, path, { size, mtime, ctime_ns = null, legacy = false }) {
	const db = join(home, ".heimdall", "global.db");
	mkdirSync(dirname(db), { recursive: true });
	const cols = legacy
		? "(id, path, title, body, sha1, root, mtime, size)"
		: "(id, path, title, body, sha1, root, mtime, size, ctime_ns)";
	const ctime = ctime_ns === null ? "NULL" : typeof ctime_ns === "string" ? JSON.stringify(ctime_ns) : String(ctime_ns);
	const vals = legacy
		? '("1", ?, "Expected hit", "example", "s1", "r", ?, ?)'
		: `("1", ?, "Expected hit", "example", "s1", "r", ?, ?, ${ctime})`;
	execFileSync("/usr/bin/python3", ["-c", [
		"import sqlite3,sys",
		`con = sqlite3.connect(${JSON.stringify(db)})`,
		`con.execute(${JSON.stringify(legacy ? LEGACY_DDL : MODERN_DDL)})`,
		`con.execute(${JSON.stringify(`INSERT INTO cards ${cols} VALUES ${vals}`)}, (${JSON.stringify(path)}, ${JSON.stringify(mtime)}, ${size}))`,
		"con.commit()",
	].join("; ")]);
	return db;
}

const search = (home, extra = {}) => execFileSync("bash", [KB_SEARCH, "example"], {
	encoding: "utf8",
	env: {
		...process.env,
		HOME: home,
		PATH: "/usr/bin:/bin",
		GRAFT: undefined,
		MNEMOSYNE: undefined,
		HEIMDALL_BACKEND: undefined,
		...extra,
	},
});

const cardFor = (path) => {
	const st = statSync(path);
	const bst = statSync(path, { bigint: true });
	return { size: st.size, mtime: st.mtimeMs / 1000, ctime_ns: bst.ctimeNs };
};

shellTest("ctime evidence: an unchanged card is STRONG, legacy/NULL/invalid is WEAK, not INDEX_ERROR", () => {
	// unchanged: size + mtime + ctime all agree => STRONG
	{
		const { home, hit, cleanup } = sandbox();
		try {
			writeCard(home, hit, cardFor(hit));
			const stdout = search(home);
			assert.match(stdout, /\[STRONG\]/, `an unchanged card with real ctime must be STRONG:\n${stdout}`);
		} finally { cleanup(); }
	}

	// Each of the three "no usable ctime" shapes must demote to WEAK with the
	// reindex reason, and must NOT be mistaken for an unreadable index.
	const cases = [
		["legacy schema (no ctime_ns column)", (c) => writeCard(c.home, c.hit, { ...cardFor(c.hit), legacy: true })],
		["NULL ctime_ns", (c) => writeCard(c.home, c.hit, { ...cardFor(c.hit), ctime_ns: null })],
		["non-integer ctime_ns", (c) => writeCard(c.home, c.hit, { ...cardFor(c.hit), ctime_ns: "not-an-int" })],
	];
	for (const [label, seed] of cases) {
		const { home, hit, cleanup } = sandbox();
		try {
			seed({ home, hit });
			const stdout = search(home);
			assert.match(stdout, /Expected hit/, `${label}: hit still returned`);
			assert.doesNotMatch(stdout, /\[STRONG\]/, `${label}: unverified ctime must not be STRONG:\n${stdout}`);
			assert.match(stdout, /\[WEAK\s*\]/, `${label}: must be WEAK`);
			assert.match(stdout, /no change-time evidence/, `${label}: the reason must name the missing evidence`);
			assert.match(stdout, /reindex/, `${label}: the reason must name the remedy`);
			assert.match(stdout, /freshness_unknown/, `${label}: incomplete evidence must not be called fresh`);
			assert.doesNotMatch(stdout, /\bfresh\b/, `${label}: unknown metadata is not fresh`);
			assert.doesNotMatch(stdout, /INDEX_ERROR/, `${label}: a legacy schema is readable, not an index error:\n${stdout}`);
		} finally { cleanup(); }
	}
});

shellTest("ctime evidence: the verdict pass opens no target file", () => {
	const { home, hit, cleanup } = sandbox();
	const hookDir = mkdtempSync(join(tmpdir(), "heimdall-ctime-audit-"));
	try {
		writeCard(home, hit, cardFor(hit));
		const auditLog = join(hookDir, "opens.txt");
		writeFileSync(join(hookDir, "sitecustomize.py"), [
			"import sys, os",
			"fd = os.open(os.environ['AUDIT_LOG'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)",
			"os.write(fd, b'loaded\\n')",
			"def audit(event, args):",
			"    if event == 'open' and args[0] == os.environ['AUDIT_TARGET']:",
			"        os.write(fd, b'TARGET_OPEN\\n')",
			"sys.addaudithook(audit)",
			"",
		].join("\n"));

		const stdout = search(home, { PYTHONPATH: hookDir, AUDIT_LOG: auditLog, AUDIT_TARGET: hit });
		assert.match(stdout, /\[STRONG\]/, "the no-read control must actually verify the card");
		assert.ok(existsSync(auditLog), "audit hook did not run — the instrument is broken, not the code");
		const opens = readFileSync(auditLog, "utf8");
		assert.match(opens, /loaded/, "the audit instrument must be active");
		assert.doesNotMatch(opens, /TARGET_OPEN/, "the ctime check must be a stat, not a read");
		// Positive control: the instrument must detect a deliberate fixture open,
		// not merely announce that sitecustomize loaded successfully.
		execFileSync(python, ["-c", "import os; open(os.environ['AUDIT_TARGET'], 'rb').close()"], {
			env: { ...process.env, PYTHONPATH: hookDir, AUDIT_LOG: auditLog, AUDIT_TARGET: hit },
		});
		assert.match(readFileSync(auditLog, "utf8"), /TARGET_OPEN/, "audit hook must detect an actual target open");
	} finally {
		rmSync(hookDir, { recursive: true, force: true });
		cleanup();
	}
});
