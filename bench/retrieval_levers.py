"""Cannibalized from omega-memory (github.com/omega-memory/omega-memory,
scripts/longmemeval_official.py): `_expand_query` (temporal/entity/counting
query expansion) and `_boost_recency` (recency-boost for knowledge-update).

Kept: CPU-only (regex/heuristic, no LLM at retrieval), graft-compatible
(dates parsed from session titles), question-type-aware (recency only fires
on knowledge-update). Dropped: omega's SQLiteStore, reranker, compression.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

# ---- query expansion (omega _expand_query) ---------------------------------

_COMMON = {
    "I", "The", "A", "An", "My", "What", "When", "Where", "Who", "How",
    "Which", "Why", "Do", "Does", "Did", "Is", "Are", "Was", "Were",
    "Have", "Has", "Had", "Can", "Could", "Would", "Should", "Will",
    "If", "In", "On", "At", "To", "For", "Of", "And", "Or", "But",
    "Not", "That", "This", "It", "He", "She", "They", "We", "You",
    "Please", "Tell", "Me", "About",
}

_WORD_TO_NUM = {
    "one": 1, "a": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "twenty": 20, "thirty": 30,
}

_DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
              "Saturday", "Sunday"]


def _resolve_relative_dates(query: str, anchor: datetime) -> list[str]:
    """Resolve relative time refs (yesterday, last week, N days ago) to
    absolute date keywords so lexical match can hit session titles."""
    q_lower = query.lower()
    resolved = []
    _DAY_MAP = {d: i for i, d in enumerate(_DAY_NAMES)}

    m = re.search(r"last\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)",
                  query, re.IGNORECASE)
    if m:
        day_name = m.group(1).capitalize()
        days_back = (anchor.weekday() - _DAY_MAP[day_name]) % 7 or 7
        targ = anchor - timedelta(days=days_back)
        resolved.append(f"{day_name} {targ.strftime('%Y-%m-%d')} "
                        f"{targ.strftime('%B %d')}")

    if "last weekend" in q_lower:
        sat = anchor - timedelta(days=(anchor.weekday() + 2) % 7 or 7)
        sun = sat + timedelta(days=1)
        resolved.append(f"Saturday Sunday {sat.strftime('%Y-%m-%d')} "
                        f"{sun.strftime('%Y-%m-%d')}")

    if "yesterday" in q_lower:
        yest = anchor - timedelta(days=1)
        resolved.append(f"{yest.strftime('%Y-%m-%d')} {yest.strftime('%B %d')}")

    if "last week" in q_lower and "weekend" not in q_lower:
        start = anchor - timedelta(days=anchor.weekday() + 7)
        end = start + timedelta(days=6)
        resolved.append(f"{start.strftime('%Y-%m-%d')} {end.strftime('%Y-%m-%d')}")

    m = re.search(r"(\d+|[a-z]+)\s+(day|week|month|year)s?\s+ago",
                  query, re.IGNORECASE)
    if m:
        raw_n = m.group(1).lower()
        n = int(raw_n) if raw_n.isdigit() else _WORD_TO_NUM.get(raw_n)
        if n is not None:
            unit = m.group(2).lower()
            delta = {"day": timedelta(days=n), "week": timedelta(weeks=n),
                     "month": timedelta(days=n * 30),
                     "year": timedelta(days=n * 365)}.get(unit)
            if delta:
                center = anchor - delta
                resolved.append(f"{center.strftime('%Y-%m-%d')} "
                                f"{center.strftime('%B')} {center.strftime('%d')}")

    m = re.search(r"(?:last|past|previous)\s+(\d+|[a-z]+)\s+"
                  r"(day|week|month|year)s?\b", query, re.IGNORECASE)
    if m:
        raw_n = m.group(1).lower()
        n = int(raw_n) if raw_n.isdigit() else _WORD_TO_NUM.get(raw_n)
        if n is not None:
            unit = m.group(2).lower()
            delta = {"day": timedelta(days=n), "week": timedelta(weeks=n),
                     "month": timedelta(days=n * 30),
                     "year": timedelta(days=n * 365)}.get(unit)
            if delta:
                start = anchor - delta
                resolved.append(f"{start.strftime('%Y-%m-%d')} "
                                f"{(start + timedelta(days=7)).strftime('%Y-%m-%d')}")
    return resolved


def expand_query(query: str, question_date: str | None = None) -> str:
    """Omega's _expand_query: counting cues + temporal resolution + entity
    extraction. Pure regex, no LLM. Returns query + expansions."""
    expansions = []

    q_lower = query.lower()
    if any(sig in q_lower for sig in ("how many", "how much", "how often",
                                      "total number", "count")):
        expansions.append("every instance all occurrences each time")

    if question_date:
        cleaned = re.sub(r"\s*\([A-Za-z]+\)\s*", " ", question_date).strip()
        anchor = None
        for fmt in ("%Y/%m/%d %H:%M", "%Y/%m/%d"):
            try:
                anchor = datetime.strptime(cleaned, fmt)
                break
            except ValueError:
                pass
        if anchor:
            expansions.extend(_resolve_relative_dates(query, anchor))

    words = re.findall(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b", query)
    entities = [w for w in words if w not in _COMMON and len(w) > 1]
    if entities:
        expansions.append(" ".join(entities))

    if not expansions:
        return query
    return query + " " + " ".join(expansions)


# ---- recency boost (omega _boost_recency) ----------------------------------

_TITLE_DATE = re.compile(r"(\d{4}/\d{2}/\d{2})")


def _title_date(title: str) -> datetime | None:
    m = _TITLE_DATE.search(title)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y/%m/%d")
    except ValueError:
        return None


def boost_recency(candidates: list, question_type: str) -> list:
    """Boost newer sessions for knowledge-update questions (omega's
    _boost_recency): dates parsed from graft titles, factor 1.0 (oldest) to
    1.5 (newest). Mutates candidates' rrf in place, re-sorts desc."""
    if question_type != "knowledge-update" or not candidates:
        return candidates

    dated = [(c, _title_date(c.title)) for c in candidates]
    dates = [d for _, d in dated if d]
    if len(dates) < 2:
        return candidates

    earliest = min(dates)
    latest = max(dates)
    span = (latest - earliest).total_seconds()
    if span <= 0:
        return candidates

    for cand, d in dated:
        if d is None:
            continue
        frac = (d - earliest).total_seconds() / span
        cand.rrf = (cand.rrf or 0) * (1.0 + 0.5 * frac)

    candidates.sort(key=lambda c: c.rrf or 0, reverse=True)
    return candidates
