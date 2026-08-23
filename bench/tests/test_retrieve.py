# bench/tests/test_retrieve.py
import math, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from retrieve import Candidate, expand_facts_to_sessions, rrf_rank_of

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


PARENT = "session sharegpt_X — 2023-04-01 (2023/04/01 (Sat) 04:24)"


def _cand(title, keywords=(), score=None):
    return Candidate(id_hex="f" * 32, title=title,
                     rrf=score if score is not None else 1 / 61,
                     keywords=list(keywords))


def test_fact_hit_expands_to_parent_session_title():
    """Cycle-2 lever: fact precision converts into session recall by swapping
    a fact hit for its parent session — the title recall.py reads sids from."""
    cands = [_cand("I prefer vim [w.md:1]", [f"sid:{PARENT}"])]
    out = expand_facts_to_sessions(cands)
    assert out == [PARENT]


def test_nonfact_hits_pass_through_untouched():
    t = "session sharegpt_Y — 2023-03-03 (2023/03/03 (Fri) 14:12)"
    out = expand_facts_to_sessions([_cand(t)])
    assert out == [t]


def test_expansion_dedupes_against_ranked_sessions_and_keeps_first_position():
    """A fact hit whose parent already ranks must NOT insert a duplicate;
    expansion takes the parent's earliest position."""
    sess = _cand(PARENT, score=1 / 62)
    fact = _cand("I use arch btw [w.md:2]", [f"sid:{PARENT}"], score=1 / 61)
    assert expand_facts_to_sessions([fact, sess]) == [PARENT]


def test_expansion_is_stable_across_duplicate_parents():
    """Several fact windows of one session collapse to one entry."""
    f1 = _cand("I prefer tea [a.md:1]", [f"sid:{PARENT}"])
    f2 = _cand("I never skip tests [b.md:1]", [f"sid:{PARENT}"])
    assert expand_facts_to_sessions([f1, f2]) == [PARENT]


def test_fact_without_sid_keyword_degrades_to_its_own_title():
    """CPU-tier nodes carry no sid; expansion must be a no-op there so the
    same code path serves both tiers."""
    t = "orphan fact node title"
    assert expand_facts_to_sessions([_cand(t)]) == [t]
