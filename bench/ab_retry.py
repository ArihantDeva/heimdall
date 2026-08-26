"""Retry None rows from an A/B result at low concurrency (gateway flake recovery)."""
import concurrent.futures
import json
import sys
import time

import nous_scored


def _work(item: dict) -> dict:
    resp = nous_scored._reader(item)
    correct = nous_scored._grade(item, resp)
    return {"question_id": item["question_id"],
            "question_type": item["question_type"],
            "correct": correct, "response": resp}


def main() -> None:
    items = json.load(open("/tmp/ab_none_full.json"))
    out = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futs = {pool.submit(_work, it): it for it in items}
        for fut in concurrent.futures.as_completed(futs):
            try:
                out.append(fut.result())
            except Exception as e:
                it = futs[fut]
                out.append({"question_id": it["question_id"],
                            "question_type": it["question_type"],
                            "correct": None, "response": f"ERROR: {e}"})
    json.dump(out, open("/tmp/ab_none_retry.json", "w"), indent=1)
    ok = [x for x in out if x["correct"] is not None]
    print(f"retried {len(items)} -> {len(ok)} graded, {len(out)-len(ok)} still None")


if __name__ == "__main__":
    main()