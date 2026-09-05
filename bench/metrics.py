"""Additive diagnostics ported from omega-memory MemoryStress metrics
(benchmarks/memorystress/metrics.py): recall@age, degradation curve,
contradiction accuracy. Pure computation on graded results — never gates
the score, no new deps.

Age = how many sessions before the question (from the dataset haystack).
Contradiction = questions whose answer reflects a fact update/revert
(heimdall marks these with the `_abs` suffix convention in abstention mode;
here we use the dataset's question_type == 'knowledge-update' as a proxy
for contradiction-style updates).
"""
from __future__ import annotations

from dataclasses import dataclass, field

_AGE_BUCKETS = [
    ("0-100", 0, 100),
    ("100-500", 100, 500),
    ("500-1000", 500, 1000),
]


@dataclass
class GradedQuestion:
    question_id: str
    question_type: str
    correct: bool
    age_sessions: int = 0
    phase: int = 0


@dataclass
class MetricsResult:
    recall_at_age: dict[str, float] = field(default_factory=dict)
    degradation_curve: dict[int, float] = field(default_factory=dict)
    degradation_slope: float = 0.0
    contradiction_accuracy: float = 0.0
    contradiction_total: int = 0
    overall_accuracy: float = 0.0
    total_questions: int = 0
    total_correct: int = 0


def compute_metrics(graded: list[GradedQuestion]) -> MetricsResult:
    """Compute recall@age, degradation curve, contradiction accuracy."""
    r = MetricsResult()
    if not graded:
        return r
    r.total_questions = len(graded)
    r.total_correct = sum(1 for g in graded if g.correct)
    r.overall_accuracy = r.total_correct / r.total_questions

    for label, lo, hi in _AGE_BUCKETS:
        bucket = [g for g in graded if lo <= g.age_sessions < hi]
        r.recall_at_age[label] = (
            sum(1 for g in bucket if g.correct) / len(bucket) if bucket else 0.0
        )

    phases = sorted({g.phase for g in graded if g.phase > 0})
    for phase in phases:
        phase_qs = [g for g in graded if g.phase == phase]
        if phase_qs:
            r.degradation_curve[phase] = (
                sum(1 for g in phase_qs if g.correct) / len(phase_qs)
            )
    if len(r.degradation_curve) >= 2:
        xs = sorted(r.degradation_curve)
        ys = [r.degradation_curve[x] for x in xs]
        n = len(xs)
        mean_x, mean_y = sum(xs) / n, sum(ys) / n
        num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
        den = sum((x - mean_x) ** 2 for x in xs)
        r.degradation_slope = num / den if den else 0.0

    contra = [g for g in graded if g.question_type == "knowledge-update"]
    r.contradiction_total = len(contra)
    r.contradiction_accuracy = (
        sum(1 for g in contra if g.correct) / len(contra) if contra else 0.0
    )
    return r
