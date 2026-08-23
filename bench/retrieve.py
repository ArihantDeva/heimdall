"""Retrieval client that preserves calibrated relevance signals.

`graft retrieve` returns only RRF rank scores, 1/(60+rank) — no relevance
magnitude, so no abstention threshold is possible from it (finding F1).
`graft query` exposes s_vec / s_lex / s_jaccard / s_ce but only for the single
top hit (F2). This module fuses both: ranked candidates from `retrieve`,
bodies from `get`, and calibrated signals where available.
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
from dataclasses import dataclass

GRAFT = pathlib.Path.home() / ".local/bin/graft"
RRF_K = 60  # retrieval.rrf_k_const in ~/.graft/config.yaml


@dataclass
class Candidate:
    id_hex: str
    title: str
    rrf: float
    s_vec: float | None = None
    s_lex: float | None = None
    s_ce: float | None = None
    body: str | None = None

    @property
    def rank(self) -> int:
        return rrf_rank_of(self.rrf)


def rrf_rank_of(score: float, k: int = RRF_K) -> int:
    """Invert 1/(k+rank) back to rank. Exact for graft's emitted scores."""
    if score <= 0:
        raise ValueError(f"non-positive RRF score: {score}")
    return round(1.0 / score) - k


def _graft(args: list[str], profile: str) -> dict:
    out = subprocess.run(
        [str(GRAFT), *args],
        capture_output=True, text=True,
        env=dict(os.environ, GRAFT_PROFILE=profile),
    )
    if not out.stdout.strip():
        raise RuntimeError(f"graft {args[0]} returned nothing: {out.stderr}")
    return json.loads(out.stdout)


def search(query: str, top_k: int = 25, profile: str = "longmemeval",
           with_bodies: bool = True) -> list[Candidate]:
    payload = _graft(["retrieve", query, "--top-k", str(top_k)], profile)
    results = payload["result"]["results"]

    candidates: list[Candidate] = []
    for row in results:
        cand = Candidate(
            id_hex=row["id_hex"],
            title=row["title"],
            rrf=row["score"],
        )
        if with_bodies:
            # NOT `--markdown`: that emits raw markdown text, not JSON.
            body = _graft(["get", cand.id_hex], profile)
            cand.body = (body.get("result") or {}).get("body")
        candidates.append(cand)
    return candidates
