# bench/reader.py
"""Read-time answer synthesis. This is the ONLY place tokens are spent
on the memory path — ingest stays CPU-only per the global constraints."""
from __future__ import annotations

import subprocess

SYSTEM = """You answer questions from a user's own chat history.

Rules:
- Each session below is timestamped. Use the timestamps for any question about
  when something happened, or about what is currently true.
- When two sessions conflict, the LATER timestamp wins — the user changed
  their mind or updated the fact.
- If the sessions genuinely do not contain the answer, reply exactly NO_ANSWER.
  Do not guess. An invented answer is worse than an admitted gap.
- Otherwise answer concisely and directly."""


def build_prompt(question: str, context: list[dict],
                 question_date: str) -> str:
    parts = [SYSTEM, "", f"The question is being asked on: {question_date}", ""]
    if context:
        parts.append("Relevant sessions from the user's history:")
        for item in context:
            parts.append(f"\n--- {item['title']} ---")
            parts.append(item.get("body") or "")
    else:
        parts.append("No sessions were retrieved.")
    parts += ["", f"Question: {question}", "", "Answer:"]
    return "\n".join(parts)


def complete(prompt: str, model: str = "sonnet") -> str:
    """Run one completion through the `claude -p` headless CLI.

    This machine has no Anthropic API key; all model compute goes through the
    Max subscription via the CLI, so the SDK is not an option here.
    """
    out = subprocess.run(
        ["claude", "-p", prompt, "--model", model],
        capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()
