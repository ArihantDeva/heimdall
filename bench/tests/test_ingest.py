import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from ingest import materialize, session_title

QUESTION = {
    "question_id": "q1",
    "question_type": "temporal-reasoning",
    "question": "When did I book the trip?",
    "answer": "March 3rd",
    "question_date": "2023/05/20 (Sat) 10:00",
    "haystack_dates": ["2023/03/03 (Fri) 14:12", "2023/04/01 (Sat) 09:00"],
    "haystack_sessions": [
        [{"role": "user", "content": "I booked the Lisbon trip today."},
         {"role": "assistant", "content": "Nice, Lisbon in March is lovely."}],
        [{"role": "user", "content": "What is the capital of France?"},
         {"role": "assistant", "content": "Paris."}],
    ],
    "answer_session_ids": ["0"],
}

def test_materialize_writes_one_file_per_session(tmp_path):
    out = materialize(QUESTION, tmp_path)
    assert len(out) == 2, "unchunked, one file per session"
    assert [idx for _, idx in out] == [0, 1]
    assert all(p.exists() for p, _ in out)

def test_session_file_embeds_its_timestamp(tmp_path):
    """F5: graft insert has no timestamp field, so the date must live in the text
    or temporal-reasoning and knowledge-update are unanswerable."""
    body = materialize(QUESTION, tmp_path)[0][0].read_text()
    assert "2023/03/03" in body, "session date missing from body"
    assert "user:" in body and "assistant:" in body, "roles must be preserved"

def test_title_carries_iso_date_for_lexical_matching():
    t = session_title("0", "2023/03/03 (Fri) 14:12")
    assert "2023-03-03" in t, "ISO form aids lexical retrieval on date queries"

def test_no_llm_call_at_ingest(tmp_path, monkeypatch):
    """Global constraint: ingest is CPU-only. Fail loudly if anyone adds a model call."""
    import ingest
    for banned in ("anthropic", "openai"):
        monkeypatch.setitem(sys.modules, banned, None)
    materialize(QUESTION, tmp_path)  # must not raise
