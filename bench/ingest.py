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
import concurrent.futures
import pathlib
import re
import subprocess
import time

GRAFT = pathlib.Path("/Users/arihantdeva/Repos/heimdall/vendor/graft/build/graft")
HERE = pathlib.Path(__file__).resolve().parent
FACTS_CLI = HERE.parent / "bin" / "lib" / "facts-cli.mjs"
NODE = os.environ.get("NODE", "node")

# Stamped on every inserted node so a leak into the live `default` profile is
# detectable directly, rather than inferred from a node count that also drifts
# whenever real work is recorded.
BENCH_MARKER = "longmemeval-bench"


def shim_facts(path: pathlib.Path) -> list[dict]:
    """Run the ONE extractor over a materialized window (spec D3: consumed as
    a subprocess — never re-implemented here). Returns the JSON fact array."""
    out = subprocess.run([NODE, str(FACTS_CLI), "--file", str(path)],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"facts-cli failed on {path}: {out.stderr.strip()}")
    return json.loads(out.stdout)


def fact_insert_cmd(fact: dict, parent_title: str,
                    question_id: str) -> list[str]:
    """Deterministic insert command for one fact node.

    The cycle-1 ablation failed because fact fragments displaced their parent
    session with no retrievable link back. The fix lives entirely in keywords:
    `sid:<exact parent title>` rides on every graft result row (retrieve emits
    keywords), so retrieval can rewrite a fact hit into its parent session
    with zero extra graft calls — token-free and available in --recall-only.
    BENCH_MARKER stays on every node so purge removes facts like sessions."""
    keywords = list(fact.get("keywords") or [])
    return [
        str(GRAFT), "insert",
        "--title", f"fact: {fact['title']}",
        "--body", fact["body"],
        *sum([["--keyword", k] for k in keywords], []),
        "--keyword", question_id,
        "--keyword", BENCH_MARKER,
        "--keyword", f"sid:{parent_title}",
    ]


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


def profile_node_count(profile: str = "longmemeval") -> int:
    try:
        out = subprocess.run([str(GRAFT), "stats"], capture_output=True, text=True,
                             env=dict(os.environ, GRAFT_PROFILE=profile),
                             timeout=8)
    except subprocess.TimeoutExpired:
        out = None
    if out is not None and out.stdout.strip():
        try:
            return json.loads(out.stdout)["result"]["n_nodes"]
        except Exception:
            pass
    # stats is broken on some daemon builds (wire timeout); count via a broad
    # retrieve instead — hits are capped at top_k but non-zero proves dirt.
    out = subprocess.run([str(GRAFT), "retrieve", BENCH_MARKER, "--top-k", "10"],
                         capture_output=True, text=True,
                         env=dict(os.environ, GRAFT_PROFILE=profile),
                         timeout=20)
    if out.stdout.strip():
        try:
            return len(json.loads(out.stdout)["result"]["results"])
        except Exception:
            pass
    return 0


def require_empty_profile(profile: str = "longmemeval") -> None:
    """Refuse to measure against a dirty haystack.

    Every stray node left by an interrupted run is a distractor competing with
    the gold session, so a dirty profile reads as a retrieval regression that
    no code change caused. Fail loudly instead of quietly scoring noise.
    """
    n = profile_node_count(profile)
    if n:
        raise RuntimeError(
            f"profile '{profile}' holds {n} nodes before the run started. "
            "An earlier run was interrupted before its cleanup. "
            "Purge with bench/purge.py, then re-run."
        )


def _delete_one(id_hex: str, env: dict, attempts: int = 3) -> None:
    """One delete, retried. Under sustained load the daemon intermittently
    fails (rc=3 after 'schema apply failed'), same as insert does."""
    for attempt in range(1, attempts + 1):
        out = subprocess.run([str(GRAFT), "delete", id_hex],
                             capture_output=True, text=True, env=env)
        if out.returncode == 0:
            return
        # rc=3 'not found' = already gone (daemon restart can roll back the
        # WAL). Cleanup is idempotent by contract.
        if out.returncode == 3 and '"not found"' in (out.stdout + out.stderr):
            return
        if attempt == attempts:
            raise RuntimeError(
                f"graft delete {id_hex} failed after {attempts} attempts "
                f"(rc={out.returncode}): {out.stderr.strip() or out.stdout.strip()}"
            )
        time.sleep(2 * attempt)


def delete_nodes(id_hexes: list[str], profile: str = "longmemeval") -> None:
    """Remove nodes again so the next question starts from an empty haystack."""
    if profile == "default":
        raise RuntimeError("refusing to delete from the default profile")
    env = dict(os.environ, GRAFT_PROFILE=profile)
    for id_hex in id_hexes:
        _delete_one(id_hex, env)


def ingest_question(question: dict, root: pathlib.Path,
                    profile: str = "longmemeval",
                    chunk_size: int = 0, chunk_stride: int = 2,
                    facts: bool = False) -> list[str]:
    """Insert every materialized session into the ISOLATED profile.

    Returns the inserted id_hex list. Each LongMemEval question carries its own
    haystack, so the caller must delete these before the next question or
    retrieval leaks evidence across questions and the score is meaningless.
    With facts=True each window additionally emits its CPU-extracted fact
    nodes (same profile, same marker, parent-linked by sid keyword).
    """
    if profile == "default":
        raise RuntimeError(
            "refusing to ingest benchmark data into the default profile"
        )
    inserted: list[str] = []
    try:
        return _insert_all(question, root, profile, inserted,
                           chunk_size, chunk_stride, facts)
    except BaseException:
        # A partial haystack must not survive: it would leak into the next
        # question's retrieval, and the `finally` in the caller never sees
        # these ids because the exception escaped before they were returned.
        delete_nodes(inserted, profile)
        raise


_INSERT_WORKERS = 8  # daemon pools embed instances; inserts are CPU-embed bound


def _insert_all(question: dict, root: pathlib.Path, profile: str,
                inserted: list[str], chunk_size: int = 0,
                chunk_stride: int = 2, facts: bool = False) -> list[str]:
    dates = question.get("haystack_dates") or []
    env = dict(os.environ, GRAFT_PROFILE=profile)
    tasks: list[tuple[str, pathlib.Path, str]] = []
    for path, idx in materialize(question, root, chunk_size, chunk_stride):
        date = dates[idx] if idx < len(dates) else ""
        title = session_title(session_id_at(question, idx), date)
        tasks.append((title, path, date))

    def run_one(task: tuple[str, pathlib.Path, str]) -> list[str]:
        title, path, date = task
        body = path.read_text(encoding="utf-8")
        cmd = [
            str(GRAFT), "insert",
            "--title", title,
            "--body", body,
            "--keyword", _iso(date),
            "--keyword", question["question_id"],
            "--keyword", BENCH_MARKER,
        ]
        ids = [_insert_one(cmd, env)]
        if facts:
            for fact in shim_facts(path):
                ids.append(_insert_one(
                    fact_insert_cmd(fact, title, question["question_id"]),
                    env))
        return ids

    with concurrent.futures.ThreadPoolExecutor(
            max_workers=_INSERT_WORKERS) as pool:
        for ids in pool.map(run_one, tasks):
            inserted.extend(ids)
    return inserted


def _insert_one(cmd: list[str], env: dict, attempts: int = 6) -> str:
    """One insert, retried. The daemon fails intermittently under sustained
    load (status=4 storage / status=5 embedding, rc=3); a bare
    CalledProcessError hides graft's stderr entirely. v1 lost 10/490
    questions to 3-attempt linear retry; exponential backoff + more
    attempts rides out longer daemon stalls."""
    for attempt in range(1, attempts + 1):
        out = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if out.returncode == 0 and out.stdout.strip():
            return json.loads(out.stdout)["result"]["id_hex"]
        if attempt < attempts:
            time.sleep(min(2 ** (attempt - 1), 20))
    raise RuntimeError(
        f"graft insert failed after {attempts} attempts "
        f"(rc={out.returncode}): {out.stderr.strip() or out.stdout.strip()!r}"
    )
