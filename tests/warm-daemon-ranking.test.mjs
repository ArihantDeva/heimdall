// Warm ranking CONTRACT tests only: prescribed scores, private Unix sockets,
// temporary sqlite cards and fake retrieval/encoder/native service. No models,
// live index, target-file reads, corpus labels, or retrieval-quality claims.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, "bin");

const PRELUDE = String.raw`
import builtins, concurrent.futures, contextlib, copy, hashlib, importlib.abc, importlib.util
import json, os, pathlib, socket, sqlite3, struct, sys, threading, time, types

ROOT = pathlib.Path(os.environ["FIXTURE_ROOT"])
BIN = pathlib.Path(os.environ["FIXTURE_BIN"])
for key in ("HEIMDALL_RERANK_SOCKET", "GRAFT_SOCKET"):
    os.environ.pop(key, None)

class NoRealModelImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in ("torch", "sentence_transformers", "sqlite_vec", "numpy"):
            raise AssertionError("real model/package import is forbidden: " + fullname)
sys.meta_path.insert(0, NoRealModelImports())

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

qs = load("warm_fixture_server", BIN / "query-server.py")
wr = load("warm_fixture_adapter", BIN / "warm_rerank.py")
client = load("warm_fixture_client", BIN / "candidate_scorer.py")

class FakeEI:
    """Only the card connection is real sqlite; retrieval never uses a model."""
    serial = 0
    def __init__(self, rows=()):
        FakeEI.serial += 1
        self.db = ROOT / ("cards-%s.db" % FakeEI.serial)
        self.conn_calls = 0
        self.trace = []
        c = sqlite3.connect(self.db)
        c.execute("CREATE TABLE cards(path TEXT UNIQUE, title, body, sha1, root)")
        c.executemany("INSERT INTO cards VALUES(?,?,?,?,?)", rows)
        c.commit()
        c.close()
    def conn(self):
        self.conn_calls += 1
        c = sqlite3.connect(self.db)
        c.set_trace_callback(self.trace.append)
        return c

def card(path, title=None, body=None, sha1=None):
    title = title if title is not None else "indexed title " + path
    body = body if body is not None else "Exact indexed body for " + path + "\nnot a target-file read"
    sha1 = sha1 if sha1 is not None else hashlib.sha1(body.encode()).hexdigest()
    return (path, title, body, sha1, "/fixed-root")

def lex(path, score=1.0, **extra):
    return {"path": path, "title": "retrieval title " + path, "score": score,
            "body": "lexical hit [%s]" % path, "leg": "lexical", **extra}

def fixed_legs(lexical, semantic=(), *, fail=False):
    calls = []
    def l(ei, q, n, scope=None):
        calls.append(("lexical", n, scope))
        return [dict(h) for h in lexical if not scope or scope in h["path"]]
    def s(ei, q, n=6, related=False):
        calls.append(("semantic", n, related))
        if fail:
            raise RuntimeError("fixture semantic leg unavailable")
        return [dict(h) for h in semantic]
    qs.lexical_hits = l
    qs._semantic_hits = s
    return calls

def rpc(ei, **req):
    reply, stop = qs.handle_request(ei, {"op": "search", "q": "title", **req})
    assert stop is False
    # This is the actual socket JSON representation; list-subclass attributes
    # must not leak into hits/default-false responses.
    return json.loads(json.dumps(reply, allow_nan=False))

def title_jaccard(a, b):
    # Fixture of the existing byte/ASCII, two-space-padded title trigrams. It
    # never scores bodies; these values are diagnostics, not relevance labels.
    def grams(text):
        if not text:
            return set()
        text = b"  " + text.encode().lower() + b"  "
        return {text[i:i+3] for i in range(len(text) - 2)}
    a, b = grams(a), grams(b)
    return len(a & b) / len(a | b) if a or b else 0.0

def envelope(request, *, scores=None, status="applied", reason="fixture", ce_statuses=None):
    args = request["args"]
    items = args["candidates"]
    n = len(items)
    scores = list(scores) if scores is not None else [0.25] * n
    if not n:
        status = "empty"
    applied = status == "applied"
    if ce_statuses is None:
        ce_statuses = ["ok" if applied else status] * n
    order = sorted(range(n), key=lambda i: (-scores[i], i)) if applied else list(range(n))
    ranks = {i: rank for rank, i in enumerate(order, 1)}
    rows = [{
        "id": h["id"], "original_rank": i + 1, "rank": ranks[i],
        "s_vec": h["s_vec"], "s_lex": title_jaccard(args["query"], h["title"]),
        "s_lex_source": "title_trigram_jaccard",
        "s_ce": scores[i] if ce_statuses[i] == "ok" else None,
        "ce_status": ce_statuses[i], "document_bytes": len(h["document"].encode()),
    } for i, h in enumerate(items)]
    return {"status": 0, "result": {
        "version": 1, "status": status, "reason": reason, "applied": applied,
        "method": "cross_encoder" if applied else "original_order",
        "candidate_count": n, "scored_count": sum(r["ce_status"] == "ok" for r in rows),
        "results": rows,
    }}

class PrivateScorer:
    serial = 0
    def __init__(self, response=None, *, stall=False):
        PrivateScorer.serial += 1
        self.path = str(ROOT / ("scorer-%s.sock" % PrivateScorer.serial))
        self.response = response or (lambda r: envelope(r))
        self.stall = stall
        self.requests = []
        self.errors = []
        self.stop = threading.Event()
        self.release = threading.Event()
        self.threads = []
    def exact(self, conn, n):
        chunks = []
        while n:
            data = conn.recv(n)
            if not data:
                raise AssertionError("fixture request unexpectedly truncated")
            chunks.append(data)
            n -= len(data)
        return b"".join(chunks)
    def handle(self, conn):
        try:
            with conn:
                conn.settimeout(2)
                size = struct.unpack("<I", self.exact(conn, 4))[0]
                assert size <= 4 * 1024 * 1024
                request = client._unpack(self.exact(conn, size))
                self.requests.append(request)
                assert request["op"] == "score_candidates"
                if self.stall:
                    # No response until test teardown: this pins a timeout, not
                    # latency/performance or backend cancellation.
                    self.release.wait(3)
                    return
                payload = client._pack(self.response(request))
                conn.sendall(struct.pack("<I", len(payload)) + payload)
        except Exception as error:
            self.errors.append(repr(error))
    def run(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            t = threading.Thread(target=self.handle, args=(conn,), daemon=True)
            self.threads.append(t)
            t.start()
    def __enter__(self):
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(self.path)
        os.chmod(self.path, 0o600)
        self.srv.listen(8)
        self.srv.settimeout(0.02)
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
        os.environ["HEIMDALL_RERANK_SOCKET"] = self.path
        return self
    def __exit__(self, *exc):
        self.stop.set()
        self.release.set()
        self.srv.close()
        self.thread.join(3)
        for t in self.threads:
            t.join(3)
        assert not self.thread.is_alive()
        assert not self.errors, self.errors
        os.environ.pop("HEIMDALL_RERANK_SOCKET", None)


def assert_preserved(got, original):
    assert {h["path"] for h in got} == {h["path"] for h in original}
    by_path = {h["path"]: h for h in original}
    for h in got:
        old = by_path[h["path"]]
        for key, value in old.items():
            if key != "score":
                assert h[key] == value, (key, h, old)
        assert h["retrieval_score"] == old["score"]
        assert "signals" in h and "provenance" in h
        assert "verdict" not in h or h["verdict"] == old.get("verdict")
`;

function run(body) {
  // Keep AF_UNIX addresses short even when macOS TMPDIR is a long per-user path.
  const dir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "hwr-"));
  try {
    const r = spawnSync("python3", ["-I", "-B", "-c", PRELUDE + "\n" + body], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          !key.startsWith("HEIMDALL_") && !key.startsWith("GRAFT_") && !key.startsWith("PYTHON"))),
        HOME: dir,
        FIXTURE_ROOT: dir,
        FIXTURE_BIN: BIN,
        HEIMDALL_SEARCH_DEADLINE: "10",
        HF_HUB_OFFLINE: "1",
      },
    });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("opt-in freezes existing fused membership/default six, dedupe, scope, legs and related", () => {
  run(String.raw`
lexical = [lex("/scope/graft/dup", 6), lex("/scope/graft/lex", 5),
           lex("/scope/graft/tail", 1), lex("/elsewhere/graft/out", 100)]
semantic = [
    {"path": "/scope/graft/dup", "title": "semantic duplicate", "score": 0.9, "s_vec": 0.91234567},
    {"path": "/scope/sem-a", "title": "semantic A", "score": 0.8765, "s_vec": 0.87654321},
    {"path": "/elsewhere/sem-out", "title": "out", "score": 1, "s_vec": 1.0},
    {"path": "/scope/sem-b", "title": "semantic B", "score": 0.0, "s_vec": 0.0},
    {"path": "/scope/neighbor", "title": "structural", "score": 0.0, "related": True},
    {"path": "/scope/extra", "title": "not in the frozen six", "score": -0.8, "s_vec": -0.8123456},
]
calls = fixed_legs(lexical, semantic)
paths = [h["path"] for h in lexical + semantic]
ei = FakeEI([card(p) for p in set(paths)])
old = rpc(ei, scope="/scope", related=True)
assert "rerank" not in old
assert len(old["hits"]) == 6
assert [h["path"] for h in old["hits"]] == [
    "/scope/graft/dup", "/scope/graft/lex", "/scope/sem-a", "/scope/sem-b", "/scope/neighbor", "/scope/extra"]
assert all("signals" not in h and "s_vec" not in h for h in old["hits"])
with PrivateScorer(lambda r: envelope(r, scores=[0.1, 0.9, 0.7, 0.7, 0.6, 0.2])) as svc:
    got = rpc(ei, rerank=True, scope="/scope", related=True)
assert got["rerank"]["status"] == "applied"
assert got["rerank"]["candidate_count"] == 6
assert got["sem_coverage"] == "ok"
assert_preserved(got["hits"], old["hits"])
assert [h["retrieval_rank"] for h in got["hits"]] == [2, 3, 4, 5, 6, 1]
assert [h["rank"] for h in got["hits"]] == list(range(1, 7))
assert sorted(got["hits"], key=lambda h: -h["score"]) == got["hits"]
assert all(h["score_kind"] == "order_key" for h in got["hits"])
assert [h["ranking_score"] for h in got["hits"]] == [0.9, 0.7, 0.7, 0.6, 0.2, 0.1]
request = svc.requests[0]
assert len(request["args"]["candidates"]) == 6
# Lexical winner has the real semantic producer signal, not lexical 6 or +3.9.
assert [h["s_vec"] for h in request["args"]["candidates"]] == [0.91234567, None, 0.87654321, 0.0, None, -0.8123456]
assert [c[1] for c in calls] == [6, 6, 6, 6]
assert ei.conn_calls == 1
assert rpc(ei, rerank=False, scope="/scope", related=True) == old
`);
});

test("first-25 window only; tail order/scores unchanged and downstream score-sort retains final ranks", () => {
  run(String.raw`
# Requested n exceeds available hits: order keys must be offset ABOVE the old
# tail scores, not blindly use len(hits)-rank and let a downstream sort undo it.
lexical = [lex("/scope/graft/%02d" % i, 100.0 - i, related=bool(i % 2), verdict="WEAK") for i in range(30)]
calls = fixed_legs(lexical)
ei = FakeEI([card(h["path"]) for h in lexical])
old = rpc(ei, n=100, scope="/scope")
with PrivateScorer(lambda r: envelope(r, scores=[i / 25 for i in range(25)])) as svc:
    got = rpc(ei, n=100, rerank=True, scope="/scope")
assert_preserved(got["hits"], old["hits"])
assert len(svc.requests) == 1 and len(svc.requests[0]["args"]["candidates"]) == 25
assert got["rerank"]["candidate_count"] == 25
assert got["rerank"]["tail_count"] == 5
assert got["rerank"]["total_count"] == 30
assert [h["path"] for h in got["hits"][:25]] == [h["path"] for h in reversed(old["hits"][:25])]
for new, old_hit in zip(got["hits"][25:], old["hits"][25:]):
    assert all(new[k] == v for k, v in old_hit.items())
    assert new["signals"]["ce_status"] == "not_scored"
    assert new["provenance"]["card_status"] == "outside_window"
    assert new["ranking_score"] is None and new["score_kind"] == "retrieval"
assert [h["rank"] for h in got["hits"]] == list(range(1, 31))
assert sorted(got["hits"], key=lambda h: -h["score"]) == got["hits"]
assert len([sql for sql in ei.trace if sql.startswith("SELECT")]) == 1
assert [h["id"] for h in svc.requests[0]["args"]["candidates"]] == ["warm:%s" % i for i in range(1, 26)]
assert all(c[1] == 100 for c in calls)
`);
});

test("one indexed title/body/sha1 snapshot reaches scorer, with no target opens or document truncation", () => {
  run(String.raw`
path = "/forbidden-target/graft/example.md"
body = "Exact current indexed body é\n" + "Z" * 4097
row = card(path, title="current indexed title", body=body, sha1="stored-index-sha1-not-recomputed")
ei = FakeEI([row])
fixed_legs([lex(path, 2.0)])
original_open, original_os_open, original_stat, original_lstat, original_scan = builtins.open, os.open, os.stat, os.lstat, os.scandir
opens = []
def guard(fn):
    def checked(p, *a, **kw):
        if str(p).startswith("/forbidden-target"):
            opens.append(str(p))
            raise AssertionError("target open/stat forbidden")
        return fn(p, *a, **kw)
    return checked
builtins.open, os.open = guard(original_open), guard(original_os_open)
os.stat, os.lstat, os.scandir = guard(original_stat), guard(original_lstat), guard(original_scan)
try:
    with PrivateScorer() as svc:
        got = rpc(ei, rerank=True)
finally:
    builtins.open, os.open = original_open, original_os_open
    os.stat, os.lstat, os.scandir = original_stat, original_lstat, original_scan
assert not opens
sent = svc.requests[0]["args"]["candidates"][0]
assert sent["title"] == row[1] and sent["document"] == body
hit = got["hits"][0]
assert hit["title"] == "retrieval title " + path
assert hit["body"] == "lexical hit [%s]" % path
assert hit["provenance"] == {
    "document_source": "cards.body", "title_source": "cards.title",
    "card_sha1": row[3], "card_status": "ready",
    "scoring_input_sha256": hashlib.sha256(b"heimdall-scoring-text-v1\0" +
        len(row[1].encode()).to_bytes(8, "big") + row[1].encode() + body.encode()).hexdigest()}
assert hit["signals"]["document_bytes"] == len(body.encode())
assert ei.conn_calls == 1
assert sum(s == "BEGIN" for s in ei.trace) == 1
assert sum(s.startswith("SELECT path, title, body, sha1 FROM cards") for s in ei.trace) == 1
assert not any(s.startswith(("INSERT", "UPDATE", "DELETE", "CREATE", "DROP")) for s in ei.trace)
`);
});

test("missing, unreadable, empty, non-string, name-only and dataless cards degrade the entire original window", () => {
  run(String.raw`
path, good = "/targets/graft/bad.md", "/targets/graft/good.md"
fixed_legs([lex(good, 2.0), lex(path, 1.0)])
variants = [
    (None, "card_missing"),
    (card(path, body="[minimal file]\nbad.md"), "card_name_only"),
    (card(path, body="[dataless placeholder — filename only, content in iCloud]\nbad.md"), "card_name_only"),
    (card(path, body="irrelevant stored name-only marker", sha1="name:01234"), "card_name_only"),
    (card(path, body="bad.md"), "card_name_only"),
    (card(path, body="   \n"), "card_empty_body"),
    ((path, "title", b"blob is not a string", "sha1", "/root"), "card_nonstring"),
    ((path, 17, "body", "sha1", "/root"), "card_nonstring"),
    ((path, "title", "body", None, "/root"), "card_nonstring"),
    (card(path, sha1=""), "card_missing_sha1"),
]
with PrivateScorer() as svc:
    for bad, reason in variants:
        ei = FakeEI([card(good)] + ([bad] if bad else []))
        old = rpc(ei)
        got = rpc(ei, rerank=True)
        assert got["rerank"]["status"] == "unavailable", got
        assert got["rerank"]["reason"] == reason, got
        assert got["rerank"]["scored_count"] == 0
        assert [h["path"] for h in got["hits"]] == [h["path"] for h in old["hits"]]
        assert [h["score"] for h in got["hits"]] == [h["score"] for h in old["hits"]]
        assert_preserved(got["hits"], old["hits"])
    broken = FakeEI()
    c = sqlite3.connect(broken.db); c.execute("DROP TABLE cards"); c.commit(); c.close()
    got = rpc(broken, rerank=True)
    assert got["rerank"]["reason"] == "cards_unreadable"
    assert all(h["provenance"]["card_status"] == "cards_unreadable" for h in got["hits"])
assert svc.requests == []
`);
});

test("semantic-only query opt-in keeps its existing scope/truncation and related metadata", () => {
  run(String.raw`
paths = ["/scope/a", "/scope/b", "/elsewhere/c", "/scope/tail"]
sem = [{"path": p, "title": "semantic " + p, "score": 0.1235, "s_vec": 0.1234567,
        "related": bool(i % 2), "repo": "/unchanged-root"} for i, p in enumerate(paths)]
calls = fixed_legs([], sem)
ei = FakeEI([card(p) for p in paths])
plain = rpc(ei, op="query", n=2, scope="/scope", related=True)
assert [h["path"] for h in plain["hits"]] == paths[:2]
assert all("s_vec" not in h for h in plain["hits"])
with PrivateScorer(lambda r: envelope(r, scores=[0.1, 0.9])) as svc:
    got = rpc(ei, op="query", rerank=True, n=2, scope="/scope", related=True)
assert [h["path"] for h in got["hits"]] == list(reversed(paths[:2]))
assert "sem_coverage" not in got  # semantic-only API retains its old envelope
assert len(svc.requests[0]["args"]["candidates"]) == 2
for h in got["hits"]:
    old = next(item for item in plain["hits"] if item["path"] == h["path"])
    assert all(h[k] == v for k, v in old.items() if k != "score")
    assert h["retrieval_score"] == old["score"]
    assert h["signals"]["s_vec"] == 0.1234567
assert calls == [("semantic", 2, True), ("semantic", 2, True)]
`);
});

test("only actual boolean per-request opt-in; defaults keep exact legacy search/query shapes", () => {
  run(String.raw`
ei = FakeEI([card("/scope/graft/a")])
calls = fixed_legs([lex("/scope/graft/a", 1.0)], [{"path": "/scope/a", "title": "a", "score": 0.1235, "s_vec": 0.1234567}])
old = rpc(ei)
assert old == rpc(ei, rerank=False)
assert old["sem_coverage"] == "ok" and set(old) == {"ok", "hits", "sem_coverage"}
assert all("signals" not in h and "provenance" not in h for h in old["hits"])
semantic = rpc(ei, op="query", n=1, rerank=False)
assert semantic == {"ok": True, "hits": [{"path": "/scope/a", "title": "a", "score": 0.1235}]}
count = len(calls)
for value in (None, 0, 1, "true", "false", [], {}):
    got = rpc(ei, rerank=value)
    assert got == {"ok": False, "error": "'rerank' must be a boolean"}
assert len(calls) == count and ei.conn_calls == 0
`);
});

test("absent socket ignores query paths; explicit unreachable/invalid socket never probes another daemon", () => {
  run(String.raw`
path = "/scope/graft/a"
ei = FakeEI([card(path)])
fixed_legs([lex(path, 1.0)])
old = rpc(ei)
# These query fields are untrusted data, not socket configuration.
got = rpc(ei, rerank=True, socket_path="/tmp/query-supplied.sock", GRAFT_SOCKET="/tmp/another.sock", HEIMDALL_RERANK_SOCKET="/tmp/also.sock")
assert got["rerank"]["status"] == "unavailable"
assert got["rerank"]["reason"] == "unconfigured_socket"
assert ei.conn_calls == 0
assert_preserved(got["hits"], old["hits"])
with PrivateScorer() as fallback:
    os.environ["GRAFT_SOCKET"] = fallback.path
    os.environ["HEIMDALL_RERANK_SOCKET"] = str(ROOT / "absent.sock")
    got = rpc(ei, rerank=True)
    assert got["rerank"]["reason"] == "transport"
    assert got["rerank"]["status"] == "unavailable"
    os.environ["HEIMDALL_RERANK_SOCKET"] = "relative.sock"
    got = rpc(ei, rerank=True)
    assert got["rerank"]["reason"] == "unconfigured_socket"
    assert fallback.requests == []
    os.environ.pop("HEIMDALL_RERANK_SOCKET")
    assert rpc(ei, rerank=True)["rerank"]["status"] == "applied"
    assert len(fallback.requests) == 1
assert rpc(ei, rerank=False) == old
`);
});

test("native disabled/unavailable/failed/deadline retain cheap signals and exact original order", () => {
  run(String.raw`
paths = ["/scope/graft/a", "/scope/graft/b", "/scope/c"]
fixed_legs([lex(paths[0], 10.0), lex(paths[1], 9.0)], [
    {"path": paths[0], "title": "sem", "score": 0, "s_vec": 0.0},
    {"path": paths[2], "title": "sem2", "score": -0.3333, "s_vec": -0.3333333333},
])
ei = FakeEI([card(p, title="title") for p in paths])
old = rpc(ei)
for status, reason in (("disabled", "rerank_disabled"), ("unavailable", "cpu_required"),
                       ("failed", "ce_failed"), ("deadline", "budget_exhausted")):
    with PrivateScorer(lambda r: envelope(r, status=status, reason=reason)):
        got = rpc(ei, rerank=True)
    assert got["sem_coverage"] == "ok"  # ranking availability is NOT coverage
    assert got["rerank"]["status"] == status
    assert got["rerank"]["reason"] == reason
    assert got["rerank"]["method"] == "original_order"
    assert [h["path"] for h in got["hits"]] == [h["path"] for h in old["hits"]]
    assert [h["score"] for h in got["hits"]] == [h["score"] for h in old["hits"]]
    assert_preserved(got["hits"], old["hits"])
    assert [h["signals"]["s_vec"] for h in got["hits"]] == [0.0, None, -0.3333333333]
    assert got["hits"][0]["signals"]["s_vec_missing_reason"] is None
    assert got["hits"][1]["signals"]["s_vec_missing_reason"] == "not_observed"
    assert all(h["signals"]["s_lex"] == 1.0 for h in got["hits"])
    assert all(h["signals"]["s_lex_source"] == "title_trigram_jaccard" for h in got["hits"])
    assert all(h["ranking_score"] is None for h in got["hits"])
# A partial CE diagnostic is retained but never used to reorder the window.
with PrivateScorer(lambda r: envelope(r, status="deadline", scores=[0.9, 0.1, 0.3], ce_statuses=["ok", "deadline", "not_scored"])):
    got = rpc(ei, rerank=True)
assert got["rerank"]["scored_count"] == 1 and not got["rerank"]["applied"]
assert got["hits"][0]["ranking_score"] == 0.9
assert [h["rank"] for h in got["hits"]] == [1, 2, 3]
`);
});

test("missing or malformed semantic evidence is null with provenance, never a made-up ordinal/offset/zero", () => {
  run(String.raw`
paths = ["/scope/a", "/scope/b", "/scope/c", "/scope/d"]
raw = [None, float("nan"), True, -0.1256789]
semantic = [{"path": p, "title": "t", "score": 0.5, "s_vec": value} for p, value in zip(paths, raw)]
fixed_legs([], semantic)
ei = FakeEI([card(p) for p in paths])
with PrivateScorer() as svc:
    got = rpc(ei, op="query", rerank=True)
assert [h["s_vec"] for h in svc.requests[0]["args"]["candidates"]] == [None, None, None, -0.1256789]
assert [h["signals"]["s_vec"] for h in got["hits"]] == [None, None, None, -0.1256789]
assert [h["signals"]["s_vec_missing_reason"] for h in got["hits"]] == [
    "not_observed", "nonfinite_semantic_signal", "invalid_semantic_signal", None]
assert all("s_vec" not in h for h in got["hits"])
assert got["rerank"]["status"] == "applied"
json.dumps(got, allow_nan=False)
`);
});

test("strict client validation rejects malformed rank/identity/tie replies without reordering or leaking text", () => {
  run(String.raw`
paths = ["/scope/graft/a", "/scope/graft/b"]
fixed_legs([lex(paths[0], 2.0), lex(paths[1], 1.0)])
ei = FakeEI([card(p, body="SENSITIVE document must not appear in errors") for p in paths])
old = rpc(ei)
def bad(kind):
    def response(request):
        reply = envelope(request, scores=[0.5, 0.5])
        rows = reply["result"]["results"]
        if kind == "identity": rows[0]["id"] = "wrong"
        if kind == "rank": rows[1]["rank"] = 1
        if kind == "ties": rows[0]["rank"], rows[1]["rank"] = 2, 1
        if kind == "missing": rows[0]["s_ce"] = None
        return reply
    return response
for kind, reason in (("identity", "response_candidate_id"), ("rank", "response_rank_permutation"),
                     ("ties", "response_score_order"), ("missing", "response_ce_missingness")):
    with PrivateScorer(bad(kind)):
        got = rpc(ei, q="SENSITIVE query", rerank=True)
    assert got["rerank"]["status"] == "failed"
    assert got["rerank"]["reason"] == reason, got
    assert [h["path"] for h in got["hits"]] == paths
    assert [h["score"] for h in got["hits"]] == [2.0, 1.0]
    assert_preserved(got["hits"], old["hits"])
    assert "SENSITIVE" not in json.dumps(got)
# Ties accepted only in original-rank order; order keys preserve that order.
with PrivateScorer(lambda r: envelope(r, scores=[0.5, 0.5])):
    got = rpc(ei, rerank=True)
assert got["rerank"]["status"] == "applied"
assert [h["path"] for h in got["hits"]] == paths
`);
});

test("remaining search deadline bounds scorer timeout at eight seconds; exhaustion is typed original-order", () => {
  run(String.raw`
path = "/scope/graft/a"
ei = FakeEI([card(path)])
clock = {"now": 100.0, "retrieval": 3.5}
qs.time = types.SimpleNamespace(monotonic=lambda: clock["now"])
wr.time = types.SimpleNamespace(monotonic=lambda: clock["now"])
qs._with_deadline = lambda fn, seconds: fn()  # deterministic clock fixture only
qs.lexical_hits = lambda ei, q, n, scope=None: [lex(path, 7.0)]
def sem(ei, q, n=6, related=False):
    clock["now"] += clock["retrieval"]
    return []
qs._semantic_hits = sem
calls = []
class ValidatedStub:
    ScorerError = client.ScorerError
    def score_candidates(self, query, candidates, socket_path, timeout_s=8.0, deadline=None):
        calls.append(timeout_s)
        req = {"args": {"query": query, "candidates": candidates}}
        return client._validate_result(envelope(req), candidates)
wr._load_client = lambda: ValidatedStub()
qs._rerank_hits = lambda ei, q, hits, **kw: wr.rerank_hits(ei, q, hits, **kw)
os.environ["HEIMDALL_RERANK_SOCKET"] = str(ROOT / "fixture-stub.sock")
qs.SEARCH_DEADLINE_S = 10.0
assert rpc(ei, rerank=True)["rerank"]["status"] == "applied"
assert calls == [6.5]
qs.SEARCH_DEADLINE_S = 30.0
assert rpc(ei, rerank=True)["rerank"]["status"] == "applied"
assert calls[-1] == 8.0
qs.SEARCH_DEADLINE_S = 10.0
clock["retrieval"] = 10.0
before = len(calls)
got = rpc(ei, rerank=True)
assert len(calls) == before
assert got["rerank"]["status"] == "deadline" and got["rerank"]["reason"] == "search_deadline"
assert got["hits"][0]["score"] == 7.0
assert got["hits"][0]["ranking_score"] is None
`);
});

test("real private-socket I/O timeout degrades without losing frozen hits or claiming backend cancellation", () => {
  run(String.raw`
path = "/scope/graft/a"
ei = FakeEI([card(path)])
fixed_legs([lex(path, 3.0)])
with PrivateScorer(stall=True) as svc:
    # Call adapter directly to make the tiny timeout independent of import and
    # retrieval scheduling. It is an absolute waiting bound, NOT a speed test.
    got = wr.rerank_hits(ei, "title", [lex(path, 3.0)], deadline=time.monotonic() + 0.15)
assert got.rerank["status"] == "deadline" and got.rerank["reason"] == "deadline"
assert got[0]["path"] == path and got[0]["score"] == 3.0
assert got[0]["signals"]["s_ce"] is None
assert len(svc.requests) == 1
assert 1 <= svc.requests[0]["args"]["budget_ms"] <= 150
`);
});

test("request-local ranking and semantic coverage survive concurrent requests; no default metadata leak", () => {
  run(String.raw`
path = "/scope/graft/a"
ei = FakeEI([card(path)])
qs.lexical_hits = lambda ei, q, n, scope=None: [lex(path, 4.0)]
def sem(ei, q, n=6, related=False):
    if q == "one": raise RuntimeError("fixture semantic failure")
    return []
qs._semantic_hits = sem
barrier = threading.Barrier(2)
def concurrent_retrieval(fn, seconds):
    hits = fn()
    barrier.wait(2)  # both callers see a changed legacy global flag
    return hits
qs._with_deadline = concurrent_retrieval
with PrivateScorer(lambda r: envelope(r, status="disabled" if r["args"]["query"] == "one" else "unavailable", reason="fixture_per_request")):
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(rpc, ei, q="one", rerank=True)
        b = pool.submit(rpc, ei, q="two", rerank=True)
        first, second = a.result(), b.result()
assert first["sem_coverage"] == "degraded" and first["rerank"]["status"] == "disabled"
assert second["sem_coverage"] == "ok" and second["rerank"]["status"] == "unavailable"
assert first["hits"][0]["signals"]["ce_status"] == "disabled"
assert second["hits"][0]["signals"]["ce_status"] == "unavailable"
qs._with_deadline = lambda fn, seconds: fn()
plain = rpc(ei, q="two", rerank=False)
assert set(plain) == {"ok", "hits", "sem_coverage"}
assert plain["hits"] == [lex(path, 4.0)]
assert first["rerank"]["status"] == "disabled"
`);
});

test("oversized/NUL indexed documents are rejected explicitly, never silently truncated or sent", () => {
  run(String.raw`
path = "/scope/graft/a"
fixed_legs([lex(path, 1.0)])
with PrivateScorer() as svc:
    for body in ("X" * 131073, "indexed body with a NUL " + chr(0) + " suffix"):
        ei = FakeEI([card(path, body=body)])
        got = rpc(ei, rerank=True)
        assert got["rerank"]["status"] == "failed"
        assert got["rerank"]["reason"] == "invalid_candidate_text"
        assert got["hits"][0]["score"] == 1.0
        assert got["hits"][0]["signals"]["document_bytes"] == len(body.encode())
    assert svc.requests == []
`);
});

test("ranking status and signals reach the actual private warm-worker JSON socket only when requested", () => {
  run(String.raw`
path = "/scope/graft/a"
ei = FakeEI([card(path)])
ei.MODEL = "fixture-no-encoder"
ei.model = lambda: None  # server startup warmth is a fixture, NOT a model load
fixed_legs([lex(path, 9.0)])
qs.load_embed_index = lambda: ei
qs.build_fts = lambda ei: None
qs._load_matrix = lambda ei: None
ready, server_errors = threading.Event(), []
qs.log = lambda message: ready.set() if message.startswith("listening on") else None
worker_socket = ROOT / "query.sock"
def serve():
    try: qs.serve(worker_socket, 0.05)
    except BaseException as e: server_errors.append(repr(e))
def exchange(req):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(2)
        s.connect(str(worker_socket))
        s.sendall(json.dumps(req).encode() + b"\n")
        data = b""
        while b"\n" not in data:
            chunk = s.recv(65536)
            assert chunk
            data += chunk
        return json.loads(data.split(b"\n", 1)[0])
t = threading.Thread(target=serve, daemon=True)
with PrivateScorer(lambda r: envelope(r, status="disabled", reason="rerank_disabled")) as svc:
    t.start()
    assert ready.wait(2), server_errors
    got = exchange({"op": "search", "q": "title", "rerank": True})
    plain = exchange({"op": "search", "q": "title", "rerank": False})
    assert got["rerank"]["status"] == "disabled" and got["sem_coverage"] == "ok"
    assert got["hits"][0]["signals"]["s_ce"] is None
    assert got["hits"][0]["provenance"]["document_source"] == "cards.body"
    assert plain == {"ok": True, "hits": [lex(path, 9.0)], "sem_coverage": "ok"}
    assert len(svc.requests) == 1
    t.join(3)  # private fixture server exits on idle timeout; no live worker used
assert not t.is_alive() and not server_errors
`);
});

test("empty result request has explicit empty ranking status without card reads or scorer connection", () => {
  run(String.raw`
ei = FakeEI()
fixed_legs([])
def forbidden_adapter(*a, **k): raise AssertionError("empty hits must not load an adapter")
qs._rerank_hits = forbidden_adapter
got = rpc(ei, rerank=True)
assert got["hits"] == [] and got["sem_coverage"] == "ok"
assert got["rerank"] == {
    "version": 1, "requested": True, "status": "empty", "reason": "no_candidates",
    "applied": False, "method": "original_order", "candidate_count": 0,
    "scored_count": 0, "total_count": 0, "tail_count": 0}
assert ei.conn_calls == 0
`);
});

test("NumPy-result and embed-index dictionary producers retain unrounded/raw cosine without changing legacy score", () => {
  run(String.raw`
# Prescribed kNN rows, not NumPy math or real encoder inference.
raw = 0.123456789123
qs._numpy_knn = lambda ei, q, k: [(1, raw)]
ei = FakeEI([card("/scope/a", title="t")])
# Add rowid-compatible root data only; _semantic_hits reads the same temp cards.
fast = qs._semantic_hits(ei, "q", n=1)
assert fast[0]["s_vec"] == raw and fast[0]["score"] == round(raw, 4)
assert qs.handle_request(ei, {"op": "query", "q": "q", "n": 1})[0] == {
    "ok": True, "hits": [{"title": "t", "path": "/scope/a", "repo": "/fixed-root", "score": round(raw, 4)}]}

# embed-index imports are fixtures. Neither sqlite-vec nor an encoder/model is
# imported/loaded: its query SQL is fed a prescribed distance by a fake EI conn.
sqlite_vec = types.ModuleType("sqlite_vec"); sqlite_vec.load = lambda c: None
st = types.ModuleType("sentence_transformers")
def forbidden_model(*a, **kw): raise AssertionError("model construction forbidden")
st.SentenceTransformer = forbidden_model
walker = types.ModuleType("embed_walker"); walker.discover_files = lambda *a, **kw: (_ for _ in ()).throw(AssertionError("discovery forbidden"))
sys.modules.update(sqlite_vec=sqlite_vec, sentence_transformers=st, embed_walker=walker)
embed = load("warm_fixture_embed", BIN / "embed-index.py")
class Rows:
    def __init__(self, rows): self.rows = rows
    def fetchall(self): return self.rows
    def fetchone(self): return self.rows[0] if self.rows else None
class Conn:
    def execute(self, sql, args=()):
        if sql.startswith("SELECT rowid, distance"):
            assert args[1] == 1
            return Rows([(1, 1.0 - raw)])
        if sql.startswith("SELECT title, path, root"):
            return Rows([("t", "/scope/a", "/fixed-root")])
        raise AssertionError("unexpected SQL: " + sql)
    def close(self): pass
class Lock:
    def close(self): pass
embed.conn = lambda: Conn()
embed._acquire_read_lock = lambda: Lock()
embed._db_dim = lambda c: embed.DIM
embed._ram_ok = lambda *a: True
embed.encode_query = lambda q: [1.0, 0.0]  # fixed encoder output, no inference
embed._card_count = lambda c: 1
embed.record_semantic_state = lambda state: None
slow = embed.query("q", n=1)
assert slow[0]["s_vec"] == 1.0 - (1.0 - raw)
assert slow[0]["score"] == round(1.0 - (1.0 - raw), 4)
assert slow[0]["s_vec"] != slow[0]["score"]
`);
});

test("an explicitly empty Heimdall socket never substitutes the Graft socket", () => {
  run(String.raw`
path = "/scope/graft/a"
ei = FakeEI([card(path)])
fixed_legs([lex(path, 3.0)])
with PrivateScorer() as svc:
    os.environ["GRAFT_SOCKET"] = svc.path
    os.environ["HEIMDALL_RERANK_SOCKET"] = ""
    got = rpc(ei, rerank=True)
    assert got["rerank"]["status"] == "unavailable"
    assert got["rerank"]["reason"] == "unconfigured_socket"
    assert got["hits"][0]["score"] == 3.0
    assert svc.requests == [] and ei.conn_calls == 0
`);
});

test("a stuck indexed-card read is bounded by the same search deadline", () => {
  run(String.raw`
path = "/scope/graft/a"
ei = FakeEI([card(path)])
fixed_legs([lex(path, 3.0)])
started, release, finished = threading.Event(), threading.Event(), threading.Event()
base_conn = ei.conn
class Connection:
    def __init__(self, inner): self.inner = inner
    def execute(self, sql, args=()): return self.inner.execute(sql, args)
    def close(self):
        self.inner.close()
        finished.set()
def blocked_conn():
    started.set()
    assert release.wait(2), "fixture was not released after deadline"
    return Connection(base_conn())
ei.conn = blocked_conn
with PrivateScorer() as svc:
    qs.SEARCH_DEADLINE_S = 0.06
    try:
        got = rpc(ei, rerank=True)
        assert started.is_set() and not release.is_set()
        assert got["rerank"]["status"] == "deadline"
        assert got["rerank"]["method"] == "original_order"
        assert got["hits"][0]["path"] == path and got["hits"][0]["score"] == 3.0
        assert got["hits"][0]["signals"]["s_ce"] is None
        assert svc.requests == []
    finally:
        release.set()
        assert finished.wait(2), "the abandoned fixture read did not finish cleanup"
    # The resumed adapter observes the expired absolute budget before any I/O.
    assert svc.requests == []
`);
});

test("card cleanup failure or a broken optional client preserves original hits", () => {
  run(String.raw`
path = "/scope/graft/a"
for failure in ("close", "client_import"):
    ei = FakeEI([card(path)])
    fixed_legs([lex(path, 3.0)])
    with PrivateScorer() as svc:
        if failure == "close":
            base = ei.conn
            class BadClose:
                def __init__(self, inner): self.inner = inner
                def execute(self, sql, args=()): return self.inner.execute(sql, args)
                def close(self):
                    self.inner.close()
                    raise OSError("PRIVATE_ERROR_MUST_NOT_PRINT")
            ei.conn = lambda: BadClose(base())
        else:
            old = wr._load_client
            def broken_client(): raise SyntaxError("PRIVATE_ERROR_MUST_NOT_PRINT")
            wr._load_client = broken_client
        try:
            got = wr.rerank_hits(ei, "title", [lex(path, 3.0)])
        finally:
            if failure == "client_import": wr._load_client = old
        assert got.rerank["status"] == "unavailable"
        assert got[0]["path"] == path and got[0]["score"] == 3.0
        assert got[0]["signals"]["s_ce"] is None
        assert "PRIVATE_ERROR" not in json.dumps(got.rerank)
        assert svc.requests == []
`);
});

test("adapter loading is inside the deadline and broken imports do not trigger retrieval fallback", () => {
  run(String.raw`
path = "/scope/graft/a"
ei = FakeEI([card(path)])
calls = fixed_legs([lex(path, 3.0)])
for failure in (FileNotFoundError, SyntaxError):
    def broken(*a, **k): raise failure("PRIVATE_ADAPTER_TEXT")
    qs._rerank_hits = broken
    got = rpc(ei, rerank=True)
    assert got["ok"] and got["rerank"]["status"] == "unavailable"
    assert got["rerank"]["reason"] == "scorer_adapter_unavailable"
    assert got["hits"][0]["path"] == path and got["hits"][0]["score"] == 3.0
    assert "PRIVATE_ADAPTER_TEXT" not in json.dumps(got)
    assert ei.conn_calls == 0
assert len(calls) == 4, "a failed optional component repeated retrieval"
entered, release, done = threading.Event(), threading.Event(), threading.Event()
def blocked_import(*a, **k):
    entered.set()
    assert release.wait(2)
    done.set()
    raise ImportError("fixture released")
qs._rerank_hits = blocked_import
qs.SEARCH_DEADLINE_S = 0.06
try:
    got = rpc(ei, rerank=True)
    assert entered.is_set() and not release.is_set()
    assert got["ok"] and got["rerank"]["status"] == "deadline"
    assert got["hits"][0]["path"] == path and got["hits"][0]["score"] == 3.0
    assert got["hits"][0]["signals"]["s_ce"] is None
    assert ei.conn_calls == 0
finally:
    release.set()
    assert done.wait(2)
`);
});
