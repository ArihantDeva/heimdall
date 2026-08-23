import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from recall import evidence_hit
from ingest import session_title, session_id_at

def test_evidence_hit_true_when_gold_session_retrieved():
    question = {"answer_session_ids": ["3"]}
    titles = ["session 7 — 2023-01-01", "session 3 — 2023-03-03"]
    assert evidence_hit(question, titles) is True

def test_evidence_hit_false_when_gold_session_absent():
    question = {"answer_session_ids": ["3"]}
    titles = ["session 7 — 2023-01-01", "session 9 — 2023-03-03"]
    assert evidence_hit(question, titles) is False

def test_abstention_questions_have_no_gold_evidence():
    """_abs questions are unanswerable by design; recall is undefined for them
    and they must be excluded from the recall denominator.

    The marker is the question_id suffix. In the real dataset an _abs question
    still carries a populated answer_session_ids, so detecting abstention by
    "gold is empty" silently never fires."""
    question = {"question_id": "gpt4_b3070ec4_abs",
                "answer_session_ids": ["answer_b3070ec4_abs_1"]}
    assert evidence_hit(question, ["session answer_b3070ec4_abs_1 — 2023-01-01"]) is None


def test_ingest_titles_are_parseable_back_to_gold_session_ids():
    """The whole recall diagnostic hinges on this round-trip: the id ingest
    writes into the title must be the id answer_session_ids names. Using the
    positional index instead reads as recall 0.0 for every question."""
    question = {
        "question_id": "gpt4_2655b836",
        "haystack_session_ids": ["answer_4be1b6b4_2", "answer_4be1b6b4_3"],
        "haystack_dates": ["2023/04/10 (Mon) 17:50", "2023/04/10 (Mon) 14:47"],
        "answer_session_ids": ["answer_4be1b6b4_3"],
    }
    titles = [session_title(session_id_at(question, i),
                            question["haystack_dates"][i]) for i in range(2)]
    assert evidence_hit(question, titles) is True
    assert evidence_hit(question, titles[:1]) is False
