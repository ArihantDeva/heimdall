# bench/tests/test_retrieve.py
import math, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from retrieve import rrf_rank_of

def test_rrf_inversion_matches_observed_scores():
    """F1: retrieve returns 1/(60+rank) and nothing else."""
    assert rrf_rank_of(0.0163934) == 1
    assert rrf_rank_of(0.016129) == 2
    assert rrf_rank_of(0.015873) == 3

def test_rrf_score_carries_no_relevance_information():
    """Documents WHY the client must fetch signals separately: two results at
    the same rank in different queries have identical scores regardless of how
    relevant they are. This test encodes the finding, not a behaviour."""
    assert math.isclose(1 / 61, 0.0163934, rel_tol=1e-5)
