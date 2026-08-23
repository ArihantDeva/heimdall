import json, pathlib, pytest

DATA = pathlib.Path(__file__).resolve().parents[1] / "data"

REQUIRED_KEYS = {
    "question_id", "question_type", "question", "answer",
    "question_date", "haystack_sessions", "haystack_dates",
    "answer_session_ids",
}

def test_oracle_dataset_shape():
    path = DATA / "longmemeval_oracle.json"
    assert path.exists(), f"missing {path}; run bench/fetch_data.sh"
    rows = json.loads(path.read_text())
    assert len(rows) == 500, f"expected 500 questions, got {len(rows)}"
    for row in rows:
        missing = REQUIRED_KEYS - row.keys()
        assert not missing, f"{row.get('question_id')} missing {missing}"

def test_abstention_questions_are_marked():
    rows = json.loads((DATA / "longmemeval_oracle.json").read_text())
    abs_rows = [r for r in rows if r["question_id"].endswith("_abs")]
    assert abs_rows, "no abstention questions found; _abs suffix convention changed"
