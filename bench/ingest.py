"""Materialize LongMemEval chat sessions as on-disk files, then insert them
into an isolated graft profile.

CPU-only by construction: no model is called here. Session timestamps are
encoded into the title and body because `graft insert` exposes no timestamp
field (only --expires-at), and the temporal-reasoning / knowledge-update
question types are unanswerable without them.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import time

GRAFT = pathlib.Path.home() / ".local/bin/graft"

# Stamped on every inserted node so a leak into the live `default` profile is
# detectable directly, rather than inferred from a node count that also drifts
# whenever real work is recorded.
BENCH_MARKER = "longmemeval-bench"


def _iso(date_str: str) -> str:
    """'2023/03/03 (Fri) 14:12' -> '2023-03-03'."""
    m = re.match(r"(\d{4})/(\d{2})/(\d{2})", date_str or "")
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else "unknown-date"


def session_title(session_id: str, date: str) -> str:
    return f"session {session_id} — {_iso(date)} ({date})"


def session_id_at(question: dict, idx: int) -> str:
    """The dataset's own session id, which is what answer_session_ids names.

    Falling back to the positional index would make recall@k always zero:
    gold ids look like 'answer_4be1b6b4_2', never '0'.
    """
    ids = question.get("haystack_session_ids") or []
    return str(ids[idx]) if idx < len(ids) else str(idx)


def windows(n_turns: int, size: int, stride: int) -> list[tuple[int, int]]:
    """Sliding [start, end) turn windows covering every turn at least once.

    Overlap matters: a fact stated at the boundary of two adjacent windows
    would otherwise be split across both and be well represented by neither.
    size <= 0 means "no chunking" — one window over the whole session.
    """
    if size <= 0 or n_turns <= size:
        return [(0, n_turns)]
    step = max(1, stride)
    spans = [(s, min(s + size, n_turns)) for s in range(0, n_turns, step)
             if s < n_turns]
    # Drop trailing windows already fully covered by their predecessor.
    return [w for i, w in enumerate(spans)
            if i == 0 or w[1] > spans[i - 1][1]]


def materialize(question: dict, root: pathlib.Path,
                chunk_size: int = 0, chunk_stride: int = 2
                ) -> list[tuple[pathlib.Path, int]]:
    """Write markdown files for the haystack. Returns (path, session_idx).

    With chunk_size > 0 each session is split into overlapping turn windows,
    so retrieval scores a focused passage instead of one averaged vector over
    an entire multi-turn conversation. The session id stays in every title,
    which is what recall scoring reads back out.
    """
    root = pathlib.Path(root)
    qdir = root / question["question_id"]
    qdir.mkdir(parents=True, exist_ok=True)

    out: list[tuple[pathlib.Path, int]] = []
    dates = question.get("haystack_dates") or []
    for idx, turns in enumerate(question["haystack_sessions"]):
        date = dates[idx] if idx < len(dates) else ""
        title = session_title(session_id_at(question, idx), date)
        for w, (lo, hi) in enumerate(windows(len(turns), chunk_size,
                                             chunk_stride)):
            lines = [f"# {title}", "", f"date: {date}",
                     f"iso_date: {_iso(date)}", ""]
            for turn in turns[lo:hi]:
                lines.append(f"{turn['role']}: {turn['content']}")
                lines.append("")
            path = qdir / f"session_{idx}_{w}.md"
            path.write_text("\n".join(lines), encoding="utf-8")
            out.append((path, idx))
    return out


def delete_nodes(id_hexes: list[str], profile: str = "longmemeval") -> None:
    """Remove nodes again so the next question starts from an empty haystack."""
    if profile == "default":
        raise RuntimeError("refusing to delete from the default profile")
    env = dict(os.environ, GRAFT_PROFILE=profile)
    for id_hex in id_hexes:
        subprocess.run([str(GRAFT), "delete", id_hex],
                       check=True, capture_output=True, env=env)


def ingest_question(question: dict, root: pathlib.Path,
                    profile: str = "longmemeval",
                    chunk_size: int = 0, chunk_stride: int = 2) -> list[str]:
    """Insert every materialized session into the ISOLATED profile.

    Returns the inserted id_hex list. Each LongMemEval question carries its own
    haystack, so the caller must delete these before the next question or
    retrieval leaks evidence across questions and the score is meaningless.
    """
    if profile == "default":
        raise RuntimeError(
            "refusing to ingest benchmark data into the default profile"
        )
    inserted: list[str] = []
    try:
        return _insert_all(question, root, profile, inserted,
                           chunk_size, chunk_stride)
    except BaseException:
        # A partial haystack must not survive: it would leak into the next
        # question's retrieval, and the `finally` in the caller never sees
        # these ids because the exception escaped before they were returned.
        delete_nodes(inserted, profile)
        raise


def _insert_all(question: dict, root: pathlib.Path, profile: str,
                inserted: list[str], chunk_size: int = 0,
                chunk_stride: int = 2) -> list[str]:
    dates = question.get("haystack_dates") or []
    for path, idx in materialize(question, root, chunk_size, chunk_stride):
        date = dates[idx] if idx < len(dates) else ""
        cmd = [
            str(GRAFT), "insert",
            "--title", session_title(session_id_at(question, idx), date),
            "--body", path.read_text(encoding="utf-8"),
            "--keyword", _iso(date),
            "--keyword", question["question_id"],
            "--keyword", BENCH_MARKER,
        ]
        env = dict(os.environ, GRAFT_PROFILE=profile)
        inserted.append(_insert_one(cmd, env))
    return inserted


def _insert_one(cmd: list[str], env: dict, attempts: int = 3) -> str:
    """One insert, retried. The daemon fails intermittently under sustained
    load, and a bare CalledProcessError hides graft's stderr entirely."""
    for attempt in range(1, attempts + 1):
        out = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if out.returncode == 0 and out.stdout.strip():
            return json.loads(out.stdout)["result"]["id_hex"]
        if attempt == attempts:
            raise RuntimeError(
                f"graft insert failed after {attempts} attempts "
                f"(rc={out.returncode}): {out.stderr.strip() or out.stdout.strip()!r}"
            )
        time.sleep(2 * attempt)
    raise AssertionError("unreachable")
