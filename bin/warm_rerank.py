"""Opt-in ranking of frozen warm hits; no retrieval or target-file reads.

The scorer client owns transport and strict v1 validation. This adapter only
hydrates existing cards, attaches evidence by input identity, and translates a
validated rank permutation into the legacy worker's sortable score field.
"""
from __future__ import annotations

import hashlib
import importlib.util
import math
import os
import pathlib
import threading
import time

MAX_WINDOW = 25
HERE = pathlib.Path(__file__).resolve().parent


class RankedHits(list):
    """JSON-list-compatible hits with request-local (not global) diagnostics."""
    def __init__(self, hits, rerank):
        super().__init__(hits)
        self.rerank = rerank


def _load_client():
    # Import by sibling path, also when query-server is loaded by importlib in a
    # fixture and bin/ is not on sys.path. No installed module/socket discovery.
    spec = importlib.util.spec_from_file_location("heimdall_candidate_scorer", HERE / "candidate_scorer.py")
    if spec is None or spec.loader is None:
        raise ImportError("scorer client unavailable")
    client = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client)
    return client


def _vector(hit, by_path):
    value = by_path.get(hit.get("path")) if by_path is not None else hit.get("s_vec")
    if value is None:
        return None, "not_observed"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, "invalid_semantic_signal"
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        return None, "nonfinite_semantic_signal"
    return value, None


def _scoring_text_sha256(title, body):
    """Fingerprint indexed text in memory, not a live file or ingest unit."""
    title_bytes = title.encode("utf-8")
    digest = hashlib.sha256(b"heimdall-scoring-text-v1\0")
    digest.update(len(title_bytes).to_bytes(8, "big"))
    digest.update(title_bytes)
    digest.update(body.encode("utf-8"))
    return digest.hexdigest()


def _card_status(path, title, body, sha1):
    if not isinstance(title, str) or not isinstance(body, str) or not isinstance(sha1, str):
        return "card_nonstring"
    if not sha1.strip():
        return "card_missing_sha1"
    if not body.strip():
        return "card_empty_body"
    if sha1.startswith(("name:", "dataless:")) or body.lstrip().startswith(("[minimal file]", "[dataless placeholder")):
        return "card_name_only"
    # Some older cards have no marker, only a bare filename. Never turn that
    # retrieval hint into a document, nor fall back to the worker's fake body.
    if body.strip() == pathlib.PurePath(path).name:
        return "card_name_only"
    try:
        title.encode("utf-8", "strict")
        body.encode("utf-8", "strict")
        sha1.encode("utf-8", "strict")
    except UnicodeError:
        return "card_invalid_utf8"
    return "ready"


def _hydrate(ei, hits):
    """One bound SELECT in one read transaction, through the existing EI conn.

    No EI.DB assumption, sqlite-vec import, target stat/open, path resolution,
    writes, title/body fallback, or document truncation is allowed here.
    """
    paths = [h.get("path") for h in hits]
    if any(not isinstance(p, str) for p in paths):
        return {}, "card_invalid_path"
    c = None
    cards, error = {}, None
    try:
        c = ei.conn()
        # Fail closed on a busy index instead of waiting behind a writer. This
        # is connection-local, not an index/config mutation.
        c.execute("PRAGMA busy_timeout=0")
        c.execute("BEGIN")
        marks = ",".join("?" for _ in paths)
        rows = c.execute(
            f"SELECT path, title, body, sha1 FROM cards WHERE path IN ({marks})", paths,
        ).fetchall()
        cards = {row[0]: row[1:] for row in rows}
    except Exception:
        # No query, path, body, SQL error, or OS exception text in diagnostics.
        cards, error = {}, "cards_unreadable"
    finally:
        if c is not None:
            try:
                c.close()  # rolls back the read transaction; nothing is written
            except Exception:
                cards, error = {}, "cards_unreadable"
    return cards, error


def _status(hits, window, status, reason, *, scored_count=0):
    return {
        "version": 1, "requested": True, "status": status, "reason": reason,
        "applied": status == "applied",
        "method": "cross_encoder" if status == "applied" else "original_order",
        "candidate_count": window, "scored_count": scored_count,
        "total_count": len(hits), "tail_count": len(hits) - window,
    }


def _annotated_hits(hits, s_vec_by_path):
    out = [dict(h) for h in hits]
    window = min(len(out), MAX_WINDOW)
    for i, h in enumerate(out, 1):
        vec, missing = _vector(h, s_vec_by_path)
        # The additive producer field is internal. Emit one explicit, finite-
        # or-null semantic signal instead of leaking an unchecked duplicate.
        h.pop("s_vec", None)
        h.update(
            retrieval_score=h.get("score"), retrieval_rank=i, rank=i,
            score_kind="retrieval", ranking_score=None,
            signals={
                "s_vec": vec,
                "s_vec_source": "semantic_cosine" if missing is None else "missing",
                "s_vec_missing_reason": missing,
                "s_lex": None, "s_lex_source": "title_trigram_jaccard",
                "s_lex_missing_reason": "scorer_not_observed" if i <= window else "outside_window",
                "s_ce": None, "ce_status": "not_scored",
                "document_bytes": None,
            },
            provenance={
                "document_source": None, "title_source": None,
                "card_sha1": None, "scoring_input_sha256": None,
                "card_status": "not_read" if i <= window else "outside_window",
            },
        )

    return out


def _rerank_inner(ei, query, hits, *, s_vec_by_path=None, deadline=None):
    """Return request-local annotated copies, preserving membership and tails.

    `deadline` is the enclosing search's absolute monotonic deadline (or None
    when that search ceiling is disabled). The client's entire I/O exchange is
    bounded by min(8s, remaining time). This does not cancel a backend model.
    """
    out = _annotated_hits(hits, s_vec_by_path)
    window = min(len(out), MAX_WINDOW)

    def finish(status, reason, scored_count=0):
        return RankedHits(out, _status(out, window, status, reason, scored_count=scored_count))

    if not window:
        return finish("empty", "no_candidates")
    if deadline is not None and deadline <= time.monotonic():
        return finish("deadline", "search_deadline")

    # The environment belongs to this worker, not to a query. A bad explicit
    # HEIMDALL path never triggers a probe/fallback to GRAFT or a default path.
    socket_path = (os.environ["HEIMDALL_RERANK_SOCKET"] if "HEIMDALL_RERANK_SOCKET" in os.environ
                   else os.environ.get("GRAFT_SOCKET"))
    if not socket_path or not os.path.isabs(socket_path):
        return finish("unavailable", "unconfigured_socket")

    cards, error = _hydrate(ei, out[:window])
    if error:
        for h in out[:window]:
            h["provenance"]["card_status"] = error
        return finish("unavailable", error)
    candidates = []
    errors = []
    for i, h in enumerate(out[:window], 1):
        card = cards.get(h.get("path"))
        if card is None:
            h["provenance"]["card_status"] = "card_missing"
            errors.append("card_missing")
            continue
        title, body, sha1 = card
        state = _card_status(h["path"], title, body, sha1)
        h["provenance"] = {
            "document_source": "cards.body", "title_source": "cards.title",
            "card_sha1": sha1 if isinstance(sha1, str) else None, "card_status": state,
            "scoring_input_sha256": _scoring_text_sha256(title, body) if state == "ready" else None,
        }
        if state != "ready":
            errors.append(state)
            continue
        h["signals"]["document_bytes"] = len(body.encode("utf-8"))
        candidates.append({
            "id": f"warm:{i}", "title": title, "document": body,
            "s_vec": h["signals"]["s_vec"],
        })
    if errors:
        # No partial window is sent: one unusable document keeps ALL original
        # ranks, while each hit says which indexed evidence was/wasn't usable.
        return finish("unavailable", errors[0])

    timeout_s = 8.0 if deadline is None else min(8.0, deadline - time.monotonic())
    if timeout_s <= 0:
        return finish("deadline", "search_deadline")
    try:
        client = _load_client()
    except Exception:
        return finish("unavailable", "scorer_client_unavailable")
    # Loading the stdlib-only client also uses part of the remaining budget.
    if deadline is not None:
        timeout_s = min(timeout_s, deadline - time.monotonic())
        if timeout_s <= 0:
            return finish("deadline", "search_deadline")
    try:
        result = client.score_candidates(query, candidates, socket_path,
                                         timeout_s=timeout_s, deadline=deadline)
    except client.ScorerError as e:
        status = "deadline" if e.code == "deadline" else (
            "unavailable" if e.code in ("transport", "unconfigured_socket") else "failed")
        return finish(status, e.code)
    except Exception:
        return finish("failed", "scorer_error")

    # The client validates INPUT-order identities, completeness, finite-or-nil
    # signals, and the CE-primary/stable-tie rank permutation before returning.
    for h, row in zip(out[:window], result["results"]):
        h["rank"] = row["rank"]
        h["ranking_score"] = row["s_ce"]
        h["signals"].update(
            s_lex=row["s_lex"], s_ce=row["s_ce"], ce_status=row["ce_status"],
            s_lex_missing_reason=None if row["s_lex"] is not None else "not_observed",
            document_bytes=row["document_bytes"],
        )
    if result["applied"]:
        ranked = sorted(out[:window], key=lambda h: h["rank"])
        # Tails keep their exact old score. Offset the ordinal keys above those
        # untouched scores so a downstream generic score sort cannot promote a
        # tail ahead of this window (n can exceed the number of available hits).
        tail_max = max((h["score"] for h in out[window:]), default=0)
        base = max(0, math.ceil(tail_max))
        for h in ranked:
            h["score"] = float(base + window - h["rank"] + 1)
            h["score_kind"] = "order_key"
        out[:window] = ranked
    return finish(result["status"], result["reason"], result["scored_count"])


def rerank_hits(ei, query, hits, *, s_vec_by_path=None, deadline=None):
    """Bound the ENTIRE optional stage, including card I/O and client import.

    SQLite/file reads cannot be preempted. A daemon thread may finish cleanup
    later, but it checks the same absolute deadline before scorer I/O. Timeout
    returns a separate original-order snapshot, never partial inferred evidence.
    """
    now = time.monotonic()
    stop_at = now + 8.0 if deadline is None else min(deadline, now + 8.0)
    remaining = stop_at - time.monotonic()

    def fallback(status, reason):
        out = _annotated_hits(hits, s_vec_by_path)
        window = min(len(out), MAX_WINDOW)
        for h in out[:window]:
            h["provenance"]["card_status"] = "unobserved"
        return RankedHits(out, _status(out, window, status, reason))

    if not hits:
        out = _annotated_hits(hits, s_vec_by_path)
        return RankedHits(out, _status(out, 0, "empty", "no_candidates"))
    if remaining <= 0:
        return fallback("deadline", "search_deadline")
    box = {}

    def run():
        try:
            if time.monotonic() >= stop_at:
                box["result"] = fallback("deadline", "deadline")
                return
            box["result"] = _rerank_inner(ei, query, hits,
                s_vec_by_path=s_vec_by_path, deadline=stop_at)
        except BaseException:
            box["error"] = True

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(max(0.0, stop_at - time.monotonic()))
    if worker.is_alive():
        return fallback("deadline", "deadline")
    if "error" in box or "result" not in box:
        return fallback("failed", "rerank_adapter_error")
    return box["result"]
