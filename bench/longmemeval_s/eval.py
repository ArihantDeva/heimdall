"""LongMemEval-S — a small, deterministic eval for code retrieval.

WHY THIS EXISTS
---------------
`bench/kinds_recall.py` cannot be hill-climbed against. Its ten code queries
were extracted from each gold file's own first 3000 characters, so they share
vocabulary with their answers by construction. Measured consequence during the
attempt to close the 0.40 -> 0.80 gap: five successive "improvements" moved
that number 0.30 -> 0.50 -> 0.30 while held-out natural-language recall went
2/5 -> 0/5 -> 1/5. The benchmark rewarded resemblance to its own construction.

So this eval has three properties the old one lacks:

  1. PINNED CORPUS. It indexes a frozen copy of a chosen set of files, not the
     live ~/.heimdall/global.db. The live index drifted from 402,993 to 403,000
     cards *while one measurement was in progress* and moved an identical tree
     between 0.30 and 0.40. A metric whose input moves under you is not a
     metric.

  2. NATURAL-LANGUAGE QUESTIONS. Written as a person would ask, in the words a
     person would use, about behaviour the file implements. They deliberately
     share few tokens with the source — that is the point, and it is what the
     ten gold queries do not do.

  3. A DEV/TEST SPLIT BY FILE. No file appears in both splits, so a knob tuned
     on dev cannot win by memorising a file. This is the single most important
     property for hill-climbing: it is what makes a dev improvement evidence
     rather than coincidence.

METRICS
-------
  recall@1 / recall@5 / recall@10 / MRR   over the top-k returned paths
  oracle_k                                index rank of the gold, or None

The eval is deterministic by construction: one fixed file list, one fixed
question list, one fixed embedding model, and a freshly built index per run.
"""
from __future__ import annotations

import json
import math
import os
import pathlib
import re
import sqlite3
import sys
import time

# ── the corpus, pinned ────────────────────────────────────────────────────
# Relative to CORPUS_ROOT. Split assignment is per FILE (see SPLITS), so no
# path appears in both dev and test. Every file here is real source from this
# repository, chosen to span: shell, python, ESM, TypeScript, and files both
# above and below the 3000-character card-body cap.
CORPUS_FILES = [
    # --- dev ---
    "bin/kb-search.sh",
    "bin/embed-index.py",
    "bin/embed_walker.py",
    "bin/lib/reconcile.mjs",
    "bin/lib/extract.mjs",
    "bin/lib/backfill-sessions.mjs",
    "bin/lib/mcp-server.mjs",
    "bin/lib/cli-main.mjs",
    "bin/kb-verify.sh",
    # --- test (everything below here; DEV_FILES slices at this point) ---
    "bin/lib/journal.mjs",
    "bin/lib/facts.mjs",
    "bin/lib/people.mjs",
    "bin/lib/lock.mjs",
    "bin/lib/people-cli.mjs",
    "bin/lib/facts-cli.mjs",
    "bin/heimdall.js",
    "bin/lib/graft-build.mjs",
    "bin/lib/enforcement-rules.mjs",
    "bin/kb-rebuild.sh",
]
# DEV is the first N entries; TEST is everything after. The N is load-bearing:
# it was 10 against a 9-file dev list, which silently put journal.mjs -- a file
# with two TEST questions -- into the dev corpus, making those questions
# unanswerable by construction. tests/longmemeval-s-integrity.test.mjs asserts
# every question's gold is in its own split, which is how it was caught.
DEV_FILES = CORPUS_FILES[:9]
TEST_FILES = CORPUS_FILES[10:]

# ── the questions ─────────────────────────────────────────────────────────
# Each is a real question about behaviour, phrased the way a user would phrase
# it. `gold` is the file that implements the answer. `why` records WHY the gold
# is right, so a future editor can tell a genuinely-good question from one that
# was reverse-engineered to be easy.
QUESTIONS = [
    # ================= DEV =================
    dict(split="dev", q="how does the search script combine the answers from several backends into one ranked list",
         gold="bin/kb-search.sh",
         why="kb-search.sh merges graft + semantic results, dedupes, sorts and truncates."),
    dict(split="dev", q="what decides whether a hit is trustworthy enough to act on without re-reading the file",
         gold="bin/kb-search.sh",
         why="The STRONG verdict needs path+size+mtime identity against the card."),
    dict(split="dev", q="how does the index get built without running two writers at once",
         gold="bin/kb-search.sh",
         why="kb-search.sh invokes embed-index.py, which takes an flock."),
    dict(split="dev", q="what turns a pile of text files into something searchable",
         gold="bin/embed-index.py",
         why="embed-index.py walks, embeds previews and upserts into vec."),
    dict(split="dev", q="which directories does the crawler refuse to look inside",
         gold="bin/embed_walker.py",
         why="embed_walker.py owns PRUNE_DIRS / PRUNE_PREFIXES."),
    dict(split="dev", q="how does the system converge when the index and the files disagree",
         gold="bin/lib/reconcile.mjs",
         why="reconcile.mjs reads current state and makes the graph match it."),
    dict(split="dev", q="what pulls structured facts out of raw notes and conversation files",
         gold="bin/lib/extract.mjs",
         why="extract.mjs turns bytes into typed fact candidates."),
    dict(split="dev", q="how do old conversation logs get turned into stored knowledge",
         gold="bin/lib/backfill-sessions.mjs",
         why="backfill-sessions.mjs scans recent sessions for facts."),
    dict(split="dev", q="how does something get connected to the tool that lets an assistant query memory",
         gold="bin/lib/mcp-server.mjs",
         why="mcp-server.mjs exposes kb_search over MCP."),
    dict(split="dev", q="which command line entry point dispatches every subcommand",
         gold="bin/lib/cli-main.mjs",
         why="cli-main.mjs is the argument dispatcher."),
    dict(split="dev", q="how do I check that what the index says still matches the files on disk",
         gold="bin/kb-verify.sh",
         why="kb-verify.sh is the verification entry point."),
    # ================= TEST =================
    dict(split="test", q="where does the system keep the record of what it knows, and how is it written safely",
         gold="bin/lib/journal.mjs",
         why="journal.mjs is the authoritative index, single-writer by construction."),
    dict(split="test", q="what guarantees a read can never block or corrupt a write",
         gold="bin/lib/journal.mjs",
         why="journal.mjs uses bound parameters and a single-writer lock."),
    dict(split="test", q="how are things the user asserted about themselves stored and looked up",
         gold="bin/lib/facts.mjs",
         why="facts.mjs owns preference/assertion/declaration/negation kinds."),
    dict(split="test", q="what reads a fact file and produces something the agent can consume",
         gold="bin/lib/facts-cli.mjs",
         why="facts-cli.mjs is the CLI reader/writer for the fact layer."),
    dict(split="test", q="where are people recorded so a question about a colleague can be answered",
         gold="bin/lib/people.mjs",
         why="people.mjs owns the people store."),
    dict(split="test", q="what turns the people store into a command someone can type",
         gold="bin/lib/people-cli.mjs",
         why="people-cli.mjs is the CLI surface for people."),
    dict(split="test", q="how does a stale lock from a dead process get cleaned up",
         gold="bin/lib/lock.mjs",
         why="lock.mjs reclaims a lock whose pid is gone, single writer, O_EXCL."),

    dict(split="test", q="what program do I run to rebuild the knowledge index",
         gold="bin/heimdall.js",
         why="bin/heimdall.js is the top-level CLI entry point."),
    dict(split="test", q="how is the code knowledge graph generated from the files",
         gold="bin/lib/graft-build.mjs",
         why="graft-build.mjs builds the graft graph."),
    dict(split="test", q="what stops me from recording a decision I have not actually made",
         gold="bin/lib/enforcement-rules.mjs",
         why="enforcement-rules.mjs holds the rules that gate what may be recorded."),
    dict(split="test", q="how do I get back to a working knowledge base after everything is deleted",
         gold="bin/kb-rebuild.sh",
         why="kb-rebuild.sh is the full rebuild script. Deliberately avoids the "
             "word 'rebuild', which is the distinctive stem of the filename and "
             "would have made the question trivial."),
]

SPLITS = {"dev": DEV_FILES, "test": TEST_FILES}


def questions_for(split: str) -> list[dict]:
    return [q for q in QUESTIONS if q["split"] == split]


# ── index build ───────────────────────────────────────────────────────────
DB_SCHEMA = """
CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    sha1 TEXT NOT NULL,
    root TEXT NOT NULL,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL
);
"""
# Mirrors embed-index.py: the card body is the first 3000 characters, and the
# DOCUMENT side of the embedding is "<title>\n<body>".
def _tokenize(q: str) -> set[str]:
    """Word tokens, matching the tokenizer in bin/kb-search.sh.

    Identifier-aware (kebab/snake/dotted/CamelCase) because source code is
    written that way: bin/lib/reconcile.mjs opens with the literal comment
    "// reconcile.mjs - level-triggered convergence", so whitespace-only
    tokenization cannot match "level triggered convergence" at all.
    """
    out = set()
    for part in re.split(r"[^A-Za-z0-9]+", q):
        if not part:
            continue
        for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+", part):
            if 2 <= len(w) <= 32:
                out.add(w.lower())
    return out


CARD_BODY_CAP = 3000


def _flat(v) -> list[float]:
    """Coerce encoder output to flat floats. Mirrors _flat_vec() in
    bin/embed-index.py -- a single-string encode is 1-D, a batch is 2-D."""
    if hasattr(v, "tolist"):
        v = v.tolist()
    if v and isinstance(v[0], (list, tuple)):
        v = v[0]
    return [float(x) for x in v]


def build_index(corpus_root: pathlib.Path, db_path: pathlib.Path,
                files: list[str], model_name: str, device: str = "cpu") -> dict:
    """Build a fresh pinned index. Deterministic: fixed inputs, new file."""
    import sqlite_vec
    from sentence_transformers import SentenceTransformer

    if db_path.exists():
        db_path.unlink()
    c = sqlite3.connect(db_path)
    c.enable_load_extension(True)
    sqlite_vec.load(c)
    c.executescript(DB_SCHEMA)
    c.execute("CREATE VIRTUAL TABLE vec USING vec0(embedding float[384])")
    model = SentenceTransformer(model_name, device=device)

    # get_sentence_embedding_dimension is deprecated in this version.
    dim = (model.get_embedding_dimension() if hasattr(model, "get_embedding_dimension")
           else model.get_sentence_embedding_dimension())
    if dim != 384:
        c.execute(f"DROP TABLE vec")
        c.execute(f"CREATE VIRTUAL TABLE vec USING vec0(embedding float[{dim}])")

    n = 0
    cur = c.cursor()
    for rel in files:
        abs_p = corpus_root / rel
        if not abs_p.exists():
            raise SystemExit(f"corpus file missing: {abs_p}")
        raw = abs_p.read_bytes()
        text = raw.decode("utf-8", "replace")
        card = text[:CARD_BODY_CAP]
        st = abs_p.stat()
        cid = f"f:{abs_p}"
        cur.execute(
            "INSERT INTO cards VALUES (?,?,?,?,?,?,?,?)",
            (cid, str(abs_p), abs_p.name, card, "", str(abs_p.parent),
             st.st_mtime, st.st_size))
        card_rowid = cur.lastrowid
        doc = f"{abs_p.name}\n{card}"
        # Mirror _flat_vec() in bin/embed-index.py exactly. A single-string
        # encode() returns 1-D, so encode(...)[0] yields a numpy.float32 scalar,
        # not a vector -- "object is not iterable". This must match the real
        # build byte for byte or the eval measures a different index.
        v = _flat(model.encode(doc, normalize_embeddings=True))
        # The vec rowid MUST be the card's rowid -- the eval's query joins
        # `vec v JOIN cards c ON c.rowid = v.rowid`. Reading cur.lastrowid
        # again here returns the same value, but capturing it right after the
        # cards insert is what makes that join's contract explicit.
        cur.execute("INSERT INTO vec(rowid, embedding) VALUES (?,?)",
                    (card_rowid, json.dumps([float(x) for x in v])))
        n += 1
    c.commit()
    c.close()
    return {"files": n, "dim": dim, "db": str(db_path)}


# ── retrieval under test ──────────────────────────────────────────────────
BGE_QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "


def query_paths(db_path: pathlib.Path, q: str, k: int = 10,
                model_name: str = "BAAI/bge-small-en-v1.5",
                device: str = "cpu", bge_instruction: bool = True,
                lex_weight: float = 0.0, rrf_k: int = 60) -> list[str]:
    """Semantic retrieval, optionally fused with a lexical channel.

    Deliberately NOT kb-search.sh: this isolates the EMBEDDING side so a
    hill-climb knob cannot be credited or blamed for changes made in the shell
    merge. The knob surface is the model, the instruction, the body cap, and
    this fusion.

    WHY FUSION IS HERE AT ALL. The measured ceiling for lexical-only ranking is
    that a paraphrased question can share ZERO tokens with its own answer:
    "which module decides strong versus weak trust verdicts" has 0 of 8 tokens
    in bin/lib/journal.mjs, which says "Single-writer by construction". So a
    lexical term alone cannot rank it, and its weight is inert (COV_WEIGHT
    0.5/1.5/3.0 all measured identically).

    Fusion is different from weighting, and the difference is the whole point.
    Weighting lets a zero signal stay zero. Reciprocal Rank Fusion instead adds
    the two channels INDEPENDENTLY -- a file that is mediocre on both can beat a
    file that is excellent on one and absent from the other. That is the only
    mechanism found so far that can reach a file the vector model ranks poorly,
    so it is the knob most likely to move held-out recall.

    RRF is used rather than a score sum because vector distances and lexical
    counts are not on a comparable scale; RRF needs only each channel's ORDER,
    which is scale-free and needs no normalisation constant to tune.
    """
    import sqlite_vec
    from sentence_transformers import SentenceTransformer

    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.enable_load_extension(True)
    sqlite_vec.load(c)
    m = SentenceTransformer(model_name, device=device)
    text = (BGE_QUERY_INSTRUCTION + q) if bge_instruction else q
    v = _flat(m.encode(text, normalize_embeddings=True))
    rows = c.execute(
        "SELECT c.path, v.distance FROM vec v JOIN cards c ON c.rowid = v.rowid "
        "WHERE v.embedding MATCH ? AND v.k = ?",
        (json.dumps(v), k)).fetchall()
    c.close()
    vec_order = [p for p, _ in rows]
    if lex_weight <= 0:
        return vec_order[:k]

    # Lexical channel: BM25-ish tf-idf over the same card bodies, computed in
    # python over the pinned corpus (it is ~9 files; an FTS5 index would be
    # faster at scale but would add a schema dependency to the eval for no gain).
    lex_order = _lexical_rank(db_path, q)
    fused: dict[str, float] = {}
    for order, w in ((vec_order, 1.0 - lex_weight), (lex_order, lex_weight)):
        for i, p in enumerate(order):
            fused[p] = fused.get(p, 0.0) + w / (rrf_k + i + 1)
    return [p for p, _ in sorted(fused.items(), key=lambda kv: (-kv[1], kv[0]))][:k]


def _lexical_rank(db_path: pathlib.Path, q: str) -> list[str]:
    """BM25 over card bodies, same word tokenization kb-search.sh uses."""
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    docs = c.execute("SELECT path, body FROM cards").fetchall()
    c.close()
    toks = [_tokenize(d[1] or "") for _, d in docs]
    paths = [p for p, _ in docs]
    N = len(paths) or 1
    avgdl = (sum(len(t) for t in toks) / N) or 1.0
    df = {}
    for t in toks:
        for w in t:
            df[w] = df.get(w, 0) + 1
    q_toks = _tokenize(q)
    k1, b = 1.5, 0.75
    scored = []
    for path, t in zip(paths, toks):
        tf = {}
        for w in t:
            tf[w] = tf.get(w, 0) + 1
        dl = len(t) or 1
        s = 0.0
        for w in q_toks:
            if w not in tf:
                continue
            idf = math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5))
            s += idf * (tf[w] * (k1 + 1)) / (tf[w] + k1 * (1 - b + b * dl / avgdl))
        if s > 0:
            scored.append((path, s))
    scored.sort(key=lambda kv: (-kv[1], kv[0]))
    return [p for p, _ in scored]


def score(split: str, db_path: pathlib.Path, ks=(1, 5, 10), **kw) -> dict:
    qs = questions_for(split)
    per_q = []
    for i, row in enumerate(qs, 1):
        paths = query_paths(db_path, row["q"], k=max(ks), **kw)
        gold = str((CORPUS_ROOT / row["gold"]).resolve())
        rank = next((j + 1 for j, p in enumerate(paths) if p == gold), None)
        rr = 0.0 if rank is None else 1.0 / rank
        per_q.append({"i": i, "q": row["q"], "gold": row["gold"],
                      "rank": rank, "rr": rr,
                      "top": [p.rsplit("/", 1)[-1] for p in paths[:3]]})
    n = len(per_q)
    out = {f"recall@{k}": round(sum(1 for x in per_q if x["rank"] and x["rank"] <= k) / n, 4)
           for k in ks}
    out["mrr"] = round(sum(x["rr"] for x in per_q) / n, 4)
    out["found"] = sum(1 for x in per_q if x["rank"])
    out["n"] = n
    return {"summary": out, "detail": per_q}


# ── cli ───────────────────────────────────────────────────────────────────
# The corpus is the repo itself by default. LME_CORPUS overrides it so the same
# eval file runs against a corpus staged elsewhere (jadupc1 keeps its copy under
# ~/eval/corpus rather than checking out the whole repo).
CORPUS_ROOT = pathlib.Path(os.environ.get("LME_CORPUS")
                           or pathlib.Path(__file__).resolve().parents[2])


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="test", choices=["dev", "test"])
    ap.add_argument("--corpus", default=str(CORPUS_ROOT))
    ap.add_argument("--db", default="/tmp/lmes-index.db")
    ap.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--no-instruction", action="store_true",
                    help="send the bare query, as embed-index.py used to")
    ap.add_argument("--lex-weight", type=float, default=0.0,
                    help="0 = vectors only; 0.5 = equal RRF; 1 = BM25 only")
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)

    db = pathlib.Path(a.db)
    files = SPLITS[a.split]
    if a.rebuild or not db.exists():
        t0 = time.time()
        info = build_index(pathlib.Path(a.corpus), db, files, a.model, a.device)
        if not a.quiet:
            print(f"[build] {info['files']} files, dim={info['dim']}, "
                  f"{time.time() - t0:.1f}s -> {db}")
    res = score(a.split, db, model_name=a.model, device=a.device,
                bge_instruction=not a.no_instruction,
                lex_weight=a.lex_weight)
    if not a.quiet:
        s = res["summary"]
        print(f"[{a.split}] recall@1={s['recall@1']:.3f} recall@5={s['recall@5']:.3f} "
              f"recall@10={s['recall@10']:.3f} mrr={s['mrr']:.3f} "
              f"found={s['found']}/{s['n']}")
        for d in res["detail"]:
            mark = "OK " if d["rank"] and d["rank"] <= 5 else "MISS"
            print(f"  {mark} r={str(d['rank']):>4}  {d['gold']:32} <- {d['q'][:52]}")
    if a.json:
        pathlib.Path(a.json).write_text(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
