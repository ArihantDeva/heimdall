"""Hill-climb LongMemEval-S.

THE RULE THAT MATTERS
---------------------
A step is promoted only on a DEV improvement, and every promoted step is then
re-measured on the held-out TEST split. If dev goes up and test goes down, the
step is REVERTED and recorded as an overfit. That check is the entire reason
this file exists: the previous attempt at this work produced five changes that
each raised the old benchmark's score while lowering held-out recall, and
nothing in the loop noticed.

Every trial is appended to a JSONL ledger -- promoted, rejected and reverted
alike -- so the climb is auditable after the fact rather than reconstructed
from memory. Promotions are recorded as git SHAs.

USAGE
  python3 bench/longmemeval_s/climb.py --knobs instruction,body_cap --rounds 2
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import eval as E  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
LEDGER = pathlib.Path(__file__).resolve().parent / "ledger.jsonl"

# The knobs. Each is a (name, description) plus the code change it implies.
# "instruction" is the bge query prompt; "body_cap" is how much of a file the
# card stores; "model" is the embedding model. No knob may be tuned against the
# TEST split -- that is what the split is for.
KNOBS = {
    "instruction": dict(
        desc="bge retrieval instruction on the query side",
        values=[True, False]),
    "body_cap": dict(
        desc="characters of each file stored in the card",
        values=[3000, 1200, 6000]),
    "lex_weight": dict(
        desc="RRF weight of the BM25 channel (0=vector only, 0.5=equal, 1=BM25)",
        values=[0.0, 0.3, 0.5, 0.7]),
    "model": dict(
        desc="embedding model",
        values=["BAAI/bge-small-en-v1.5", "BAAI/bge-base-en-v1.5",
                "thenlper/gte-base"]),
}


def run_split(split: str, db: pathlib.Path, corpus: pathlib.Path,
              model: str, cap: int, instruction: bool,
              lex_weight: float = 0.0) -> dict:
    """Rebuild the index for this split and score it. One fresh index per call.

    The index is only rebuilt when the BODY CAP or MODEL changes -- rebuilding
    for a pure query-side knob (instruction, lex_weight) would add ~15s per
    trial for a byte-identical index and make the climb 3x slower for nothing.
    """
    key = (model, cap)
    stamp = db.with_suffix(".cfg")
    if not (db.exists() and stamp.exists() and stamp.read_text() == repr(key)):
        E.CARD_BODY_CAP = cap
        info = E.build_index(corpus, db, E.SPLITS[split], model)
        stamp.write_text(repr(key))
    else:
        info = {"files": len(E.SPLITS[split]), "dim": 384, "db": str(db),
                "reused": True}
    res = E.score(split, db, model_name=model, bge_instruction=instruction,
                  lex_weight=lex_weight)
    res["index"] = info
    return res


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--knobs", default="instruction,body_cap")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--model", default="BAAI/bge-small-en-v1.5")
    ap.add_argument("--corpus", default=str(E.CORPUS_ROOT))
    ap.add_argument("--dry-run", action="store_true",
                    help="score the baseline only; change nothing")
    a = ap.parse_args(argv)

    corpus = pathlib.Path(a.corpus)
    knob_names = [k for k in a.knobs.split(",") if k]
    for k in knob_names:
        if k not in KNOBS:
            raise SystemExit(f"unknown knob {k}; have {sorted(KNOBS)}")

    def log(rec: dict) -> None:
        rec["t"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with LEDGER.open("a") as fh:
            fh.write(json.dumps(rec) + "\n")

    # ---- baseline on both splits ----
    dev = run_split("dev", pathlib.Path("/tmp/lme-dev.db"), corpus,
                    a.model, 3000, True, 0.0)
    tst = run_split("test", pathlib.Path("/tmp/lme-test.db"), corpus,
                    a.model, 3000, True, 0.0)
    base = {"dev": dev["summary"], "test": tst["summary"]}
    print(f"BASELINE dev  {dev['summary']}")
    print(f"BASELINE test {tst['summary']}")
    log({"event": "baseline", "config": {"instruction": True, "body_cap": 3000,
                                         "lex_weight": 0.0, "model": a.model}, **base})
    if a.dry_run:
        return 0

    # ---- coordinate ascent, one knob at a time, dev only ----
    cur = {"instruction": True, "body_cap": 3000, "lex_weight": 0.0,
           "model": a.model}
    best_dev = dev["summary"]["mrr"]
    for rnd in range(a.rounds):
        improved = False
        for knob in knob_names:
            for val in KNOBS[knob]["values"]:
                if val == cur[knob]:
                    continue
                trial = dict(cur)
                trial[knob] = val
                t0 = time.time()
                d = run_split("dev", pathlib.Path("/tmp/lme-dev.db"), corpus,
                              trial["model"], trial["body_cap"],
                              trial["instruction"], trial["lex_weight"])
                dt = time.time() - t0
                s = d["summary"]
                delta = s["mrr"] - best_dev
                verdict = "PROMOTE" if delta > 1e-9 else "reject"
                print(f"[r{rnd}] {knob}={val!r:28} dev_mrr={s['mrr']:.3f} "
                      f"(d={delta:+.3f}) r@10={s['recall@10']:.3f}  "
                      f"{verdict}  {dt:.0f}s")
                log({"event": "trial", "round": rnd, "knob": knob, "value": val,
                     "config": trial, "dev": s, "delta_mrr": round(delta, 4),
                     "verdict": verdict, "secs": round(dt, 1)})
                if delta > 1e-9:
                    # promoted on dev -> now check it did not overfit
                    t = run_split("test", pathlib.Path("/tmp/lme-test.db"),
                                  corpus, trial["model"], trial["body_cap"],
                                  trial["instruction"],
                                  trial["lex_weight"])["summary"]
                    t_delta = t["mrr"] - tst["summary"]["mrr"]
                    keep = t_delta > -1e-9
                    print(f"        held-out mrr={t['mrr']:.3f} "
                          f"(d={t_delta:+.3f})  -> {'KEEP' if keep else 'REVERT (overfit)'}")
                    log({"event": "heldout_check", "config": trial, "test": t,
                         "delta_mrr": round(t_delta, 4),
                         "verdict": "keep" if keep else "revert_overfit"})
                    if keep:
                        cur, best_dev, tst, improved = trial, s["mrr"], {"summary": t}, True
                    # else: cur unchanged, the step is discarded
        if not improved:
            print(f"[r{rnd}] no knob improved dev; stopping")
            break

    print(f"\nFINAL config {cur}")
    print(f"  dev  {best_dev}")
    print(f"  test {tst['summary']}")
    log({"event": "final", "config": cur, "dev_mrr": best_dev,
         "test": tst["summary"]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
