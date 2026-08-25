"""Scored S-score pass over an EXISTING recall run.

Reconstructs per-question contexts from the materialized session files the
recall run already wrote (bench/runs/<run>/sessions/<qid>/session_*.md), so
nothing is re-ingested. Then:

  1. reader  — claude -p (sonnet) answers from the retrieved context
  2. judge   — free-fleet LLM (chain/ox-alpha) grades answer vs gold

The judge runs as N parallel workers via the pi `subagent` tool; each worker
reads a slice file of scored inputs and writes its graded slice back. This
script's `reconstruct` + `reader` phases are self-contained python; the
`judge_fanout` phase hands slice files to the orchestrator.

Usage:
  python3 bench/scored_run.py reconstruct --run 20260824-221606
  python3 bench/scored_run.py reader --run 20260824-221606 --workers 8
  python3 bench/scored_run.py slices --run 20260824-221606 --judges 10
  python3 bench/scored_run.py merge --run 20260824-221606
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
RUNS = HERE / "runs"
DATA = HERE / "data"


def _session_index(title: str) -> str | None:
    m = re.match(r"session (\S+) —", title)
    return m.group(1) if m else None


def reconstruct(run_id: str) -> list[dict]:
    """Build scored inputs: per question, the retrieved contexts + gold."""
    run_dir = RUNS / run_id
    rows = [json.loads(l) for l in
            (run_dir / "results.jsonl").read_text().splitlines() if l.strip()]
    dataset_rows = {r["question_id"]: r for r in
                    json.loads((DATA / "longmemeval_s.json").read_text())}
    sessions_root = run_dir / "sessions"

    out = []
    for row in rows:
        qid = row["question_id"]
        q = dataset_rows.get(qid)
        if not q:
            continue
        # map session file by index: title → session id → file
        qdir = sessions_root / qid
        files = sorted(qdir.glob("session_*.md")) if qdir.exists() else []
        idx_of = {}
        for f in files:
            m = re.match(r"session_(\d+)_\d+\.md", f.name)
            if m:
                idx_of.setdefault(int(m.group(1)), f)
        context = []
        for title in row["retrieved"]:
            sid = _session_index(title)
            # find the session file whose embedded title matches this sid
            for idx, f in idx_of.items():
                head = f.read_text(encoding="utf-8").splitlines()[:8]
                if any(sid and sid in ln for ln in head):
                    context.append({"title": title, "body": f.read_text(encoding="utf-8")})
                    break
        out.append({
            "question_id": qid,
            "question_type": row["question_type"],
            "question": q["question"],
            "answer": q.get("answer", ""),
            "question_date": q.get("question_date", ""),
            "context": context,
        })
    return out


def _reader_one(item: dict, model: str) -> str:
    from reader import build_prompt, complete  # bench/reader.py
    prompt = build_prompt(item["question"], item["context"],
                          item["question_date"])
    try:
        return complete(prompt, model=model)
    except Exception:
        return "NO_ANSWER"


def reader_phase(run_id: str, workers: int, model: str) -> None:
    items = reconstruct(run_id)
    out_dir = RUNS / run_id / "scored"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "inputs.json").write_text(
        json.dumps(items, indent=1), encoding="utf-8")
    print(f"reconstructed {len(items)} scored inputs → {out_dir / 'inputs.json'}")
    if workers:
        import concurrent.futures
        def work(item):
            return {**item, "response": _reader_one(item, model)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(work, items))
        (out_dir / "answered.json").write_text(
            json.dumps(results, indent=1), encoding="utf-8")
        print(f"reader done: {len(results)} answers")


def slices_phase(run_id: str, judges: int) -> None:
    out_dir = RUNS / run_id / "scored"
    answered = json.loads((out_dir / "answered.json").read_text())
    per = (len(answered) + judges - 1) // judges
    out_dir.mkdir(exist_ok=True)
    for i in range(judges):
        chunk = answered[i * per:(i + 1) * per]
        if chunk:
            (out_dir / f"judge_slice_{i}.json").write_text(
                json.dumps(chunk, indent=1), encoding="utf-8")
    print(f"wrote {judges} judge slices → {out_dir}/judge_slice_*.json")


def merge_phase(run_id: str) -> None:
    out_dir = RUNS / run_id / "scored"
    graded = []
    for f in sorted(out_dir.glob("graded_slice_*.json")):
        graded.extend(json.loads(f.read_text()))
    if not graded:
        print("no graded slices yet")
        return
    by_type = {}
    for g in graded:
        by_type.setdefault(g["question_type"], []).append(g["correct"])
    overall = sum(g["correct"] for g in graded) / len(graded)
    summary = {
        "run": run_id,
        "n": len(graded),
        "overall": overall,
        "by_type": {k: sum(v) / len(v) for k, v in by_type.items()},
    }
    (out_dir / "s_score.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("reconstruct")
    p.add_argument("--run", required=True)
    p = sub.add_parser("reader")
    p.add_argument("--run", required=True)
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--model", default="sonnet")
    p = sub.add_parser("slices")
    p.add_argument("--run", required=True)
    p.add_argument("--judges", type=int, default=10)
    p = sub.add_parser("merge")
    p.add_argument("--run", required=True)
    args = ap.parse_args()

    if args.cmd == "reconstruct":
        items = reconstruct(args.run)
        print(f"{len(items)} questions")
    elif args.cmd == "reader":
        reader_phase(args.run, args.workers, args.model)
    elif args.cmd == "slices":
        slices_phase(args.run, args.judges)
    elif args.cmd == "merge":
        merge_phase(args.run)


if __name__ == "__main__":
    main()
