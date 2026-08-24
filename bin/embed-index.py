#!/usr/bin/env python3
"""embed-index.py — global semantic graph over per-repo graft cards.

One sqlite-vec store (~/.heimdall/global.db) embedding every graft card
(INDEX.md + per-file .md) across ~/Repos. Query = cosine ANN against the same
bge-m3 embeddings. This restores the original C daemon's semantic recall
(cross-repo, meaning-based) on top of the per-repo lexical graphs.

CPU-only: bge-m3 via sentence-transformers. No LLM calls.
Usage:
  embed-index.py build   # (re)embed all repo cards into the global store
  embed-index.py query "text" -n 5   # semantic search
  embed-index.py status  # node count, freshness
"""
from __future__ import annotations

import json
import os
import pathlib
import sqlite3
import sys

import sqlite_vec
from sentence_transformers import SentenceTransformer

DB = pathlib.Path.home() / ".heimdall" / "global.db"
REPOS = pathlib.Path.home() / "Repos"
MODEL = "BAAI/bge-m3"
DIM = 1024

MODEL_CACHE: SentenceTransformer | None = None


def model() -> SentenceTransformer:
    global MODEL_CACHE
    if MODEL_CACHE is None:
        MODEL_CACHE = SentenceTransformer(MODEL, device="cpu")
    return MODEL_CACHE


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB)
    c.enable_load_extension(True)
    sqlite_vec.load(c)
    return c


def init(c: sqlite3.Connection) -> None:
    c.execute("CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, repo TEXT, path TEXT, title TEXT, body TEXT)")
    c.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(embedding float[{DIM}])")


def cards_for(repo: pathlib.Path) -> list[tuple[str, str, str, str]]:
    """(id, relpath, title, body) for every graft card + the source it
    summarizes. Card bodies are symbol signatures only — embedding them loses
    semantics — so we embed the real source text (first 3000 chars) for each
    indexed file, which is what carries meaning."""
    out = []
    graft = repo / "graft"
    if not graft.is_dir():
        return out
    for md in graft.rglob("*.md"):
        if md.name == "INDEX.md":
            continue
        rel = md.relative_to(graft).as_posix()
        # card body = signatures; source = real text
        card_text = md.read_text(errors="replace")
        src = repo / rel
        src_text = src.read_text(errors="replace")[:3000] if src.is_file() else card_text
        title = f"{repo.name}/{rel}"
        out.append((f"{repo.name}:{rel}", repo.as_posix(), rel, title, src_text))
    return out


def build() -> int:
    c = conn()
    init(c)
    model_inst = model()
    total = 0
    for repo in sorted(REPOS.glob("*")):
        if not repo.is_dir():
            continue
        for cid, repo_path, rel, title, body in cards_for(repo):
            vec = model_inst.encode(title + " " + body[:1500], normalize_embeddings=True).tolist()
            c.execute("INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?)", (cid, repo_path, rel, title, body))
            row = c.execute("SELECT rowid FROM cards WHERE id=?", (cid,)).fetchone()
            c.execute("DELETE FROM vec WHERE rowid=?", (row[0],))
            c.execute("INSERT INTO vec (rowid, embedding) VALUES (?, ?)", (row[0], json.dumps(vec)))
            total += 1
    c.commit()
    c.close()
    return total


def query(q: str, n: int = 5, related: bool = False) -> list[dict]:
    c = conn()
    vec = model().encode(q, normalize_embeddings=True).tolist()
    rows = c.execute(
        "SELECT rowid, distance FROM vec WHERE embedding MATCH ? AND k = ?",
        (json.dumps(vec), n),
    ).fetchall()
    out = []
    for rowid, dist in rows:
        card = c.execute("SELECT id, repo, path, title FROM cards WHERE rowid=?", (rowid,)).fetchone()
        if card:
            # card path is graft/<file>.md → map back to the real source file
            src = pathlib.Path(card[2])
            if src.suffix == ".md":
                base = src.with_suffix("")
                # find the real file: probe common extensions
                repo_dir = pathlib.Path(card[1])
                found = None
                for ext in ("", ".js", ".mjs", ".ts", ".py", ".sh", ".c", ".cpp", ".md"):
                    cand = repo_dir / (str(base) + ext)
                    if cand.is_file():
                        found = cand
                        break
                if found:
                    src = pathlib.Path(os.path.relpath(found, repo_dir))
            out.append({"id": card[0], "repo": card[1], "path": str(src), "title": card[3], "score": 1.0 - dist})
    # Structural second pass (issue #1): siblings of top hits in the same
    # repo directory — same module, same feature area — regardless of score.
    # Score-cutoff false-negatives get rescued by file structure.
    if related and out:
        seen = {o["path"] for o in out}
        top = out[0]
        parent = pathlib.Path(top["repo"]) / pathlib.Path(top["path"]).parent
        if parent.is_dir():
            for sibling in sorted(parent.iterdir()):
                if sibling.is_file() and sibling.suffix in (".py", ".js", ".mjs", ".ts", ".sh", ".c", ".cpp"):
                    rel = sibling.relative_to(top["repo"]).as_posix()
                    if rel not in seen:
                        out.append({"id": f"sib-{rel}", "repo": top["repo"], "path": rel,
                                    "title": sibling.name, "score": 0.0, "related": True})
    c.close()
    return out


def status() -> dict:
    c = conn()
    n = c.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    repos = c.execute("SELECT COUNT(DISTINCT repo) FROM cards").fetchone()[0]
    c.close()
    return {"cards": n, "repos": repos}


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "build":
        n = build()
        print(f"embedded {n} cards")
    elif cmd == "query":
        q = sys.argv[2]
        n = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[3] == "-n" else 5
        related = "--related" in sys.argv
        for r in query(q, n, related):
            tag = " ·related" if r.get("related") else ""
            print(f"  [{r['score']:.2f}] {r['title']}{tag} — {os.path.join(r['repo'], r['path'])}")
    elif cmd == "status":
        print(json.dumps(status()))
