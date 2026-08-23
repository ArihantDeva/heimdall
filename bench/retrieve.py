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
    keywords: list[str] | None = None  # fact nodes carry sid:<parent title>

    @property
    def rank(self) -> int:
        return rrf_rank_of(self.rrf)


def expand_facts_to_sessions(candidates: list[Candidate]) -> list[str]:
    """Cycle-2 lever (cycle-1 eval, finding 2): fact hits used to displace
    their parent session at deep k with no retrievable link back. Fact nodes
    now carry the exact parent title in a `sid:` keyword, so a fact hit is
    rewritten into that title — converting fact precision into session recall
    without crowding top-k. Non-fact rows and sid-less nodes pass through;
    duplicates collapse to the first position. Token-free: keyword arithmetic
    only."""
    out: list[str] = []
    for cand in candidates:
        parent = next((k[4:] for k in (cand.keywords or [])
                       if k.startswith("sid:")), None)
        out.append(parent if parent is not None else cand.title)
    seen: set[str] = set()
    deduped = [t for t in out if not (t in seen or seen.add(t))]
    return deduped


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

    # Session-level dedup: keep the best-ranked window per session title.
    # Overlapping chunk windows share a title and near-identical vectors, so
    # without this one session floods top-k and crowds out other evidence.
    seen: set[str] = set()

    candidates: list[Candidate] = []
    for row in results:
        if row["title"] in seen:
            continue
        seen.add(row["title"])
        cand = Candidate(
            id_hex=row["id_hex"],
            title=row["title"],
            rrf=row["score"],
            keywords=row.get("keywords") or [],
        )
        if with_bodies:
            # NOT `--markdown`: that emits raw markdown text, not JSON.
            body = _graft(["get", cand.id_hex], profile)
            cand.body = (body.get("result") or {}).get("body")
        candidates.append(cand)
    return candidates
