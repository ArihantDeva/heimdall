#!/usr/bin/env python3
"""No-regression gate: compare the newest run of a tier against the best
prior recorded score for that tier. Exit 1 on any regression > tolerance.

Usage:
  python3 bench/regression_gate.py --current <run_dir> [--baseline <run_dir>]
  python3 bench/regression_gate.py --gate-all   # newest vs best prior, both tiers
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
RUNS = HERE / "runs"
KS = ("1", "5", "10", "25")
TOLERANCE = 0.0  # zero-regression mandate: any drop fails


def load_summaries() -> list[dict]:
    out = []
    for d in sorted(RUNS.iterdir()):
        s = d / "summary.json"
        if s.exists():
            rec = json.loads(s.read_text())
            rec["_dir"] = d.name
            out.append(rec)
    return out


def recall_pairs(summary: dict) -> dict[tuple[str, str], float]:
    flat = {}
    for qtype, per_k in (summary.get("recall") or {}).items():
        for k in KS:
            v = per_k.get(k)
            if v is not None and v == v:  # NaN guard
                flat[(qtype, k)] = float(v)
    return flat


def compare(current: dict, baseline: dict) -> list[str]:
    cur, base = recall_pairs(current), recall_pairs(baseline)
    drops = []
    shared = set(cur) & set(base)
    if not shared:
        return [f"no comparable recall cells between {current.get('_dir')} "
                f"and {baseline.get('_dir')}"]
    for cell in sorted(shared):
        delta = cur[cell] - base[cell]
        if delta < TOLERANCE:
            drops.append(f"REGRESSION {cell[0]}@{cell[1]}: "
                         f"{base[cell]:.3f} -> {cur[cell]:.3f} ({delta:+.3f})")
    return drops


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--current")
    ap.add_argument("--baseline")
    ap.add_argument("--tier", default=None, help="cpu|agent filter for --gate-all")
    args = ap.parse_args()

    summaries = load_summaries()
    if args.current and args.baseline:
        cur = next((s for s in summaries if s["_dir"] == args.current), None)
        base = next((s for s in summaries if s["_dir"] == args.baseline), None)
        if not cur or not base:
            print("run dir(s) not found", file=sys.stderr)
            return 2
        drops = compare(cur, base)
    else:
        tier = args.tier
        runs = [s for s in summaries
                if tier is None or s.get("tier") == tier]
        if len(runs) < 2:
            print(f"fewer than two recorded runs for tier={tier}; "
                  "nothing to gate yet — record more runs first")
            return 0
        current, priors = runs[-1], runs[:-1]
        # best prior = max mean recall over shared cells per prior run; gate vs
        # each prior that shares cells, fail if ANY prior beats current anywhere
        all_drops = []
        for p in priors:
            all_drops += compare(current, p)
        drops = all_drops

    if drops:
        print("\n".join(drops))
        return 1
    print("no regression: current run matches or beats all baselines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
