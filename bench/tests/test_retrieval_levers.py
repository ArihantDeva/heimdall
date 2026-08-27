"""Unit tests for omega-cannibalized retrieval levers (O-001)."""
from __future__ import annotations

from datetime import datetime

from retrieval_levers import (
    _title_date,
    boost_recency,
    expand_query,
)

from retrieve import Candidate


def _cand(title: str, rrf: float) -> Candidate:
    return Candidate(id_hex="x", title=title, rrf=rrf)


def test_title_date_parses_graft_title() -> None:
    assert _title_date("session 3b3a77d9 — 2023/05/26 (Fri) 09:00") == \
        datetime(2023, 5, 26)
    assert _title_date("session gold_1 — 2023/02/20") == datetime(2023, 2, 20)
    assert _title_date("no date here") is None


def test_expand_query_counting_cues() -> None:
    q = expand_query("How many items of clothing do I need to pick up?")
    assert "every instance all occurrences each time" in q


def test_expand_query_entity_extraction() -> None:
    q = expand_query("Where does my sister Emily live?")
    assert "Emily" in q


def test_expand_query_temporal_yesterday() -> None:
    q = expand_query("What did I do yesterday?",
                     question_date="2023/05/26 (Fri) 09:00")
    assert "2023-05-25" in q  # yesterday resolved to absolute date


def test_expand_query_returns_original_when_no_signals() -> None:
    q = "hello"
    assert expand_query(q) == q


def test_boost_recency_fires_only_knowledge_update() -> None:
    old = _cand("session a — 2023/01/01", 0.01)
    new = _cand("session b — 2023/12/31", 0.01)
    boosted = boost_recency([old, new], "single-session-user")
    assert boosted == [old, new]  # unchanged for non-KU types

    boosted = boost_recency([old, new], "knowledge-update")
    assert boosted[0] is new  # newer session ranked first after boost


def test_boost_recency_handles_missing_dates() -> None:
    no_date = _cand("session no-date", 0.02)
    old = _cand("session a — 2023/01/01", 0.01)
    new = _cand("session b — 2023/12/31", 0.01)
    boosted = boost_recency([no_date, old, new], "knowledge-update")
    # no crash; the dated new candidate is boosted above its base score
    assert any(c.rrf > 0.01 for c in boosted if "2023/12/31" in c.title)