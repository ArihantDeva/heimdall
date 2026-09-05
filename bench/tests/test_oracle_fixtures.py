"""Oracle-ceiling fixture integrity (M-001).

The 60-question stratified oracle sample and its 12 failure cases are frozen
so every reader/judge lever A/B runs against the SAME questions. A lever's
delta is only meaningful against this fixed baseline.
"""
from __future__ import annotations

import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"


def _load(name: str) -> list[dict]:
    return json.loads((FIXTURES / name).read_text())


def test_oracle_sample_frozen() -> None:
    sample = _load("oracle_sample_60.json")
    assert len(sample) == 60
    # every question carries a retrievable context + gold answer
    for q in sample:
        assert q["question_id"]
        assert q.get("context"), q["question_id"]
        assert q.get("answer") is not None, q["question_id"]


def test_failure_fixture_matches_sample() -> None:
    sample = _load("oracle_sample_60.json")
    failures = _load("oracle_failures.json")
    sample_ids = {q["question_id"] for q in sample}
    for f in failures:
        assert f["question_id"] in sample_ids, f["question_id"]
        assert f["failure_class"], f["question_id"]
    # every failure class is one of the known reader/judge failure modes
    known = {"abstention", "recency", "counting", "preference",
             "temporal", "arithmetic", "gateway"}
    assert all(f["failure_class"] in known for f in failures)