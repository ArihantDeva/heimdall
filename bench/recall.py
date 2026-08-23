"""Token-free retrieval diagnostic.

`answer_session_ids` is ground truth, so recall@k needs no model at all.
This cleanly splits the S-score gap into a retrieval component and a reader
component — which decides where Plan 2 spends effort.
"""
from __future__ import annotations

import re
from collections import defaultdict


def _session_index(title: str) -> str | None:
    m = re.match(r"session (\S+) —", title)
    return m.group(1) if m else None


def is_abstention(question: dict) -> bool:
    """The `_abs` marker lives on question_id, never on the question text.

    It is NOT detectable from empty gold evidence: abstention questions carry a
    populated answer_session_ids just like every other question, so a
    "no gold => abstain" test silently never fires.
    """
    return str(question.get("question_id", "")).endswith("_abs")


def evidence_hit(question: dict, titles: list[str]) -> bool | None:
    """True/False if the question has gold evidence; None for abstention."""
    if is_abstention(question):
        return None
    gold = set(map(str, question.get("answer_session_ids") or []))
    if not gold:
        return None
    got = {_session_index(t) for t in titles}
    return bool(gold & got)


def recall_report(results: list[tuple[dict, list[str]]],
                  ks: tuple[int, ...] = (1, 5, 10, 25)) -> dict:
    """results: [(question, ranked_titles)]. Returns recall by type and k."""
    buckets: dict[str, dict[int, list[bool]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for question, titles in results:
        qtype = question["question_type"]
        for k in ks:
            hit = evidence_hit(question, titles[:k])
            if hit is not None:
                buckets[qtype][k].append(hit)

    return {
        qtype: {k: (sum(v) / len(v) if v else float("nan"))
                for k, v in per_k.items()}
        for qtype, per_k in buckets.items()
    }
