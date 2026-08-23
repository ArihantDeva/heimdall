# bench/tests/test_reader_contract.py
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from reader import build_prompt

def test_prompt_includes_session_timestamps():
    """Temporal-reasoning is unanswerable if dates are dropped on the way in."""
    ctx = [{"title": "session 0 — 2023-03-03 (2023/03/03 (Fri) 14:12)",
            "body": "user: I booked the Lisbon trip today."}]
    prompt = build_prompt("When did I book the trip?", ctx,
                          question_date="2023/05/20 (Sat) 10:00")
    assert "2023-03-03" in prompt
    assert "2023/05/20" in prompt, "question date anchors relative time words"

def test_prompt_permits_abstention():
    """_abs questions require an explicit escape hatch or the reader confabulates."""
    prompt = build_prompt("Unanswerable?", [], question_date="2023/05/20")
    assert "NO_ANSWER" in prompt
