"""Bounded client for Graft's compute-only score_candidates operation.

Only JSON-shaped MessagePack values are supported. No msgpack dependency, model,
retrieval, daemon spawn, file-content read, or fallback to a different socket.
Scores are relevance features, not calibrated probabilities or trust verdicts.
"""
from __future__ import annotations

import math
import os
import socket
import struct
import time

MAX_CANDIDATES = 25
MAX_REQUEST = 4 * 1024 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_ITEMS = 4096
MAX_DEPTH = 24


class ScorerError(RuntimeError):
    """A safe diagnostic code; never contains query/document contents."""
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _float32(value):
    try:
        out = struct.unpack(">f", struct.pack(">f", value))[0]
    except (OverflowError, struct.error) as e:
        raise ScorerError("invalid_vector_score") from e
    if not math.isfinite(out):
        raise ScorerError("invalid_vector_score")
    return out


def _string(value, limit, *, nonblank=False):
    if not isinstance(value, str) or len(value) > limit or "\0" in value:
        return False
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError:
        return False
    return size <= limit and (not nonblank or bool(value.strip()))


def _pack(value, depth=0):
    if depth > MAX_DEPTH:
        raise ScorerError("request_depth")
    if value is None:
        return b"\xc0"
    if value is False:
        return b"\xc2"
    if value is True:
        return b"\xc3"
    if isinstance(value, int):
        if 0 <= value <= 127:
            return bytes([value])
        if -32 <= value < 0:
            return bytes([value & 255])
        if 0 <= value <= 255:
            return b"\xcc" + struct.pack(">B", value)
        if 0 <= value <= 65535:
            return b"\xcd" + struct.pack(">H", value)
        if 0 <= value <= 2 ** 32 - 1:
            return b"\xce" + struct.pack(">I", value)
        if 0 <= value <= 2 ** 64 - 1:
            return b"\xcf" + struct.pack(">Q", value)
        if -(2 ** 63) <= value < 0:
            return b"\xd3" + struct.pack(">q", value)
        raise ScorerError("request_integer")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ScorerError("request_nonfinite")
        return b"\xcb" + struct.pack(">d", value)
    if isinstance(value, str):
        try:
            data = value.encode("utf-8")
        except UnicodeError as e:
            raise ScorerError("request_utf8") from e
        n = len(data)
        if n <= 31:
            head = bytes([0xa0 | n])
        elif n <= 255:
            head = b"\xd9" + bytes([n])
        elif n <= 65535:
            head = b"\xda" + struct.pack(">H", n)
        else:
            head = b"\xdb" + struct.pack(">I", n)
        return head + data
    if isinstance(value, list):
        n = len(value)
        head = bytes([0x90 | n]) if n <= 15 else b"\xdc" + struct.pack(">H", n)
        return head + b"".join(_pack(v, depth + 1) for v in value)
    if isinstance(value, dict):
        n = len(value)
        head = bytes([0x80 | n]) if n <= 15 else b"\xde" + struct.pack(">H", n)
        if any(not isinstance(k, str) for k in value):
            raise ScorerError("request_key")
        return head + b"".join(_pack(k, depth + 1) + _pack(v, depth + 1) for k, v in value.items())
    raise ScorerError("request_type")


class _Decoder:
    def __init__(self, data):
        if len(data) > MAX_RESPONSE:
            raise ScorerError("response_size")
        self.data = data
        self.offset = 0
        self.items = 0

    def take(self, n):
        if n < 0 or n > len(self.data) - self.offset:
            raise ScorerError("response_truncated")
        out = self.data[self.offset:self.offset + n]
        self.offset += n
        return out

    def integer(self, fmt):
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]

    def value(self, depth=0):
        self.items += 1
        if depth > MAX_DEPTH or self.items > MAX_ITEMS:
            raise ScorerError("response_complexity")
        tag = self.integer(">B")
        if tag <= 0x7f:
            return tag
        if tag >= 0xe0:
            return tag - 256
        if 0xa0 <= tag <= 0xbf:
            return self.text(tag & 31)
        if 0x90 <= tag <= 0x9f:
            return self.array(tag & 15, depth)
        if 0x80 <= tag <= 0x8f:
            return self.mapping(tag & 15, depth)
        if tag == 0xc0:
            return None
        if tag in (0xc2, 0xc3):
            return tag == 0xc3
        formats = {0xcc: ">B", 0xcd: ">H", 0xce: ">I", 0xcf: ">Q",
                   0xd0: ">b", 0xd1: ">h", 0xd2: ">i", 0xd3: ">q"}
        if tag in formats:
            return self.integer(formats[tag])
        if tag in (0xca, 0xcb):
            value = self.integer(">f" if tag == 0xca else ">d")
            if not math.isfinite(value):
                raise ScorerError("response_nonfinite")
            return value
        if tag in (0xd9, 0xda, 0xdb):
            return self.text(self.integer({0xd9: ">B", 0xda: ">H", 0xdb: ">I"}[tag]))
        if tag in (0xdc, 0xdd):
            return self.array(self.integer(">H" if tag == 0xdc else ">I"), depth)
        if tag in (0xde, 0xdf):
            return self.mapping(self.integer(">H" if tag == 0xde else ">I"), depth)
        # Binary/ext values and reserved tags are not part of this protocol.
        raise ScorerError("response_type")

    def text(self, n):
        try:
            return self.take(n).decode("utf-8", "strict")
        except UnicodeError as e:
            raise ScorerError("response_utf8") from e

    def array(self, n, depth):
        if n > MAX_ITEMS - self.items:
            raise ScorerError("response_complexity")
        return [self.value(depth + 1) for _ in range(n)]

    def mapping(self, n, depth):
        if n > (MAX_ITEMS - self.items) // 2:
            raise ScorerError("response_complexity")
        out = {}
        for _ in range(n):
            key = self.value(depth + 1)
            if not isinstance(key, str) or key in out:
                raise ScorerError("response_key")
            out[key] = self.value(depth + 1)
        return out


def _unpack(data):
    decoder = _Decoder(data)
    result = decoder.value()
    if decoder.offset != len(data):
        raise ScorerError("response_trailing_bytes")
    return result


def _validate_inputs(query, candidates):
    if not _string(query, 16384, nonblank=True):
        raise ScorerError("invalid_query")
    if not isinstance(candidates, list) or len(candidates) > MAX_CANDIDATES:
        raise ScorerError("invalid_candidates")
    ids = set()
    clean = []
    for item in candidates:
        if not isinstance(item, dict):
            raise ScorerError("invalid_candidate")
        cid, title, document = item.get("id"), item.get("title"), item.get("document")
        if not _string(cid, 4096) or cid == "" or cid in ids:
            raise ScorerError("invalid_candidate_id")
        if not _string(title, 16384) or not _string(document, 131072):
            raise ScorerError("invalid_candidate_text")
        vec = item.get("s_vec")
        if vec is not None and not _number(vec):
            raise ScorerError("invalid_vector_score")
        ids.add(cid)
        clean.append({"id": cid, "title": title, "document": document, "s_vec": vec})
    return clean


def _validate_result(envelope, candidates):
    if not isinstance(envelope, dict) or type(envelope.get("status")) is not int:
        raise ScorerError("response_envelope")
    if envelope["status"] != 0:
        raise ScorerError("daemon_rejected")
    result = envelope.get("result")
    if not isinstance(result, dict) or type(result.get("version")) is not int or result["version"] != 1:
        raise ScorerError("response_version")
    status = result.get("status")
    if status not in ("applied", "disabled", "unavailable", "failed", "deadline", "empty"):
        raise ScorerError("response_status")
    if type(result.get("applied")) is not bool or result["applied"] != (status == "applied"):
        raise ScorerError("response_applied")
    if result.get("method") != ("cross_encoder" if result["applied"] else "original_order"):
        raise ScorerError("response_method")
    if (not _string(result.get("reason"), 256)
            or any(ord(c) < 32 or ord(c) == 127 for c in result["reason"])):
        raise ScorerError("response_reason")
    n = len(candidates)
    if type(result.get("candidate_count")) is not int or result["candidate_count"] != n:
        raise ScorerError("response_count")
    rows = result.get("results")
    if not isinstance(rows, list) or len(rows) != n:
        raise ScorerError("response_candidates")
    ranks, scored = [], 0
    for i, (row, item) in enumerate(zip(rows, candidates), 1):
        if not isinstance(row, dict) or row.get("id") != item["id"]:
            raise ScorerError("response_candidate_id")
        if type(row.get("original_rank")) is not int or row["original_rank"] != i:
            raise ScorerError("response_original_rank")
        rank = row.get("rank")
        if type(rank) is not int or rank < 1 or rank > n:
            raise ScorerError("response_rank")
        if not result["applied"] and rank != i:
            raise ScorerError("response_fallback_order")
        ranks.append(rank)
        for key in ("s_vec", "s_lex", "s_ce"):
            value = row.get(key)
            if key not in row or (value is not None and not _number(value)):
                raise ScorerError("response_signal")
        expected_vec = item["s_vec"]
        if expected_vec is None:
            if row["s_vec"] is not None:
                raise ScorerError("response_vector_identity")
        elif row["s_vec"] != expected_vec:
            # Legal MessagePack float32 encoding may round the echoed cosine;
            # accept precisely that representation, not unrelated features.
            try:
                encoded_vec = _float32(expected_vec)
            except ScorerError:
                raise ScorerError("response_vector_identity") from None
            if row["s_vec"] != encoded_vec:
                raise ScorerError("response_vector_identity")
        if row["s_lex"] is not None and not 0 <= row["s_lex"] <= 1:
            raise ScorerError("response_lexical_range")
        if row["s_ce"] is not None and not 0 <= row["s_ce"] <= 1:
            raise ScorerError("response_ce_range")
        if row.get("s_lex_source") != "title_trigram_jaccard":
            raise ScorerError("response_signal_source")
        ce_status = row.get("ce_status")
        if ce_status not in ("ok", "disabled", "unavailable", "failed", "deadline", "not_scored"):
            raise ScorerError("response_ce_status")
        if (row["s_ce"] is not None) != (ce_status == "ok"):
            raise ScorerError("response_ce_missingness")
        scored += int(ce_status == "ok")
        if type(row.get("document_bytes")) is not int or row["document_bytes"] != len(item["document"].encode("utf-8")):
            raise ScorerError("response_document_size")
    if sorted(ranks) != list(range(1, n + 1)):
        raise ScorerError("response_rank_permutation")
    if type(result.get("scored_count")) is not int or result["scored_count"] != scored:
        raise ScorerError("response_scored_count")
    if result["applied"] and scored != n:
        raise ScorerError("response_incomplete_rerank")
    if (status == "empty") != (n == 0):
        raise ScorerError("response_empty")
    if result["applied"]:
        # Validate the promised CE-primary/stable-tie permutation, rather than
        # trusting a server rank that silently mixes missing or ordinal scores.
        order = sorted(range(n), key=lambda i: (-rows[i]["s_ce"], i))
        if any(rows[i]["rank"] != rank for rank, i in enumerate(order, 1)):
            raise ScorerError("response_score_order")
    return result


def _remaining(sock, deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise ScorerError("deadline")
    sock.settimeout(value)


def _read_exact(sock, size, deadline):
    chunks = []
    while size:
        _remaining(sock, deadline)
        data = sock.recv(min(size, 65536))
        if not data:
            raise ScorerError("response_eof")
        chunks.append(data)
        size -= len(data)
    return b"".join(chunks)


def score_candidates(query, candidates, socket_path, timeout_s=8.0, *, deadline=None):
    """Return the validated v1 result, or raise a content-free ScorerError.

    Only the explicitly named Unix socket is contacted. The native call can
    check its budget between pairs, but cannot preempt an in-flight model pass;
    this client bounds waiting over the whole exchange, not per recv().
    """
    if not _number(timeout_s) or not 0 < timeout_s <= 8.0:
        raise ScorerError("invalid_timeout")
    if deadline is not None and not _number(deadline):
        raise ScorerError("invalid_deadline")
    started = time.monotonic()
    deadline = min(started + timeout_s, deadline) if deadline is not None else started + timeout_s
    clean = _validate_inputs(query, candidates)
    if not _string(socket_path, 4096, nonblank=True) or not os.path.isabs(socket_path):
        raise ScorerError("unconfigured_socket")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ScorerError("deadline")
    request = {"op": "score_candidates", "args": {
        "query": query, "budget_ms": max(1, min(8000, int(remaining * 1000))), "candidates": clean,
    }}
    payload = _pack(request)
    if len(payload) > MAX_REQUEST:
        raise ScorerError("request_size")
    # Preparation and scheduling consume the SAME enclosing budget. In
    # particular, a late abandoned worker cannot start a fresh I/O deadline.
    if deadline <= time.monotonic():
        raise ScorerError("deadline")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            _remaining(sock, deadline)
            sock.connect(socket_path)
            _remaining(sock, deadline)
            # This is Graft's LITTLE-endian frame, not network byte order.
            sock.sendall(struct.pack("<I", len(payload)) + payload)
            size = struct.unpack("<I", _read_exact(sock, 4, deadline))[0]
            if not 0 < size <= MAX_RESPONSE:
                raise ScorerError("response_size")
            envelope = _unpack(_read_exact(sock, size, deadline))
    except (socket.timeout, TimeoutError) as e:
        raise ScorerError("deadline") from e
    except (OSError, ValueError) as e:
        raise ScorerError("transport") from e
    return _validate_result(envelope, clean)
