"""Empty the isolated benchmark profile.

An interrupted run leaves nodes behind (SIGTERM skips per-question cleanup),
and those strays are distractors that depress every later run's recall. This
exists because deleting by marker-keyword retrieval does not converge: graft
caps a retrieve at its configured top_k, so a large leak needs many passes and
still misses nodes the query does not rank.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

from ingest import BENCH_MARKER, GRAFT, profile_node_count


def _graft(args: list[str], profile: str) -> str:
    return subprocess.run([str(GRAFT), *args], capture_output=True, text=True,
                          env=dict(os.environ, GRAFT_PROFILE=profile)).stdout


def purge(profile: str = "longmemeval", max_passes: int = 200) -> int:
    if profile == "default":
        raise RuntimeError("refusing to purge the default profile")
    for _ in range(max_passes):
        if profile_node_count(profile) == 0:
            return 0
        out = _graft(["retrieve", BENCH_MARKER, "--top-k", "500"], profile)
        if not out.strip():
            break
        ids = [r["id_hex"] for r in json.loads(out)["result"]["results"]]
        if not ids:
            break
        for id_hex in ids:
            _graft(["delete", id_hex], profile)
    return profile_node_count(profile)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="longmemeval")
    args = ap.parse_args()

    remaining = purge(args.profile)
    print(f"{args.profile}: {remaining} nodes remaining")
    if remaining:
        print("Retrieval-based purge did not converge. The profile db must be "
              "recreated: stop graftd, delete "
              f"~/.graft/profiles/{args.profile}/graft.db*, restart.",
              file=sys.stderr)
    sys.exit(1 if remaining else 0)
