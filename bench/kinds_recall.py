#!/usr/bin/env python3
"""Phase 0 recall harness: scores three separately-gated retrieval slices.

    code   hit@10  gold = file paths (real, in global.db, on disk)
    fact   hit@10  gold = fact-title substrings
    person hit@3   gold = people ids

Pre-change (`--kind` does not exist until Phase 1) the fact and person slices
are 0 BY CONSTRUCTION, not by poor retrieval. The runner proves that per run
instead of asserting it: it re-measures people.db's absence and the
`owned_nodes WHERE kind='fact'` count, and it detects that `--kind` is an
unknown flag by diffing a probe run's hit set against a no-flag run (the flag
loop is a bare `case` with `*) shift`, so an unknown flag exits 0 and is
silently swallowed — exit code alone proves nothing).

    python3 bench/kinds_recall.py --help
    python3 bench/kinds_recall.py --queries bench/queries/retrieval-30.jsonl \
        --out bench/baselines/retrieval-30.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kinds_probe as probe  # noqa: E402  (same bench/ dir, no packaging here)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KB_SEARCH = os.path.join(REPO, "bin", "kb-search.sh")
DEFAULT_QUERIES = os.path.join(REPO, "bench", "queries", "retrieval-30.jsonl")

# ` 3. [STRONG] cov25%  as_of=38.6d fresh  /abs/path` — the path is the last
# whitespace-delimited token of the hit line, and is the only field carrying
# an anchor. Verdict/cov/freshness are the fixed-width columns before it.
# The anchor is NOT always absolute: a person hit is `people.db:<id>` (a
# relative token by design — it is a store row, not a file), so the pattern
# must accept both or every person hit silently fails to parse.
_HIT = re.compile(r"^\s*\d+\.\s\[(?P<verdict>[A-Z]+)\][^\n]*?(?P<path>\S+)\s*$")
_KINDS = ("code", "fact", "person")


def run_search(query: str, k: int, timeout: int,
               extra: list[str] | None = None) -> dict:
    """One kb-search.sh subprocess, hard-timeout. Never an unbounded run."""
    cmd = ["bash", KB_SEARCH, query, "-n", str(k)] + (extra or [])
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           cwd=REPO)
        rc, out = p.returncode, p.stdout
    except subprocess.TimeoutExpired as e:
        rc, out = -1, (e.stdout or b"").decode(errors="replace")
    # A hit is two lines: the numbered line carries the path, and the indented
    # line after it carries the DISPLAY TEXT (body). person/fact golds are
    # name/title substrings that live in that text, never in a path — a person
    # hit's path is `people.db:person-<sha256[0:12]>`, which no human-readable
    # gold can ever match. Both are captured, in rank order.
    hits, verdicts, bodies = [], [], []
    lines = out.splitlines()
    for i, line in enumerate(lines):
        m = _HIT.match(line)
        if m:
            hits.append(m.group("path"))
            verdicts.append(m.group("verdict"))
            body = ""
            if i + 1 < len(lines):
                nxt = lines[i + 1]
                if nxt.strip() and not _HIT.match(nxt):
                    body = nxt.strip()
            bodies.append(body)
    return {
        "rc": rc,
        "hits": hits,
        "bodies": bodies,
        "verdicts": verdicts,
        "semantic_error": "SEMANTIC_ERROR" in out,
        "index_error": "INDEX_ERROR" in out,
        "elapsed_s": round(time.time() - t0, 1),
    }


def kind_flag_is_wired(timeout: int) -> dict:
    """Does `--kind` actually change kb-search's output?

    `--kind` does not exist before Phase 1 and the flag loop swallows unknown
    flags, so the probe compares hit sets: identical => the flag is inert and
    every non-code slice is 0 by construction."""
    q = "who is Arihant Deva"
    plain = run_search(q, 3, timeout)
    withkind = run_search(q, 3, timeout, ["--kind", "person"])
    # `wired` must be deterministic. A single hit-set diff is not: the semantic
    # leg's ordering varies run to run, so a query that happens to return the
    # same three files twice reports `wired: true` on a tree where --kind does
    # not exist. The signal that cannot flap is the ANCHOR: `--kind person`
    # only ever emits `people.db:<id>` anchors. Until one appears, the flag is
    # inert, whatever the hit ordering did.
    people_anchors = [h for h in withkind["hits"] if h.startswith("people.db:")]
    return {
        "flag": "--kind",
        "rc_plain": plain["rc"],
        "rc_with_kind": withkind["rc"],
        "exits_zero": withkind["rc"] == 0,
        "hits_identical": plain["hits"] == withkind["hits"],
        "people_anchors_emitted": len(people_anchors),
        "wired": bool(people_anchors),
        "note": ("unknown flags are silently swallowed by the `case` loop in "
                 "bin/kb-search.sh, so exit code 0 proves nothing. Hit-set "
                 "equality is also unreliable — the semantic leg's ordering "
                 "varies between runs, so a same-result pair can read as "
                 "`wired: true` on a tree with no --kind at all. The anchor "
                 "count is the only stable signal: pre-Phase-1 it is always 0."),
    }


def score_row(row: dict, r: dict) -> bool:
    """One query, one slice. A hit is any gold present in the top-k results.

    code   — gold is an exact path, compared against the hit's path.
    person — gold is a NAME, compared against the displayed body line
             (path is `people.db:person-<sha>`, useless for matching).
    fact   — gold is a title SUBSTRING, compared case-insensitively against the
             displayed body line.
    """
    k = int(row.get("k", 10))
    paths = r.get("hits", [])[:k]
    bodies = r.get("bodies", [])[:k]
    if row["slice"] == "person":
        # A person hit anchors to `people.db:<id>` (K6: the store IS the record,
        # so it bypasses the filesystem verdict pass and has no file path).
        # Anchoring on the prefix is what stops the false positive where a body
        # that is merely a file path contains the gold: on the pre-change tree a
        # query for "Jev" matched `/Repos/skillranker/src/jev/mod.rs` and the
        # slice reported 0.20 with no people store in existence.
        return any(p.startswith("people.db:")
                   and any(g.lower() in b.lower() for g in row["golds"])
                   for p, b in zip(paths, bodies))
    if row["slice"] == "fact":
        # Facts are NOT exempt from the verdict pass — K6 covers people only, and
        # a fact hit anchors to its real source file (the prompt/session log it
        # was extracted from). So there is no `journal:` prefix to require; the
        # gold is a title substring matched against the displayed body.
        # A prefix check here would be inventing a contract the spec does not
        # define, and would make this slice unpassable forever.
        return any(g.lower() in b.lower() for b in bodies for g in row["golds"])
    return any(p in row["golds"] for p in paths)


def tree_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO,
                              capture_output=True, text=True,
                              timeout=20).stdout.strip()
    except Exception:
        return "unknown"


def score_slices(rows: list[dict], timeout: int, pass_kind: int) -> dict:
    per = {k: {"n": 0, "hits": 0, "k": 0, "degraded": [], "detail": []}
           for k in _KINDS}
    for row in rows:
        s = row["slice"]
        extra = ["--kind", s] if (pass_kind and s != "code") else []
        attempts, r = 0, None
        # A degraded leg is not a measurement. When the semantic index is busy
        # (a concurrent reconcile holds ~/.heimdall/embed-index.lock) the query
        # silently falls back to lexical-only and the gold drops out of the top
        # k — a FALSE MISS. Measured: a baseline recorded during a concurrent
        # reconcile read code=0.20, and the same 10 queries on an idle index
        # read 0.30, with the difference entirely `semantic_error=True` rows.
        # Retry rather than score it, and record anything still degraded.
        while attempts < 3:
            r = run_search(row["query"], int(row.get("k", 10)), timeout, extra)
            attempts += 1
            if not r["semantic_error"]:
                break
            time.sleep(5 * attempts)
        degraded = bool(r["semantic_error"] or r["index_error"])
        hit = score_row(row, r)
        per[s]["n"] += 1
        per[s]["hits"] += int(hit)
        per[s]["k"] = int(row.get("k", 10))
        if degraded:
            per[s]["degraded"].append(row["qid"])
        per[s]["detail"].append({
            "qid": row["qid"], "query": row["query"], "hit": hit,
            "rc": r["rc"], "elapsed_s": r["elapsed_s"],
            "semantic_error": r["semantic_error"],
            "index_error": r["index_error"],
            "degraded": degraded,
            "attempts": attempts,
            # A timeout or a crash scores 0, which is indistinguishable from a
            # retrieval miss unless it is named here.
            "failed": r["rc"] != 0,
            "top_hits": r["hits"][:3],
        })
    return per


def build_report(rows: list[dict], per: dict, kind_probe: dict, pc: dict,
                pass_kind: bool) -> dict:
    facts_empty = pc["fact_rows_journal"] == 0
    people_absent = not pc["people_db_exists"]
    out = {"measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "tree_commit": tree_commit(),
           "kind_flag": kind_probe,
           "structural_zeros": {"people_db_absent": people_absent,
                                "fact_rows_zero": facts_empty}}

    reasons = {
        "code": "code slice is measured against bin/kb-search.sh as it exists "
                "today; golds are real paths present in global.db and on disk",
        "fact": ("no fact rows exist to retrieve" if facts_empty else
                 f"journal.owned_nodes holds {pc['fact_rows_journal']} fact "
                 "row(s); the fact leg is not implemented, so those rows are "
                 "not reachable through the search path"
                 + ("" if kind_probe["wired"] else
                    " and --kind is an unknown flag that is silently "
                    "swallowed")),
        "person": ("~/.heimdall/people.db does not exist, so no people ids "
                   "can be returned"
                   + ("" if kind_probe["wired"] else
                      "; --kind person is also an unknown flag that is "
                      "silently swallowed, so the query falls through to the "
                      "code leg")),
    }
    for s in _KINDS:
        d = per[s]
        failed = [x["qid"] for x in d["detail"] if x["failed"]]
        degraded = list(d.get("degraded", []))
        out.setdefault("per_slice", {})[s] = {
            "n": d["n"], "k": d["k"], "hits": d["hits"],
            "failed_queries": failed,
            "degraded_queries": degraded,
            # run_valid is FALSE if any query failed OR is still degraded. A
            # degraded query fell back to lexical-only and its gold dropped out
            # of the top k — that is a false miss, not a retrieval failure, so
            # a number that includes it is not a measurement of anything.
            "run_valid": not failed and not degraded,
            "hit_rate": round(d["hits"] / d["n"], 4) if d["n"] else 0.0,
            "structural_zero": s != "code",
            "reason": reasons[s],
            "preconditions": {
                "people_db_exists": pc["people_db_exists"],
                "fact_rows_journal": pc["fact_rows_journal"],
                "kind_flag_wired": kind_probe["wired"],
                "kind_flag_rc_with_kind": kind_probe["rc_with_kind"],
                "golds_real": (probe.code_gold_status(
                    [g for r in rows if r["slice"] == "code"
                     for g in r["golds"]])
                    if s == "code" else
                    "not_applicable: golds are names/titles with no "
                    "backing store yet — recorded as structurally "
                    "unscoreable until Phase 2/3 create people.db and fact rows"),
            },
            "detail": d["detail"],
        }
    return out


def self_check() -> int:
    """Asserts the scoring logic on fixed inputs — no search, no index."""
    row_code = {"slice": "code", "k": 10, "golds": ["/a/b.py"]}
    row_fact = {"slice": "fact", "k": 10, "golds": ["the fact layer is dead"]}
    row_person = {"slice": "person", "k": 3, "golds": ["Jev"]}
    # `mk` mirrors a real hit: the path lives in the numbered line, the
    # name/title lives in the body line that follows it.
    mk = lambda paths, bodies=(): {"hits": list(paths),  # noqa: E731
                                   "bodies": list(bodies) or [""] * len(paths)}
    assert score_row(row_code, mk(["/x.py", "/a/b.py"])) is True
    assert score_row(row_code, mk(["/x.py", "/y.py"])) is False
    # person gold matches the BODY, never the path — a person hit's path is an
    # opaque `people.db:person-<sha>` that no readable gold could match.
    assert score_row(row_person, mk(["people.db:person-abc123"],
                                    ["Jev · decider model"])) is True
    assert score_row(row_person, mk(["people.db:person-abc123"],
                                    ["Someone Else"])) is False
    # a person gold in the PATH but not the body must NOT hit: that was the
    # exact false-negative this rewrite exists to close.
    assert score_row(row_person, mk(["people.db:person:jev"], ["Someone"])) is False
    # a REAL FILE whose body merely contains the gold must NOT hit the person
    # slice — this is the false positive that made the pre-change baseline
    # report 0.20 with no people store in existence.
    assert score_row(row_person, mk(["/Repos/x/src/jev/mod.rs"], ["mod.rs"])) is False
    # facts are NOT prefix-anchored: a fact hit anchors to its real source file
    # (K6 exempts people only), so a normal path + matching body IS a hit.
    assert score_row(row_fact, mk(["/Users/x/.pi/agent/sessions/s.jsonl"],
                                  ["the fact layer is dead"])) is True
    assert score_row(row_fact, mk(["/x.py"], ["the fact layer is dead"])) is True
    assert score_row(row_fact, mk(["/x.py"], ["unrelated"])) is False
    # k truncation: a gold at position 3 is a hit for person (k=3), a miss at 4.
    assert score_row(row_person, mk(["a", "b", "people.db:p3"], ["x", "y", "Jev"])) is True
    assert score_row(row_person, mk(["a", "b", "c", "d"],
                                    ["x", "y", "z", "Jev"])) is False
    assert score_row(row_code, mk(["/z"] * 10 + ["/a/b.py"])) is False  # pos 11, k=10
    # a hit line parses into its path, and the following body line is captured
    m = _HIT.match(" 3. [STRONG] cov25%  as_of=38.6d fresh  /a/b/c.py")
    assert m and m.group("path") == "/a/b/c.py" and m.group("verdict") == "STRONG"
    assert _HIT.match("      some title line") is None
    # the real person-hit shape from the spec
    p = _HIT.match(" 1. [STRONG] cov100%  people.db:person-4f2a9c1b7e30")
    assert p and p.group("path").startswith("people.db:person-")
    print("self_check OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Score code/fact/person retrieval slices against kb-search.")
    ap.add_argument("--queries", default=DEFAULT_QUERIES,
                    help="JSONL of gold-labelled queries")
    ap.add_argument("--out", help="write the report JSON here (default stdout)")
    ap.add_argument("--timeout", type=int, default=180,
                    help="per-query subprocess timeout in seconds (default 180)")
    ap.add_argument("--pass-kind", action="store_true",
                    help="pass --kind <slice> (only valid after Phase 1; "
                         "without it the flag is unknown and silently ignored)")
    ap.add_argument("--self-check", action="store_true",
                    help="assert scoring logic on fixed inputs; no search")
    a = ap.parse_args()
    if a.self_check:
        return self_check()

    with open(a.queries) as fh:
        rows = [json.loads(l) for l in fh if l.strip()]
    missing = {r["slice"] for r in rows} - set(_KINDS)
    assert not missing, f"unknown slice(s) in {a.queries}: {missing}"

    kp = kind_flag_is_wired(a.timeout)
    per = score_slices(rows, a.timeout, a.pass_kind)
    report = build_report(rows, per, kp, probe.preconditions(), a.pass_kind)

    text = json.dumps(report, indent=2)
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "w") as fh:
            fh.write(text + "\n")
        print(f"wrote {a.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
