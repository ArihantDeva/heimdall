"""Unit tests for omega-cannibalized MemoryStress metrics (O-003)."""
from __future__ import annotations

from metrics import GradedQuestion, compute_metrics


def _g(qid: str, qtype: str, correct: bool, age: int = 0,
       phase: int = 0) -> GradedQuestion:
    return GradedQuestion(question_id=qid, question_type=qtype,
                          correct=correct, age_sessions=age, phase=phase)


def test_overall_and_recall_at_age() -> None:
    graded = [
        _g("a", "fact_recall", True, age=50),
        _g("b", "fact_recall", False, age=50),
        _g("c", "fact_recall", True, age=200),
    ]
    r = compute_metrics(graded)
    assert r.total_questions == 3
    assert round(r.overall_accuracy, 2) == 0.67
    assert r.recall_at_age["0-100"] == 0.5
    assert r.recall_at_age["100-500"] == 1.0


def test_degradation_curve_slope() -> None:
    graded = [
        _g("a", "fact_recall", True, phase=1),
        _g("b", "fact_recall", True, phase=1),
        _g("c", "fact_recall", False, phase=2),
        _g("d", "fact_recall", False, phase=2),
    ]
    r = compute_metrics(graded)
    assert r.degradation_curve == {1: 1.0, 2: 0.0}
    assert r.degradation_slope < 0  # accuracy drops over phases


def test_contradiction_accuracy() -> None:
    graded = [
        _g("a", "knowledge-update", True),
        _g("b", "knowledge-update", False),
        _g("c", "fact_recall", True),
    ]
    r = compute_metrics(graded)
    assert r.contradiction_total == 2
    assert r.contradiction_accuracy == 0.5


def test_empty_input() -> None:
    r = compute_metrics([])
    assert r.total_questions == 0
    assert r.overall_accuracy == 0.0