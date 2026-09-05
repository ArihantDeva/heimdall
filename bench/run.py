# bench/run.py
"""LongMemEval runner: ingest -> retrieve -> (optionally) read -> judge."""
from __future__ import annotations

import argparse
import json
import pathlib
import time

from ingest import delete_nodes, ingest_question, require_empty_profile
from reader import build_prompt, complete
from recall import recall_report
from retrieve import expand_facts_to_sessions

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"
RUNS = HERE / "runs"


def answer(question: dict, context: list[dict]) -> str:
    prompt = build_prompt(question["question"], context,
                          question["question_date"])
    return complete(prompt)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", choices=["oracle", "s", "m"], required=True)
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--start", type=int, default=1,
                    help="1-based index of first question (resume support)")
    ap.add_argument("--subset", choices=["cycle1"], default=None,
                    help="named question subset for cross-run comparability; "
                         "overrides --limit")
    ap.add_argument("--top-k", type=int, default=25)
    ap.add_argument("--chunk-size", type=int, default=0,
                    help="turns per retrieval unit; 0 = whole session")
    ap.add_argument("--chunk-stride", type=int, default=2)
    ap.add_argument("--recall-only", action="store_true",
                    help="token-free retrieval diagnostic; skips reader+judge")
    ap.add_argument("--facts", action="store_true",
                    help="also ingest CPU-extracted fact nodes (agent tier)")
    ap.add_argument("--tier", choices=["cpu", "agent"], default="cpu",
                    help="stamped into summary.json for regression gating")
    args = ap.parse_args()
    if args.tier == "agent" and not args.facts:
        ap.error("--tier agent requires --facts")
    if args.facts and args.tier == "cpu":
        ap.error("--facts requires --tier agent")

    from retrieve import search  # imported late so --recall-only still needs it

    # A run that starts with nodes already in the profile is measuring a
    # haystack it did not build. Stray nodes survive any interrupted run,
    # because SIGTERM skips the per-question cleanup, and they act as
    # distractors that silently depress recall for every later run.
    require_empty_profile()

    rows = json.loads((DATA / f"longmemeval_{args.dataset}.json").read_text())
    if args.subset == "cycle1":
        # The exact selection behind the committed cycle-1 ablation
        # (runs/20260823-134319-cycle1-eval.md): first 20 single-session-user
        # + first 10 multi-session, dataset order preserved within each type.
        # Committed here so every future cycle measures the same questions.
        singles = [r for r in rows if r["question_type"] == "single-session-user"][:20]
        multis = [r for r in rows if r["question_type"] == "multi-session"][:10]
        rows = singles + multis
    else:
        rows = rows[max(args.start - 1, 0) : args.limit]

    run_dir = RUNS / time.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)

    # Appended per question: a failure 400 questions in must not discard the
    # 399 that already succeeded.
    results_path = run_dir / "results.jsonl"
    sink = results_path.open("w", buffering=1)

    pairs, records, failures = [], [], []
    for i, question in enumerate(rows, 1):
        # Each question owns its haystack. Leaving the previous question's
        # sessions in the profile would let retrieval pull evidence that this
        # question's memory never saw, which inflates the score meaninglessly.
        try:
            ids = ingest_question(question, run_dir / "sessions",
                                  chunk_size=args.chunk_size,
                                  chunk_stride=args.chunk_stride,
                                  facts=args.facts)
        except Exception as exc:
            failures.append({"question_id": question["question_id"],
                             "stage": "ingest", "error": str(exc)})
            print(f"[{i}/{len(rows)}] SKIP {question['question_id']}: {exc}",
                  flush=True)
            continue
        try:
            cands = search(question["question"], top_k=args.top_k,
                           with_bodies=not args.recall_only,
                           question_type=question["question_type"])
            # Agent tier retrieves THROUGH the fact→session link: fact hits
            # are rewritten to their parent session title before scoring, so
            # fact precision converts into session recall (cycle-2 lever).
            # Scored mode reads candidate bodies directly; expansion there is
            # a known gap (parent bodies would need refetch) — record-only.
            titles = (expand_facts_to_sessions(cands) if args.facts
                      else [c.title for c in cands])
            pairs.append((question, titles))

            record = {"question_id": question["question_id"],
                      "question_type": question["question_type"],
                      "retrieved": titles}

            if not args.recall_only:
                from judge import grade

                ctx = [{"title": c.title, "body": c.body} for c in cands]
                resp = answer(question, ctx)
                correct = grade(question["question"], question["answer"],
                                resp, question["question_type"],
                                question_id=question["question_id"])
                record |= {"response": resp, "correct": correct}
        finally:
            delete_nodes(ids)

        records.append(record)
        sink.write(json.dumps(record) + "\n")
        print(f"[{i}/{len(rows)}] {question['question_id']}", flush=True)

    sink.close()

    summary = {"dataset": args.dataset,
               "subset": args.subset,
               "tier": args.tier,
               "facts": args.facts,
               "chunk_size": args.chunk_size,
               "chunk_stride": args.chunk_stride,
               "top_k": args.top_k,
               "n_questions": len(records),
               "n_failed": len(failures),
               "failures": failures,
               "recall": recall_report(pairs)}
    if not args.recall_only:
        graded = [r for r in records if "correct" in r]
        summary["overall"] = sum(r["correct"] for r in graded) / len(graded)
        by_type: dict[str, list[bool]] = {}
        for r in graded:
            by_type.setdefault(r["question_type"], []).append(r["correct"])
        summary["by_type"] = {k: sum(v) / len(v) for k, v in by_type.items()}

    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
