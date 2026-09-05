"""A/B harness (M-002): run the frozen 60-question oracle sample through the
current reader+judge and report per-type accuracy. Every reader/judge lever
(M-003/4/5) is A/B'd against the 0.814 baseline recorded at M-001.

Usage:
  python3 bench/ab_oracle.py --out /tmp/ab.json [--workers 4]
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import pathlib
import time

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE / "tests" / "fixtures"

import nous_scored  # noqa: E402  (bench-local import)


def _work(item: dict) -> dict:
    resp = nous_scored._reader(item)
    correct = nous_scored._grade(item, resp)
    return {"question_id": item["question_id"],
            "question_type": item["question_type"],
            "correct": correct, "response": resp}


def run(sample: list[dict], workers: int, out_path: str | None = None) -> list[dict]:
    """Run reader+judge over the sample. When out_path is set, write each
    completed result immediately (incremental) so a slow/throttled run is
    monitorable and resumable."""
    out: list[dict] = []
    seen: set[str] = set()
    if out_path:
        import pathlib as _pl
        _p = _pl.Path(out_path)
        if _p.exists():
            try:
                for r in json.loads(_p.read_text()):
                    out.append(r); seen.add(r["question_id"])
            except Exception:
                out, seen = [], set()
    todo = [it for it in sample if it["question_id"] not in seen]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_work, it): it for it in todo}
        for fut in concurrent.futures.as_completed(futs):
            try:
                out.append(fut.result())
            except Exception as e:  # gateway flake -> mark None, retry on demand
                it = futs[fut]
                out.append({"question_id": it["question_id"],
                            "question_type": it["question_type"],
                            "correct": None, "response": f"ERROR: {e}"})
            if out_path:
                json.dump(out, open(out_path, "w"), indent=1)
                import time as _t
                graded = [r for r in out if r["correct"] is not None]
                print(f"  {len(graded)}/{len(sample)} graded",
                      f"({_t.strftime('%H:%M:%S')})", flush=True)
    return out


def report(results: list[dict]) -> dict:
    graded = [r for r in results if r["correct"] is not None]
    overall = sum(r["correct"] for r in graded) / len(graded)
    by_type: dict[str, list[bool]] = {}
    for r in graded:
        by_type.setdefault(r["question_type"], []).append(r["correct"])
    return {"n": len(graded),
            "errors": len(results) - len(graded),
            "overall": overall,
            "by_type": {k: sum(v) / len(v) for k, v in by_type.items()}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--out", default="/tmp/ab.json")
    args = ap.parse_args()
    sample = json.loads((FIXTURES / "oracle_sample_60.json").read_text())
    t0 = time.time()
    results = run(sample, args.workers, args.out)
    json.dump(results, open(args.out, "w"), indent=1)
    print(json.dumps(report(results), indent=2))
    print(f"wrote {args.out} in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()