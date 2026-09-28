#!/usr/bin/env python3
"""Rebuild/verify bench/queries/retrieval-30.jsonl golds from the LIVE index.

Phase 0's golds must be reproducible, not typed from memory. This probes
`~/.heimdall/global.db` (read-only) and asserts, per code gold, that the path
(a) is present in `cards` and (b) still exists on disk — the two properties the
spec's code slice requires. It also re-measures the structural preconditions
the fact and person slices are 0-by (people.db absent, owned_nodes fact count)
so a claimed zero can be falsified.

    python3 bench/kinds_probe.py            # verify + print
    python3 bench/kinds_probe.py --self-check   # assert golds are still real
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLOBAL_DB = os.path.expanduser("~/.heimdall/global.db")
PEOPLE_DB = os.path.expanduser("~/.heimdall/people.db")
JOURNAL_DB = os.path.expanduser("~/.heimdall/journal.db")
QUERIES = os.path.join(REPO, "bench", "queries", "retrieval-30.jsonl")


def _ro(path: str) -> sqlite3.Connection:
    """Read-only handle for the big stable index (global.db)."""
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _scratch_copy(src: str) -> tuple[tempfile.TemporaryDirectory, str]:
    """journal.db has a live writer: read it in place and you risk a torn
    snapshot. The copy is also WAL, and a WAL database with no -wal/-shm
    sidecar cannot be recovered by a read-only handle ('unable to open
    database file'), so the scratch copy is opened read-write. The live db is
    only ever read."""
    td = tempfile.TemporaryDirectory()
    tmp = os.path.join(td.name, os.path.basename(src))
    shutil.copyfile(src, tmp)
    for side in ("-wal", "-shm"):
        if os.path.exists(src + side):
            shutil.copyfile(src + side, tmp + side)
    return td, tmp


def journal_fact_count() -> int:
    """Number of kind='fact' rows in journal.owned_nodes (live-writer safe)."""
    td, tmp = _scratch_copy(JOURNAL_DB)
    try:
        con = sqlite3.connect(tmp)
        try:
            return con.execute(
                "SELECT count(*) FROM owned_nodes WHERE kind='fact'").fetchone()[0]
        finally:
            con.close()
    finally:
        td.cleanup()


def code_gold_status(golds: list[str]) -> list[dict]:
    con = _ro(GLOBAL_DB)
    try:
        out = []
        for g in golds:
            n = con.execute("SELECT count(*) FROM cards WHERE path=?",
                            (g,)).fetchone()[0]
            out.append({"path": g, "cards": n, "on_disk": os.path.exists(g),
                        "ok": bool(n) and os.path.exists(g)})
        return out
    finally:
        con.close()


def preconditions() -> dict:
    return {
        "people_db": PEOPLE_DB,
        "people_db_exists": os.path.exists(PEOPLE_DB),
        "fact_rows_journal": journal_fact_count(),
    }


def _load() -> list[dict]:
    with open(QUERIES) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def self_check() -> None:
    """Fails if the golds stop being real — a dead gold silently turns the
    code slice into a structural 0 that would masquerade as a retrieval
    regression in a later phase."""
    rows = _load()
    code = [r for r in rows if r["slice"] == "code"]
    assert len(rows) == 30, f"expected 30 queries, got {len(rows)}"
    assert len(code) == 10, f"expected 10 code queries, got {len(code)}"
    bad = [g for g in code_gold_status(
        [x for r in code for x in r["golds"]]) if not g["ok"]]
    assert not bad, f"dead golds (not in cards or not on disk): {bad}"
    pc = preconditions()
    assert pc["fact_rows_journal"] == 2, (
        f"expected the recorded 2 fact rows, got {pc['fact_rows_journal']} — the "
        "fact slice's structural-zero claim must be re-measured, not inherited")
    print("self_check OK: 10 code golds live in cards + on disk; "
          f"preconditions reproduced (fact_rows={pc['fact_rows_journal']}, "
          f"people_db_exists={pc['people_db_exists']})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--self-check", action="store_true",
                    help="assert the committed golds are still real")
    a = ap.parse_args()
    if a.self_check:
        self_check()
        return 0
    print(json.dumps(preconditions(), indent=2))
    rows = _load()
    for g in code_gold_status([x for r in rows if r["slice"] == "code"
                               for x in r["golds"]]):
        print(f"{'ok ' if g['ok'] else 'BAD'} cards={g['cards']} {g['path']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
