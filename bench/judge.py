# bench/judge.py
"""LLM-as-judge grading, mirroring LongMemEval's evaluate_qa.py contract."""
from __future__ import annotations

from reader import complete

MODEL = "sonnet"

RUBRIC = {
    "temporal-reasoning":
        "The response must identify the correct time or ordering. "
        "A right fact with the wrong date is INCORRECT.",
    "knowledge-update":
        "The response must reflect the MOST RECENT state. "
        "Citing a superseded earlier value is INCORRECT.",
    "single-session-preference":
        "The response must respect the user's stated preference.",
}
DEFAULT_RUBRIC = "The response must contain the correct answer."


def grade(question: str, gold: str, response: str, qtype: str,
          question_id: str = "") -> bool:
    # The _abs suffix lives on question_id, NOT on the question text.
    # Testing the wrong field makes abstention detection silently never fire.
    if question_id.endswith("_abs") or gold in (None, "", "NO_ANSWER"):
        # Abstention: correct iff the reader declined to answer.
        return "NO_ANSWER" in (response or "").upper()

    rubric = RUBRIC.get(qtype, DEFAULT_RUBRIC)
    prompt = (
        f"{rubric}\n\n"
        f"Question: {question}\n"
        f"Correct answer: {gold}\n"
        f"Model response: {response}\n\n"
        "Reply with exactly one word: CORRECT or INCORRECT."
    )
    return complete(prompt, model=MODEL).strip().upper().startswith("CORRECT")
