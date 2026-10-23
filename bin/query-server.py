#!/usr/bin/env python3
"""query-server.py — long-lived warm worker for the semantic (bge) query leg.

WHY THIS EXISTS (measured 2026-10-22)
-------------------------------------
Every `kb-search.sh` invocation spawned a COLD `~/.heimdall/venv/bin/python3
bin/embed-index.py query ...`. Profiled with import-time instrumentation
(see tests/query-server.test.mjs for the contract that pins the fix):

    torch + sentence_transformers import   9.69s   ← 70% of the call
    model load                             0.65s
    encode query                           0.16s
    kNN over global.db    3.49s cold → 0.17s warm   ← page cache
    --------------------------------------------------
    accounted ~14s, measured p50 kb_search 21.8s (n=109, worst 133s)

Both the import and the cold page cache are PER-PROCESS costs. A worker that
stays alive pays them once and then serves at ~0.2s.

Nothing here reimplements retrieval. `query()` is imported from embed-index.py,
which keeps the shared read lock, the RAM gate, the dimension adaption and the
related-sibling logic exactly as they are. This file is transport plus warmth.

PROTOCOL — newline-delimited JSON over a Unix socket, one reply per request.

    → {"op":"ping"}                          ← {"ok":true,"model":"...","pid":N}
    → {"op":"query","q":"...","n":6}         ← {"ok":true,"hits":[{title,path,score,...}]}
    → {"op":"query","q":"...","n":6,"related":true}
    → {"op":"stop"}                          ← {"ok":true} then exit
    ← {"ok":false,"error":"..."}             for anything malformed or unknown

Design constraints, all deliberate:
  * ONE worker per socket. A second launch that finds a live socket exits 4
    instead of hijacking it — two workers would each hold a full model and
    race the same DB.
  * A failed request never kills the process. A stale worker that answered one
    bad frame by exiting would send every later call back to a 14s cold start.
  * Model load failure exits non-zero BEFORE opening the socket, so the shell
    ceiling falls back to the direct `embed-index.py query` path rather than
    serving errors forever.
  * Idle timeout (default 3600s) so a model does not sit in RAM indefinitely on
    a 16GB machine while no agent is searching.
"""
from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
import pathlib
import socket
import stat
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
EMBED_INDEX = HERE / "embed-index.py"
DEFAULT_SOCKET = pathlib.Path.home() / ".heimdall" / "query.sock"


def log(msg: str) -> None:
    """Diagnostics go to stderr — the socket is the only protocol channel."""
    print(f"query-server: {msg}", file=sys.stderr, flush=True)


# ── Fused lexical leg ────────────────────────────────────────────────────────
#
# The old lexical leg spawned `graft ask` once per repo: 99 repos, 122s of
# serial work, 6-8s wall even at 48 threads, because every `graft ask` boots a
# fresh `node` process (`node -e 0` = 103ms, `graft --version` = 367ms).
#
# That was redundant. `graft ask` answers from a repo's `graft/*.md` graph —
# 17,428 markdown files, 16.9MB in total — and all of it is ALREADY in
# global.db as cards (115,049 rows). An FTS5 index over those rows answers the
# same lexical query in ~1ms (measured), which is ~8000x faster than the
# fan-out for the same corpus.
#
# Relevance filtering: only files that live under a graft/ directory are graph
# nodes, so the lexical leg is restricted to those roots. Without that
# restriction the FTS hit list fills with dotfiles and browser blobs that share
# nothing with the query (the same 115k cards include /Users/x/.CFUserTextEncoding).
FTS_TABLE = "cards_fts"


def _fts_available(c) -> bool:
    try:
        c.execute(f"SELECT 1 FROM {FTS_TABLE} LIMIT 1")
        return True
    except Exception:
        return False


def build_fts(ei) -> None:
    """Create/refresh the FTS5 index over graft-graph cards. Idempotent.

    Cheap enough to do at worker start: 2.58s for 115k rows, once per worker
    lifetime, off the request path.
    """
    c = ei.conn()
    try:
        if _fts_available(c):
            return
        c.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS {FTS_TABLE} USING fts5(title, path, body, tokenize='porter unicode61')")
        c.execute(
            f"INSERT INTO {FTS_TABLE}(rowid, title, path, body) "
            "SELECT rowid, title, path, substr(body, 1, 2000) FROM cards WHERE path LIKE '%/graft/%'"
        )
        c.commit()
        n = c.execute(f"SELECT count(*) FROM {FTS_TABLE}").fetchone()[0]
        log(f"fts index built over {n} graft-graph cards")
    except Exception as e:
        log(f"fts build failed ({type(e).__name__}: {e}); lexical leg will use cards LIKE")
    finally:
        c.close()


# ── Hard deadline ────────────────────────────────────────────────────────────
#
# Every request must FAIL FAST rather than hang. The earlier design had no
# ceiling at all: a wedged socket or a stuck DB read left the caller blocked
# until whatever upstream timeout fired, and during this work a probe against a
# dead socket hung the agent outright.
#
# 10s is the ceiling because a HEALTHY search is now ~150ms. Ten seconds is ~65x
# the expected cost, so crossing it means something is genuinely broken (DB lock,
# mmap thrash, model gone bad) — that wants reporting immediately, not blocking.
# On breach the request returns ok:false with a named reason, which the shell
# prints loudly and falls back on. The worker itself keeps serving: a timeout on
# one query says nothing about the next.
SEARCH_DEADLINE_S = float(os.environ.get("HEIMDALL_SEARCH_DEADLINE", "10"))


class DeadlineExceeded(Exception):
    pass


def _with_deadline(fn, seconds: float):
    """Run fn() but raise DeadlineExceeded if it exceeds `seconds`.

    A thread rather than a signal: this server handles concurrent clients on
    threads already, signal handlers only work on the main thread, and a stuck
    C-level sqlite read is not interrupted by a Python signal anyway. The worker
    thread is daemonic, so a genuinely wedged call cannot block process exit.
    """
    if seconds <= 0:
        return fn()
    box: dict = {}

    def run():
        try:
            box["value"] = fn()
        except BaseException as e:  # surface even the odd exception to the caller
            box["error"] = e
        finally:
            # ALWAYS mark completion. Measured 2026-10-23: if fn() raised
            # something that escaped the except above (it used to: SystemExit
            # from embed-index.query(), before that was fixed to raise Busy),
            # NEITHER key was set, the thread simply ended, and the caller then
            # evaluated box["value"] -> KeyError: 'value'. The client got
            # {"error": "KeyError: 'value'"} -- a message about a dict lookup,
            # naming nothing about the real cause. A missing result must be
            # reported as a missing result.
            box.setdefault("finished", True)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        raise DeadlineExceeded(
            f"search exceeded the {seconds:.0f}s deadline; failing fast instead of hanging "
            f"(set HEIMDALL_SEARCH_DEADLINE to raise it)"
        )
    if "error" in box:
        raise box["error"]
    if "value" not in box:
        # The worker thread ended without producing a value and without an
        # exception we caught. Never KeyError here: say what actually happened.
        raise RuntimeError(
            f"{fn} produced no result and raised nothing catchable "
            f"(worker thread ended silently)"
        )
    return box["value"]


# ── Vector search: numpy instead of sqlite-vec's row walk ─────────────────────
#
# MEASURED 2026-10-22 on the live index (115,050 rows x 768d = 353MB):
#   sqlite-vec  "... MATCH ? AND k = ?"   min 121ms
#   numpy       float32 matrix @ query     min  11.5ms
# Both do the same 88M multiply-adds; sqlite-vec walks row blobs one at a time
# while BLAS streams the same bytes through the vector units. float16 is WORSE
# (158ms) because there is no fast half-precision path on this stack, so the
# matrix stays float32.
#
# The matrix is a SNAPSHOT loaded in the background at worker start, so the
# socket is usable immediately (sqlite-vec serves until the matrix is ready).
# Correctness is preserved by re-checking the two things a rebuild can change —
# the card count and the DB's mtime — before trusting the snapshot.
_VEC: dict = {"ids": None, "mat": None, "stamp": None, "loading": False, "lock": threading.Lock()}


def _db_stamp(ei):
    """Identity of the index generation: (card count, db mtime_ns)."""
    c = ei.conn()
    try:
        return (ei._card_count(c), os.stat(ei.DB).st_mtime_ns)
    finally:
        c.close()


def _load_matrix(ei) -> None:
    """(Re)build the numpy snapshot. Runs on a background thread."""
    _VEC["loading"] = True
    try:
        import numpy as np
        stamp = _db_stamp(ei)
        c = ei.conn()
        try:
            rows = c.execute("SELECT rowid, embedding FROM vec").fetchall()
        finally:
            c.close()
        if not rows:
            log("vector snapshot skipped: index is empty")
            return
        dim = len(rows[0][1]) // 4
        ids = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
        mat = np.frombuffer(b"".join(bytes(r[1]) for r in rows), dtype=np.float32).reshape(len(rows), dim)
        with _VEC["lock"]:
            _VEC.update(ids=ids, mat=mat, stamp=stamp)
        log(f"vector snapshot ready: {len(ids)} x {dim} ({mat.nbytes / 1e6:.0f}MB)")
    except Exception as e:
        log(f"vector snapshot failed ({type(e).__name__}: {e}); falling back to sqlite-vec kNN")
    finally:
        _VEC["loading"] = False


def _ensure_matrix(ei) -> bool:
    """True when a CURRENT snapshot is usable. Triggers a reload when stale."""
    if _VEC["mat"] is None:
        if not _VEC["loading"]:
            threading.Thread(target=_load_matrix, args=(ei,), daemon=True).start()
        return False
    try:
        if _db_stamp(ei) != _VEC["stamp"]:
            # A build replaced rows underneath the snapshot; rowids no longer
            # address the same cards, so the old matrix would return wrong paths.
            if not _VEC["loading"]:
                threading.Thread(target=_load_matrix, args=(ei,), daemon=True).start()
            return False
    except Exception:
        return False
    return True


def _numpy_knn(ei, q, k: int):
    """Top-k rowids by cosine similarity, or None when the snapshot is not usable."""
    if not _ensure_matrix(ei):
        return None
    import numpy as np
    vec = np.asarray(ei.encode_query(q), dtype=np.float32).ravel()
    n = float(np.linalg.norm(vec))
    if n:
        vec = vec / n
    with _VEC["lock"]:
        sims = _VEC["mat"] @ vec          # BLAS: 11.5ms for 115k x 768
        ids = _VEC["ids"]
        idx = np.argpartition(-sims, min(k, len(sims) - 1))[:k]
        order = idx[np.argsort(-sims[idx])]
        return [(int(ids[i]), float(sims[i])) for i in order]


def _semantic_hits(ei, q: str, n: int = 6, related: bool = False) -> list:
    """Semantic hits: numpy snapshot when ready, else embed-index.query().

    The fallback is not a degraded mode — it returns the same rows, just slower —
    so callers never distinguish. `related` (structural siblings) only exists in
    embed-index.query(), so a related request takes the sqlite-vec path; the
    snapshot covers the k-NN part that actually costs time.
    """
    if not related:
        top = _numpy_knn(ei, q, max(n * 2, 12))
        if top is not None:
            c = ei.conn()
            try:
                out = []
                for rowid, sim in top:
                    card = c.execute("SELECT title, path, root FROM cards WHERE rowid=?", (rowid,)).fetchone()
                    if card:
                        out.append({"title": card[0], "path": card[1], "repo": card[2], "score": round(sim, 4)})
                return out[:n]
            finally:
                c.close()
    return ei.query(q, n=n, related=related)


# FTS5 treats bare quotes/operators as syntax. A user query is plain text, so
# neutralize the grammar instead of surfacing "fts5: syntax error near ...".
_FTS_SAFE = __import__("re").compile(r'["*()\-:^]')


def _fts_query(q: str) -> str:
    toks = [t for t in _FTS_SAFE.sub(" ", q).split() if len(t) > 1]
    # OR the terms: a strict AND over a sentence matches nothing, and the old
    # whole-string LIKE had exactly that failure mode.
    return " OR ".join(f'"{t}"' for t in toks) if toks else ""


def lexical_hits(ei, q: str, n: int, scope: str | None = None) -> list:
    """Graft-graph lexical hits from the warm DB. Never raises: an empty list
    with a loud stderr note is the documented degradation."""
    c = ei.conn()
    try:
        match = _fts_query(q)
        if not match:
            return []
        scope_sql, scope_args = ("", ())
        if scope:
            # --scope is a path substring (kb-search.sh's contract), so it stays
            # a filter on cards.path rather than becoming a ranking signal.
            scope_sql = " AND cards.path LIKE ?"
            scope_args = (f"%{scope}%",)
        if _fts_available(c):
            rows = c.execute(
                f"SELECT cards.path, cards.title FROM {FTS_TABLE} "
                f"JOIN cards ON cards.rowid = {FTS_TABLE}.rowid "
                f"WHERE {FTS_TABLE} MATCH ?{scope_sql} ORDER BY rank LIMIT ?",
                (match, *scope_args, n),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT path, title FROM cards WHERE path LIKE '%/graft/%' AND title LIKE ?"
                + scope_sql + " LIMIT ?",
                (f"%{q}%", *scope_args, n),
            ).fetchall()
        out = []
        for i, (path, title) in enumerate(rows):
            out.append({
                "title": title,
                "path": path,
                "score": float(n - i),  # lexical ranks above semantic, as before
                "body": f"lexical hit [{path}]",
                "leg": "lexical",
            })
        return out
    except Exception as e:
        print(f"WARN: lexical leg failed ({type(e).__name__}: {e}); results are SEMANTIC-ONLY", file=sys.stderr)
        return []
    finally:
        c.close()


# "ok" | "degraded" — set by fused_search when the semantic leg is skipped, and
# read by handle_request to put the coverage into the reply.
_SEM_COVERAGE = "ok"


def fused_search(ei, q: str, n: int = 6, related: bool = False, scope: str | None = None) -> list:
    """Lexical + semantic in one warm process, ranked together.

    Score shape matches what kb-search.sh already expects: semantic scores get
    the same +3.0 offset the shell used, so ordering behaviour is unchanged for
    callers while the source of both legs is now a single warm process.
    """
    global _SEM_COVERAGE
    _SEM_COVERAGE = "ok"
    hits = lexical_hits(ei, q, n, scope=scope)
    try:
        sem = _semantic_hits(ei, q, n=n, related=related)
        for h in sem:
            if scope and scope not in (h.get("path") or ""):
                continue
            hits.append({
                "title": h.get("title", ""),
                "path": h.get("path", ""),
                "score": float(h.get("score", 0)) + 3.0,
                "body": f"semantic hit [{h.get('path', '')}]",
                "leg": "semantic",
                "related": bool(h.get("related")),
            })
    except Exception as e:
        # DEGRADED, AND SAY SO IN THE REPLY. The stderr warning below is a
        # human-facing side channel; a programmatic caller that talks to this
        # socket never sees it, so before this the reply was identical to a
        # healthy one that simply had no semantic hits. Measured 2026-10-23:
        # running the suite's 65 files concurrently pushed the semantic leg past
        # its deadline, fused_search returned LEXICAL-ONLY hits with ok:true, and
        # the caller could not tell the difference between "the semantic leg
        # found nothing" and "the semantic leg never ran". That is a partial
        # answer presented as a complete one. `coverage` carries the distinction
        # into the reply.
        _SEM_COVERAGE = "degraded"
        print(f"SEMANTIC_ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        print("WARN: semantic layer failed — results are LEXICAL-ONLY (sem_coverage=degraded)", file=sys.stderr)
    # Dedupe by path, keep the best-scoring leg, then order.
    seen = {}
    for h in sorted(hits, key=lambda x: -x["score"]):
        seen.setdefault(h["path"], h)
    return list(seen.values())[:n]


def load_embed_index():
    """Import embed-index.py by path; the hyphen makes it un-importable by name."""
    spec = importlib.util.spec_from_file_location("embed_index", EMBED_INDEX)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {EMBED_INDEX}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def socket_is_live(path: pathlib.Path) -> bool:
    """True when something is actually answering on `path`.

    A stale socket FILE left by a crashed worker must not block a new worker,
    but a live one must. Probing is the only way to tell them apart.
    """
    if not path.exists():
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2.0)
            s.connect(str(path))
            s.sendall(b'{"op":"ping"}\n')
            data = s.recv(4096)
            return b'"ok"' in data
    except (OSError, ValueError):
        return False


def handle_request(ei, req):
    """Dispatch one request. Returns (reply_dict, should_stop)."""
    if not isinstance(req, dict):
        return {"ok": False, "error": "request must be a JSON object"}, False
    op = req.get("op")
    if op == "ping":
        return {"ok": True, "pid": os.getpid(), "model": getattr(ei, "MODEL", "?")}, False
    if op in ("query", "search"):
        q = req.get("q")
        if not isinstance(q, str) or not q.strip():
            return {"ok": False, "error": "query requires a non-empty 'q' string"}, False
        try:
            n = int(req.get("n", 6))
        except (TypeError, ValueError):
            return {"ok": False, "error": "'n' must be an integer"}, False
        if n <= 0 or n > 100:
            return {"ok": False, "error": "'n' must be between 1 and 100"}, False
        related = bool(req.get("related", False))
        scope = req.get("scope")
        if scope is not None and not isinstance(scope, str):
            return {"ok": False, "error": "'scope' must be a string"}, False
        if op == "query":
            hits = _with_deadline(lambda: _semantic_hits(ei, q, n=n, related=related), SEARCH_DEADLINE_S)
            if scope:
                hits = [h for h in hits if scope in (h.get("path") or "")]
            # `n` is a CAP on the reply, not a hint. Neither producer honours it
            # on every path: embed-index.query() overfetches n*OVERFETCH rows and
            # says "let the caller truncate", and a `related` request appends
            # same-directory siblings on top. Measured 2026-10-23: the first call
            # after a worker start returned 48 hits for n=3, and every later call
            # returned 3 — so the answer shrank as the worker warmed and the same
            # query appeared to change its mind. kb-search.sh passes --related on
            # every semantic call, so this was the normal path, not an edge case.
            return {"ok": True, "hits": hits[:n]}, False
        # op == "search": fused lexical + semantic, in ONE process.
        hits = _with_deadline(lambda: fused_search(ei, q, n=n, related=related, scope=scope), SEARCH_DEADLINE_S)
        # A fused reply is only complete if BOTH legs ran. Callers use this to
        # decide whether to fall back; without it a degraded answer is
        # indistinguishable from a complete one.
        return {"ok": True, "hits": hits, "sem_coverage": _SEM_COVERAGE}, False
    return {"ok": False, "error": f"unknown op: {op!r} (valid: ping, query, search, stop)"}, False


def serve(sock_path: pathlib.Path, idle_timeout: float) -> int:
    # SINGLE-WORKER GUARD, taken BEFORE the model load.
    #
    # The first version probed the socket after warming, which takes ~10s. Three
    # concurrent searches therefore all saw "no socket" and each started a
    # worker; all three then bound the same path (verified: 3 live query-server
    # processes, all holding ~/.heimdall/query.sock).
    #
    # A PID lockfile acquired first makes that race impossible — but the LOCK
    # FILE ITSELF must not become the failure mode. A killed worker leaves the
    # file behind, and `fcntl.flock` on a freshly-opened file always succeeds
    # (the lock died with the process), so a stale file would have been harmless
    # ... except the file is also the thing that says "someone holds this".
    # Measured failure: after a test run killed the worker, every subsequent
    # search fell back to the 14s path and no worker could start again until the
    # file was removed by hand.
    #
    # The rule that makes this safe: trust the lock ONLY if a live process is
    # actually holding it. flock is advisory and process-bound, so `flock -n`
    # via the same call is authoritative — we try to take it, and on failure we
    # additionally check the recorded PID. A dead PID means the file is debris.
    lock_path = sock_path.with_suffix(sock_path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_fh = open(lock_path, "w")
    try:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        # Someone holds the lock. Confirm the holder is actually alive; if not,
        # the file is stale debris from a crash and this process takes over.
        holder = 0
        try:
            holder = int((lock_path.read_text() or "0").strip())
        except (OSError, ValueError):
            holder = 0
        alive = False
        if holder > 0:
            try:
                os.kill(holder, 0)
                alive = True
            except OSError:
                alive = False
        if alive:
            log(f"another worker (pid {holder}) holds {lock_path}; refusing to start")
            lock_fh.close()
            return 4
        log(f"stale lock from dead pid {holder}; taking over")
        try:
            lock_fh.close()
            lock_path.unlink()
        except OSError:
            pass
        lock_fh = open(lock_path, "w")
        try:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            log(f"lock contention after stale-lock recovery ({e}); refusing to start")
            lock_fh.close()
            return 4
    lock_fh.write(str(os.getpid()))
    lock_fh.flush()

    ei = load_embed_index()
    # Warm the model BEFORE accepting clients: a client that connects to a
    # worker which then pays 10s of import has gained nothing.
    t0 = time.time()
    ei.model()
    log(f"model warm in {time.time() - t0:.1f}s")
    # Build the lexical FTS index once, here, off the request path.
    build_fts(ei)
    # Load the vector snapshot in the background: the socket must be usable
    # immediately, and sqlite-vec answers correctly until the matrix is ready.
    threading.Thread(target=_load_matrix, args=(ei,), daemon=True).start()

    sock_path.parent.mkdir(parents=True, exist_ok=True)
    if sock_path.exists():
        if socket_is_live(sock_path):
            log(f"another worker is live on {sock_path}; refusing to start")
            return 4
        # Stale socket from a crash: safe to remove, nothing is answering on it.
        try:
            sock_path.unlink()
        except OSError as e:
            log(f"cannot remove stale socket {sock_path}: {e}")
            return 5

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(sock_path))
    os.chmod(sock_path, stat.S_IRUSR | stat.S_IWUSR)  # 0600: owner only
    srv.listen(16)
    srv.settimeout(1.0)  # so the idle check can run without a request

    log(f"listening on {sock_path} (idle timeout {idle_timeout:.0f}s)")
    last_activity = time.time()
    stop = threading.Event()

    def client_thread(conn: socket.socket) -> None:
        nonlocal last_activity
        try:
            conn.settimeout(300.0)
            buf = b""
            while not stop.is_set():
                try:
                    chunk = conn.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        req = json.loads(line.decode("utf-8", "replace"))
                    except (json.JSONDecodeError, UnicodeDecodeError) as e:
                        reply, do_stop = {"ok": False, "error": f"bad JSON: {e}"}, False
                    else:
                        try:
                            reply, do_stop = handle_request(ei, req)
                        except BaseException as e:
                            # BaseException, not Exception. Measured 2026-10-23:
                            # embed-index.query() did sys.exit(3) on lock
                            # contention. SystemExit derives from BaseException,
                            # so it escaped this handler, the thread died before
                            # sendall(), and the client received NO FRAME AT ALL
                            # -- it sat on its socket until its own timeout
                            # (90-120s) and then reported a timeout, which reads
                            # like a hung daemon rather than "busy, degraded".
                            # A request must always produce exactly one reply.
                            if isinstance(e, SystemExit):
                                log(f"request exited {e.code} (treated as busy)")
                                reply = {"ok": False, "busy": True,
                                         "error": "degraded: semantic leg unavailable (busy)"}
                            else:
                                log(f"request failed: {type(e).__name__}: {e}")
                                reply = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                            do_stop = False
                    last_activity = time.time()
                    conn.sendall((json.dumps(reply) + "\n").encode())
                    if do_stop:
                        stop.set()
                        return
        except OSError as e:
            log(f"client connection error: {e}")
        finally:
            try:
                conn.close()
            except OSError:
                pass

    try:
        while not stop.is_set():
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                if idle_timeout > 0 and time.time() - last_activity > idle_timeout:
                    log("idle timeout reached; exiting")
                    break
                continue
            threading.Thread(target=client_thread, args=(conn,), daemon=True).start()
    finally:
        srv.close()
        try:
            sock_path.unlink()
        except OSError:
            pass
        log("stopped")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="warm semantic query worker")
    ap.add_argument("--socket", default=str(DEFAULT_SOCKET))
    ap.add_argument(
        "--idle-timeout",
        type=float,
        default=float(os.environ.get("HEIMDALL_QUERY_IDLE_TIMEOUT", "3600")),
        help="exit after N seconds with no requests; 0 disables",
    )
    args = ap.parse_args(argv)
    try:
        return serve(pathlib.Path(args.socket).expanduser(), args.idle_timeout)
    except BaseException as e:
        # BaseException, not Exception. Measured 2026-10-23: anything that
        # raised SystemExit (embed-index.py's module-top `sys.exit` on a missing
        # package, or query()'s old sys.exit(3)) skipped this branch entirely,
        # so the one place that explains a startup failure printed nothing and
        # the worker died with a bare string. A fatal path must always be logged.
        if isinstance(e, SystemExit):
            log(f"fatal: SystemExit({e.code!r}) during startup")
            return e.code if isinstance(e.code, int) else 1
        log(f"fatal: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
