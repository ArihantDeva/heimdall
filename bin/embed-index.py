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
MODEL = os.environ.get("HEIMDALL_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
DIM = 384 if "bge-small" in MODEL else 1024
# MPS measured 3.4x CPU under load (32.7 vs 9.7 f/s) and doesn't contend for
# CPU cores with other agent sessions. HEIMDALL_DEVICE=cpu to opt out.
DEVICE = os.environ.get("HEIMDALL_DEVICE", "mps")
MIN_FREE_GB = float(os.environ.get("HEIMDALL_MIN_FREE_GB", "2"))
BUILD_HEADROOM_GB = 4.0
BATCH = 128
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
    fh = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
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


def _upsert(c: sqlite3.Connection, m, batch: list[tuple]) -> int:
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


def _build_inner(c: sqlite3.Connection, progress_every: int) -> int:
    init(c)
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
            continue  # near-empty: not worth a vector
        sha = hashlib.sha1(body.encode()).hexdigest()
        if sha in claimed and (not prev or prev != sha):
            continue  # identical content already indexed elsewhere
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


def query(q: str, n: int = 5, related: bool = False) -> list[dict]:
    global MODEL, DIM
    c = conn()
    db_d = _db_dim(c)
    if db_d < 0:
        return []
    if DIM != db_d:  # adapt to index; build is the only path that changes dims
        MODEL = "BAAI/bge-small-en-v1.5" if db_d == 384 else "BAAI/bge-m3"
        DIM = db_d
    try:
        lock_fh = _acquire_lock()  # MUST bind: unbound refcount-frees → fd closed → flock released instantly
    except Busy:
        print("embed-index: busy; semantic skipped this call.", file=sys.stderr)
        record_semantic_state("busy")
        sys.exit(3)  # loud: caller banners lexical-only degradation
    try:
        if not _ram_ok(MIN_FREE_GB, "query"):
            record_semantic_state("busy")  # RAM-gated: same observable effect
            sys.exit(3)  # loud: rc!=0 makes kb-search.sh banner the degradation
        vec = _flat_vec(model().encode(q, normalize_embeddings=True))
        rows = c.execute("SELECT rowid, distance FROM vec WHERE embedding MATCH ? AND k = ?",
                         (json.dumps(vec), n)).fetchall()
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
    c = conn()
    init(c)
    files = c.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    repos = sorted({r[0] for r in c.execute("SELECT DISTINCT root FROM cards")})
    d = _db_dim(c)
    c.close()
    return {"files": files, "repos": repos, "dim": d, "dimension_ok": d == DIM}


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


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "status"
    if cmd == "build":
        build()
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
