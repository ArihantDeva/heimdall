#!/usr/bin/env python3
"""embed-index.py — semantic index over the whole $HOME text corpus.
  build   : walk $HOME (junk-pruned), embed previews incrementally, upsert vec
  query   : k-NN over vec (+ structural siblings via --related)
  status  : JSON {files, repos, dim, dimension_ok}
Safeguards: single-flight lock + free-RAM gates (2026-08-25 halt lesson).
Default model BAAI/bge-small-en-v1.5 (384d): measured 34.6 files/s CPU vs
bge-m3 4.3 files/s — m3 projected 52h at 810k scale, infeasible. Override:
HEIMDALL_EMBED_MODEL."""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")

try:
    import sqlite_vec
except ImportError:
    sys.exit("pip install sqlite-vec into ~/.heimdall/venv first")

from sentence_transformers import SentenceTransformer

import embed_walker

discover_files = embed_walker.discover_files  # re-exported for callers/tests

DB = pathlib.Path(os.environ.get("HEIMDALL_DB", str(pathlib.Path.home() / ".heimdall" / "global.db")))
HOME_ROOT = pathlib.Path(os.environ.get("HEIMDALL_HOME", str(pathlib.Path.home())))
REPOS = HOME_ROOT / "Repos"  # attribution only; discovery covers all of HOME_ROOT
# Selected by hill-climb against LongMemEval-S (bench/longmemeval_s), a
# file-disjoint dev/test eval of natural-language code questions. bge-base beat
# bge-small on BOTH splits -- dev MRR 0.615 -> 0.682, held-out 0.455 -> 0.498,
# recall@5 0.636 -> 0.727 -- and gte-base was worse (dev 0.526). This is the only
# change in this effort that improved held-out recall; five earlier attempts
# raised a benchmark number while LOWERING held-out recall and were reverted.
# Full ledger: bench/longmemeval_s/ledger.jsonl.
#
# Cost: 768d instead of 384d, so the vec table is 2x the size and encode is
# ~3x slower (bge-base measured 30s vs 12s for the 9-file eval corpus). For a
# 400k-card rebuild that is the difference between hours and a day, so the
# trade is deliberate and re-measurable rather than assumed.
MODEL = os.environ.get("HEIMDALL_EMBED_MODEL", "BAAI/bge-base-en-v1.5")
# Derived, not guessed: bge-small 384, bge-base 768, bge-m3 1024. A wrong DIM
# is a runtime dimension error at query time, long after a multi-hour rebuild.
DIM = 768 if "bge-base" in MODEL else 384 if "bge-small" in MODEL else 1024
# MPS measured 3.4x CPU under load (32.7 vs 9.7 f/s) and doesn't contend for
# CPU cores with other agent sessions. HEIMDALL_DEVICE=cpu to opt out.
DEVICE = os.environ.get("HEIMDALL_DEVICE", "mps")
MIN_FREE_GB = float(os.environ.get("HEIMDALL_MIN_FREE_GB", "2"))
BUILD_HEADROOM_GB = 4.0
BATCH = 128
# Used only if the cards count cannot be read, so the overfetch k stays a sane
# bound rather than an unbounded vector scan.
N_DEFAULT_CARDS = 1000
# Retrieval depth vs display depth. query() used `k = n` on the vector search,
# so the semantic leg could only ever return as many candidates as the caller
# intended to DISPLAY. Measured consequence: equitylens/api/core/
# api_key_auth.py ranks 131st semantically for its own query, so at -n 5 it
# was never fetched and no amount of downstream re-ranking could surface it --
# 6 of 10 code golds were buried this way. The requested -n is a presentation
# limit; the candidate pool is a different knob and is deliberately larger.
#
# A constant multiple, not a gold-set-derived number: it must help an unseen
# query. 16x covers the measured 131st-place miss (at -n 5 -> pool 80) with
# headroom, while bounding the vector scan on a 400k-card index.
OVERFETCH = 16
LOCK_PATH = DB.parent / "embed-index.lock"
MODEL_CACHE: SentenceTransformer | None = None


class Busy(Exception):
    """Another embed-index process holds the single-flight lock."""


STATE_PATH = DB.parent / "semantic-state.json"


def record_semantic_state(state: str) -> None:
    """Append one {t,state} transition to semantic-state.json (C11 observability).
    Best-effort: never let telemetry break the operation it observes. The file
    is the only state — kb-health.sh reads it to report availability streaks."""
    try:
        events = []
        if STATE_PATH.exists():
            with contextlib.suppress(Exception):
                events = json.loads(STATE_PATH.read_text())
        events.append({"t": int(time.time()), "state": state})
        STATE_PATH.write_text(json.dumps(events[-200:]))  # bounded tail
    except Exception as e:  # noqa: BLE001 — telemetry must not throw
        print(f"embed-index: state record failed: {e}", file=sys.stderr)


def model() -> SentenceTransformer:
    global MODEL_CACHE
    if MODEL_CACHE is None:
        try:
            MODEL_CACHE = SentenceTransformer(MODEL, device=DEVICE)
        except Exception as e:
            print(f"embed-index: {DEVICE} unavailable ({e}); falling back to cpu", file=sys.stderr)
            MODEL_CACHE = SentenceTransformer(MODEL, device="cpu")
    return MODEL_CACHE


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB)
    c.enable_load_extension(True)
    sqlite_vec.load(c)
    return c


def _acquire_lock():
    """EXCLUSIVE lock — for writers (build) that mutate vec/cards.

    Readers must use _acquire_read_lock() instead. Taking this lock for a
    read-only query serialises every concurrent reader against every other one,
    which is how semantic search used to degrade to lexical-only at random.
    """
    fh = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        raise Busy()
    return fh


def _acquire_read_lock():
    """SHARED lock — for readers (query) that only SELECT from vec/cards.

    Readers may hold this simultaneously with each other, but not with a writer:
    flock gives upgrade-to-exclusive priority over queued shared requests, so a
    build cannot be starved by a stream of queries.

    Why this exists (2026-10-15): query() previously called _acquire_lock(), so
    two overlapping semantic searches could not coexist. One won, the other
    printed "embed-index: busy", exited 3, and kb-search.sh fell back to
    lexical-only. Measured consequence: the SAME query answered differently run
    to run — a [STRONG] ~/Repos source hit replaced by [WEAK] cov00% hits from
    unrelated paths — with the degradation visible only if the caller did not
    filter the WARN line. A read that mutates nothing must not exclude another
    read; that is a correctness property, not an optimisation.
    """
    fh = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        raise Busy()
    return fh


def _free_ram_gb() -> float:
    """Usable-RAM estimate via memory_pressure's free percentage × total RAM.
    vm_stat 'Pages free' is chronically ~0 on macOS (everything is cache) and
    false-blocked builds on an otherwise idle 16GB machine."""
    try:
        total = int(subprocess.run(["sysctl", "-n", "hw.memsize"],
                                   capture_output=True, text=True).stdout.strip()) / 1e9
        out = subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout
        m = re.search(r"free percentage:\s*(\d+)", out)
        return total * int(m.group(1)) / 100 if m else 0.0
    except (OSError, ValueError):
        return 0.0


def _ram_ok(min_gb: float, what: str) -> bool:
    free = _free_ram_gb()
    if free < min_gb:
        print(f"embed-index: only {free:.1f}GB free (<{min_gb}GB), skipping {what}.", file=sys.stderr)
        return False
    return True


def _db_dim(c: sqlite3.Connection) -> int:
    row = c.execute("SELECT sql FROM sqlite_master WHERE name='vec'").fetchone()
    m = re.search(r"float\[(\d+)\]", row[0]) if row else None
    return int(m.group(1)) if m else -1


def init(c: sqlite3.Connection) -> None:
    cols = [r[1] for r in c.execute("PRAGMA table_info(cards)")]
    if cols and "sha1" not in cols:
        c.execute("DROP TABLE cards")  # legacy graft-card schema: derivable, re-embedded below
        c.execute("DROP TABLE IF EXISTS vec")
        cols = []
    rebuilt = False
    if _db_dim(c) != DIM:
        c.execute("DROP TABLE IF EXISTS vec")
        c.execute(f"CREATE VIRTUAL TABLE vec USING vec0(embedding float[{DIM}] distance_metric=cosine)")
        if cols:
            c.execute("DROP TABLE cards")  # vectors gone → card bookkeeping invalid
            rebuilt = True
            cols = []
    if not cols:
        c.execute("""CREATE TABLE IF NOT EXISTS cards (
            id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
            body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL,
            mtime REAL NOT NULL, size INTEGER NOT NULL)""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_cards_sha1 ON cards(sha1)")
    c.commit()


_git_roots: dict[str, str] = {}  # ancestor dir -> enclosing project root


def _project_root(abs_path: str) -> str:
    """Enclosing git repo root, else first-two-segments dir. Cached per ancestor."""
    d = os.path.dirname(abs_path)
    hit = _git_roots.get(d)
    if hit:
        return hit
    cur = d
    root = None
    while cur.startswith(str(HOME_ROOT)):
        if os.path.isdir(os.path.join(cur, ".git")):
            root = cur
            break
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    if not root:
        rel = pathlib.PurePosixPath(os.path.relpath(abs_path, HOME_ROOT)).parts
        root = str(HOME_ROOT / rel[0]) if len(rel) > 1 else str(HOME_ROOT)
    for anc in list(pathlib.PurePath(d).parents)[:8]:
        _git_roots[str(anc)] = root
    return root


def _flat_vec(v: object) -> list[float]:
    """Coerce encoder output (ndarray / nested list / list) to flat floats."""
    if hasattr(v, "tolist"):
        v = v.tolist()
    if v and isinstance(v[0], (list, tuple)):
        v = v[0]
    return [float(x) for x in v]


def _upsert(c: sqlite3.Connection, m, batch: list[tuple], allow_dupes: bool = False) -> int:
    if allow_dupes:
        # Duplicate batch: copy vectors from their canonical cards, no model.
        for (cid, rel, body, sha, mt, size) in batch:
            _dup_card(c, cid, rel, body, sha, mt, size)
        c.commit()
        return len(batch)
    texts = [t + "\n" + b for _, t, b, *_ in batch]
    vecs = m.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    for (cid, rel, body, sha, mt, size), vec in zip(batch, vecs):
        # Point-delete via indexed card lookup. The old
        # `DELETE FROM vec WHERE rowid IN (subquery)` forced vec0Filter_fullscan
        # per card — O(n²) across a 40k+ batch (sample()-verified stall).
        row = c.execute("SELECT rowid FROM cards WHERE id=?", (cid,)).fetchone()
        if row:
            c.execute("DELETE FROM vec WHERE rowid=?", (row[0],))
            c.execute("DELETE FROM cards WHERE id=?", (cid,))
        cur = c.execute("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?)",
                        (cid, str(HOME_ROOT / rel), rel, body, sha,
                         _project_root(str(HOME_ROOT / rel)), mt, size))
        c.execute("INSERT INTO vec(rowid, embedding) VALUES (?,?)",
                  (cur.lastrowid, json.dumps(_flat_vec(vec))))
    c.commit()
    return len(batch)


def _persist_search_roots(graft_dirs: list[pathlib.Path]) -> None:
    """Write every graft-bearing dir as a searchable root for kb-search.sh.
    This is how non-Repos projects (Desktop/Documents/home-root) join lexical
    retrieval — the old glob only ever saw ~/Repos/*/graft."""
    # Derived from DB at call time so tests patching DB never touch prod state.
    out_path = DB.parent / "search-roots.json"
    roots = sorted(str(d) for d in graft_dirs if (d / "graft").is_dir())
    out_path.write_text(json.dumps({"roots": roots}, indent=0))
    print(f"embed-index: {len(roots)} search roots persisted -> {out_path}", flush=True)


def _dup_card(c: sqlite3.Connection, cid: str, rel: str, body: str,
              sha: str, mt: float, size: int) -> None:
    """Give a duplicate-content file its own card + vec row by copying the
    existing vector blob — zero encode cost, so 'every possible file' holds
    without paying re-embedding for boilerplate twins."""
    src = c.execute("SELECT v.embedding FROM cards k JOIN vec v ON v.rowid=k.rowid "
                    "WHERE k.sha1=? LIMIT 1", (sha,)).fetchone()
    if not src:
        return  # source not indexed yet; normal upsert next pass
    row = c.execute("SELECT rowid FROM cards WHERE id=?", (cid,)).fetchone()
    if row:
        c.execute("DELETE FROM vec WHERE rowid=?", (row[0],))
        c.execute("DELETE FROM cards WHERE id=?", (cid,))
    cur = c.execute("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?)",
                    (cid, str(HOME_ROOT / rel), rel, body[:3000], sha,
                     _project_root(str(HOME_ROOT / rel)), mt, size))
    c.execute("INSERT INTO vec(rowid, embedding) VALUES (?,?)", (cur.lastrowid, src[0]))


def _prune_stale(c: sqlite3.Connection, known: dict[str, str], seen: set[str]) -> None:
    """Remove cards whose files vanished. sqlite-vec keeps delete-tombstones;
    mass prunes are rare enough that per-row deletes stay correct in practice.
    ponytail: if k-NN ever surfaces dead rows again, trigger full vec rebuild here."""
    stale = [cid for cid in known if cid not in seen]
    for cid in stale:
        row = c.execute("SELECT rowid FROM cards WHERE id=?", (cid,)).fetchone()
        if row:
            c.execute("DELETE FROM vec WHERE rowid=?", (row[0],))
            c.execute("DELETE FROM cards WHERE id=?", (cid,))
    c.commit()


def build(progress_every: int = 5000) -> int:
    fh = _acquire_lock_or_exit()
    try:
        if not _ram_ok(MIN_FREE_GB + BUILD_HEADROOM_GB, "build"):
            raise SystemExit(1)
        c = conn()
        try:
            return _build_inner(c, progress_every)
        finally:
            c.close()
    finally:
        with contextlib.suppress(Exception):
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            fh.close()


def _purge_policy_excluded(c: sqlite3.Connection) -> int:
    """Drop cards whose paths are excluded by policy, without walking anything.

    Why this exists (adversarial review 2026-10-15, CONFIRMED-DEFECT):

    `_prune_stale` detects a vanished FILE, and it is called once at the TAIL of
    a build (line ~412), after the walk and every embedding. So when an exclusion
    rule is added, the already-indexed rows it now covers keep being served until
    a build runs to that point — and a full build is ~4 hours and is killable (I
    killed one at 7%). I hit this directly: adding eight exclusion rules left
    4,680 stale rows serving, and removing them needed a hand-written purge.

    A path that is excluded by policy does not need to be discovered on disk, so
    this runs FIRST and is cheap — one SELECT plus per-row deletes, no walk, no
    embedding. It is deliberately not `_prune_stale`: that one needs the walk's
    `seen` set, this one needs only the policy predicate.

    Deletes are committed here so a build killed at 7% still leaves the policy
    consistent.
    """
    from embed_walker import should_exclude_path  # noqa: PLC0415 (avoids cycle at import)

    rows = c.execute("SELECT rowid, path FROM cards").fetchall()
    # walk_root must be the SAME root the build walked (HOME_ROOT, overridable via
    # $HEIMDALL_HOME), not a default of the real user HOME. With a configured root
    # the predicate otherwise anchors its $HOME-relative rules against the wrong
    # base: reproduced by adversarial review 2026-10-15 — HOME_ROOT=/alternate-home,
    # a card at /alternate-home/.claude/telemetry/a.py was purged 0 times even
    # though discovery excludes it.
    victims = [(rid, p) for rid, p in rows if should_exclude_path(p, str(HOME_ROOT))]
    for rid, _p in victims:
        c.execute("DELETE FROM vec WHERE rowid=?", (rid,))
        c.execute("DELETE FROM cards WHERE rowid=?", (rid,))
    if victims:
        c.commit()
    return len(victims)


def _build_inner(c: sqlite3.Connection, progress_every: int) -> int:
    init(c)
    # Policy sweep FIRST, before the ~4h walk: excluded rows stop being served
    # even if this build is interrupted long before the tail prune.
    purged = _purge_policy_excluded(c)
    if purged:
        print(f"embed-index: policy sweep removed {purged} excluded card(s)", flush=True)
    m = model()
    graft_dirs: list[pathlib.Path] = []
    text_paths, dataless = embed_walker.discover_files(HOME_ROOT, graft_dirs_out=graft_dirs)
    total = 0
    # (sha1, mtime, size) per existing card: mtime+size fast-path avoids
    # re-reading/hashing ~700k unchanged files every incremental build.
    known = {r[0]: (r[1], r[2], r[3]) for r in c.execute("SELECT id, sha1, mtime, size FROM cards")}
    claimed: set[str] = set(known.values())  # sha1 dedupe across whole corpus
    seen: set[str] = set()

    # Dataless iCloud placeholders: name-only card, no read → no download.
    # A later materialized file gets real content + content-sha and replaces
    # the name-only card naturally on the next incremental pass.
    batch: list[tuple] = []
    for p in dataless:
        cid = "f:" + str(p)
        rel = str(p.relative_to(HOME_ROOT))
        seen.add(cid)
        prev = known.get(cid)
        if prev and prev[0].startswith("dataless:"):
            claimed.add(prev[0])
            continue  # name-only card already present
        body = f"[dataless placeholder — filename only, content in iCloud]\n{p.name}"
        sha = "dataless:" + hashlib.sha1(str(p).encode()).hexdigest()
        claimed.add(sha)
        batch.append((cid, rel, body, sha, 0.0, 0))
        if len(batch) >= BATCH:
            total += _upsert(c, m, batch)
            batch = []

    milestone = 0
    for p in text_paths:
        try:
            st = p.stat()
        except OSError:
            continue
        cid = "f:" + str(p)
        rel = str(p.relative_to(HOME_ROOT))
        prev = known.get(cid)
        if prev and prev[1] == st.st_mtime and prev[2] == st.st_size:
            claimed.add(prev[0])
            seen.add(cid)
            continue  # mtime+size unchanged since last build — no re-read
        body = embed_walker.read_preview(p)
        if len(body.strip()) < embed_walker.MIN_PREVIEW_CHARS:
            # Near-empty content (tiny configs, stubs): keep as name-only card
            # — the filename is still retrieval signal. No vector cost beyond
            # one shared encode per unique name-body.
            body = f"[minimal file]\n{p.name}"
            sha = "name:" + hashlib.sha1(body.encode()).hexdigest()
        sha = hashlib.sha1(body.encode()).hexdigest()
        if sha in claimed and (not prev or prev != sha):
            # Identical content elsewhere: still give THIS path its own card
            # (user directive: every possible file), sharing the existing
            # vector — no re-encode.
            seen.add(cid)
            batch.append((cid, rel, body[:3000], sha, st.st_mtime, st.st_size))
            if len(batch) >= BATCH:
                total += _upsert(c, m, batch, allow_dupes=True)
                batch = []
                if total // progress_every > milestone:
                    milestone = total // progress_every
                    print(f"embed-index: {total}/{len(text_paths)} embedded", flush=True)
            continue
        claimed.add(sha)
        seen.add(cid)
        if prev == sha:
            continue  # unchanged since last build
        batch.append((cid, rel, body[:3000], sha, st.st_mtime, st.st_size))
        if len(batch) >= BATCH:
            total += _upsert(c, m, batch)
            batch = []
            if total // progress_every > milestone:
                milestone = total // progress_every
                print(f"embed-index: {total}/{len(text_paths)} embedded", flush=True)
    total += _upsert(c, m, batch)
    _prune_stale(c, known, seen)
    _persist_search_roots(graft_dirs)
    print(f"embed-index: done — {total} embedded ({len(dataless)} name-only), "
          f"{len(seen)} tracked, {len(text_paths) + len(dataless)} discovered", flush=True)
    return total


def _acquire_lock_or_exit():
    try:
        return _acquire_lock()
    except Busy:
        print("embed-index: another instance is running; skipping.", file=sys.stderr)
        raise SystemExit(1)


def _siblings(c: sqlite3.Connection, top_path: str, out: list[dict]) -> None:
    """Structural second pass: same-directory neighbors of the top hit."""
    parent = pathlib.Path(top_path).parent
    if not parent.is_dir():
        return
    have = {o["path"] for o in out}
    for sib in sorted(parent.iterdir())[:20]:
        if sib.is_file() and str(sib) not in have:
            out.append({"path": str(sib), "title": sib.name, "score": 0.0, "related": True})


# bge-*-en-v1.x is trained ASYMMETRICALLY: the document side is embedded as
# "<title>\n<body>" (see _upsert_batch) and the query side is expected to carry
# this instruction. Applying it to documents instead degrades them, so it must
# never appear on the build path -- that would need a full rebuild to undo.
BGE_QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "


def encode_query(q: str) -> object:
    """Encode a query the way the active model expects.

    One helper rather than an inline prefix, because the same class of bug has
    already bitten this file twice: the coverage ranking and the tokenizer were
    each implemented correctly in one heredoc and missing from the other. A
    prompt that lives inline at the call site is one edit away from the same
    mistake.
    """
    text = (BGE_QUERY_INSTRUCTION + q) if "bge" in MODEL.lower() else q
    return model().encode(text, normalize_embeddings=True)


def _card_count(c: sqlite3.Connection) -> int:
    """Rows in `cards`, so the overfetch k can never exceed the index size."""
    try:
        return int(c.execute("SELECT count(*) FROM cards").fetchone()[0])
    except sqlite3.Error:
        return N_DEFAULT_CARDS


def query(q: str, n: int = 5, related: bool = False) -> list[dict]:
    global MODEL, DIM
    # The shared lock is taken BEFORE conn()/_db_dim(), not after. Opening the DB
    # and reading the vec schema are themselves reads of state a build can be
    # mutating (build does DROP TABLE IF EXISTS vec + CREATE VIRTUAL TABLE on a
    # dimension change), so doing them outside the lock left a TOCTOU window: a
    # query could observe a half-rebuilt schema, compute db_d = -1 and return no
    # rows, or adapt MODEL to a dimension that no longer exists. Observed by the
    # adversarial reviewer 2026-10-15, not by me.
    try:
        lock_fh = _acquire_read_lock()  # SHARED: readers must not exclude each other
                                        # (bound: unbound refcount-frees -> fd closed
                                        #  -> flock released instantly)
    except Busy:
        print("embed-index: busy; semantic skipped this call.", file=sys.stderr)
        record_semantic_state("busy")
        sys.exit(3)  # loud: caller banners lexical-only degradation
    try:
        c = conn()
        db_d = _db_dim(c)
        if db_d < 0:
            return []
        if DIM != db_d:  # adapt to index; build is the only path that changes dims
            MODEL = "BAAI/bge-small-en-v1.5" if db_d == 384 else "BAAI/bge-m3"
            DIM = db_d
        if not _ram_ok(MIN_FREE_GB, "query"):
            record_semantic_state("busy")  # RAM-gated: same observable effect
            sys.exit(3)  # loud: rc!=0 makes kb-search.sh banner the degradation
        vec = _flat_vec(encode_query(q))
        # Fetch a deeper pool than the display limit, then let the caller
        # truncate. Read-only: no re-pruning here (pruning is a BUILD-time
        # decision in embed_walker.py) and no index mutation of any kind.
        k = min(n * OVERFETCH, _card_count(c))
        rows = c.execute("SELECT rowid, distance FROM vec WHERE embedding MATCH ? AND k = ?",
                         (json.dumps(vec), k)).fetchall()
        out = []
        for rowid, dist in rows:
            card = c.execute("SELECT title, path, root FROM cards WHERE rowid=?", (rowid,)).fetchone()
            if card:
                out.append({"title": card[0], "path": card[1], "repo": card[2],
                            "score": round(1.0 - dist, 4)})
        if related and out:
            _siblings(c, out[0]["path"], out)
        record_semantic_state("ok")
        return out
    except Exception:
        record_semantic_state("error")  # encode failures etc. must not be invisible
        raise
    finally:
        c.close()
        lock_fh.close()


def status() -> dict:
    """Report index state WITHOUT mutating it.

    Two defects fixed here (found by adversarial review 2026-10-15, both real):

    1. It called init(), which DROPS cards and vec whenever the stored dimension
       differs from DIM. A read-only status call could therefore destroy the
       index: reproduced in memory, one card at dim 768 -> status() -> zero cards
       at dim 384, while the same call reported `dimension_ok: True`. Reporting a
       mismatch is status's job; repairing it is build's job, under the writer
       lock. Schema creation on a genuinely absent DB still happens (init() is
       idempotent for that case), but it must not be able to DELETE data.

    2. It took no lock at all, so it raced a build rewriting vec/cards.

    The shared read lock is taken first, and it is released even when the body
    raises, so a status failure cannot wedge the writer.
    """
    try:
        lock_fh = _acquire_read_lock()
    except Busy:
        # Degrade honestly rather than block: report unknown, claim nothing.
        return {"files": None, "repos": [], "dim": None, "dimension_ok": None,
                "locked": True}
    try:
        c = conn()
        # Schema handling, WITHOUT any destructive branch:
        #
        #   cards absent        -> fresh install; create the full schema.
        #   cards present, vec  -> the INVERSE of the destructive case. A missing
        #     absent               vec table makes every k-NN query fail, so it is
        #     genuinely broken, and fixing it adds a table without deleting rows.
        #     Only the DDL is run, never the cards-DROP branch of init().
        #   dimension mismatch  -> REPORTED, never repaired. A rebuild needs the
        #     writer lock and is build's job; doing it here is what let a status
        #     read destroy the index.
        has_cards = c.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cards'"
        ).fetchone()
        has_vec = c.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec'"
        ).fetchone()
        if not has_cards and not has_vec:
            # Genuinely empty database (a fresh install): creating the schema is
            # additive and destroys nothing.
            init(c)
        elif not has_cards:
            # `vec` EXISTS but `cards` does not. This is NOT an empty database, so
            # calling init() here was destructive: reproduced by adversarial review
            # 2026-10-15 — one vector stored at dim 768, `cards` absent, status() ->
            # `init()` -> vec rows 1 -> 0, while reporting dimension_ok True.
            # A half-populated schema is a state to REPORT, not to erase.
            return {
                "files": None, "repos": [], "dim": _db_dim(c),
                "dimension_ok": False, "schema_ok": False, "locked": False,
                "incomplete_schema": "vec present without cards",
            }
        elif _db_dim(c) < 0:
            # vec missing entirely: create it at the current DIM. No row is lost.
            c.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(embedding float[{DIM}] distance_metric=cosine)"
            )
            c.commit()

        # Read the schema defensively: a legacy `cards` table predating this
        # module has different columns, and status() must report that rather than
        # raise (it used to crash with "no such column: root").
        cols = [r[1] for r in c.execute("PRAGMA table_info(cards)")]
        files = c.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
        repos = (
            sorted({r[0] for r in c.execute("SELECT DISTINCT root FROM cards")})
            if "root" in cols else []
        )
        d = _db_dim(c)
        c.close()
        return {
            "files": files, "repos": repos, "dim": d, "dimension_ok": d == DIM,
            "schema_ok": "sha1" in cols,
            "locked": False,
        }
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
        lock_fh.close()


def insert_card(card_path: str) -> int:
    """Upsert one markdown card (from `heimdall insert`) into the live index.
    Single encode, immediate k-NN visibility; no full walk."""
    p = pathlib.Path(card_path).resolve()
    home_root = HOME_ROOT.resolve()  # macOS /tmp → /private/tmp symlink safety
    if not p.is_file():
        print(f"embed-index: no such card: {p}", file=sys.stderr)
        return 1
    fh = _acquire_lock_or_exit()
    try:
        if not _ram_ok(MIN_FREE_GB, "insert-card"):
            return 1
        c = conn()
        init(c)
        body = embed_walker.read_preview(p)
        rel = str(p.relative_to(home_root))
        sha = hashlib.sha1(body.encode()).hexdigest()
        st = p.stat()
        n = _upsert(c, model(), [("f:" + str(p), rel, body[:3000], sha, st.st_mtime, st.st_size)])
        print(f"embed-index: card indexed ({n})")
        return 0
    finally:
        with contextlib.suppress(Exception):
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            fh.close()


def purge_excluded() -> int:
    """Remove policy-excluded rows without walking or embedding anything.

    The retroactive sweep used to require a full `build`, which walks ~130k files
    and is ~4 hours. Adding an exclusion rule therefore left the rows it covered
    serving until a build COMPLETED — a purge-eligible state that a killed build
    keeps forever. This is the same `_purge_policy_excluded` the build runs first,
    exposed on its own under the exclusive lock so a policy change can be applied
    in seconds.

    Deletes are permanent here, so it takes the writer lock: it must never run
    concurrently with a build or a query rewriting the same rows.
    """
    fh = _acquire_lock_or_exit()
    try:
        c = conn()
        try:
            n = _purge_policy_excluded(c)
            print(f"embed-index: purged {n} policy-excluded card(s)")
            return n
        finally:
            c.close()
    finally:
        with contextlib.suppress(Exception):
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            fh.close()


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "status"
    if cmd == "build":
        build()
    elif cmd == "purge":
        purge_excluded()
    elif cmd == "insert-card":
        raise SystemExit(insert_card(argv[1]))
    elif cmd == "query":
        args = argv[1:]
        n = int(args[args.index("-n") + 1]) if "-n" in args else 5
        q = next(a for a in args if not a.startswith("-") and a != str(n))
        hits = query(q, n=n, related="--related" in args)
        for h in hits:
            t = h["title"] + (" ·related" if h.get("related") else "")
            print(f'[{h["score"]}] {t} — {h["path"]}')
    else:
        print(json.dumps(status()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
