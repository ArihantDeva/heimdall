"""Scripted AF_UNIX peer for candidate_scorer.py's public v1 client contract.

Invoked one unittest method at a time by candidate-scorer-client.test.mjs.
Only the standard library is used. MessagePack below is an independent wire
oracle, not the client's encoder/decoder. No retrieval, models, storage, owner
HOME, daemon, external process, or quality/performance experiment is involved.
"""
import contextlib
import copy
import importlib.util
import io
import math
import os
from pathlib import Path
import socket
import struct
import sys
import threading
import time
import traceback
import unittest


REQUEST_CAP = 4 * 1024 * 1024
RESPONSE_CAP = 1024 * 1024
QUERY_MARKER = "PRIVATE_QUERY_Q7bc91"
DOCUMENT_MARKER = "PRIVATE_DOCUMENT_D8ea42"
QUERY = QUERY_MARKER + " 設計 🧪 e\u0301"
DEFAULT_REPLY = object()
FORBIDDEN_ACTIONS = []


class Raw:
    def __init__(self, data):
        self.data = data


class Pairs:
    """Encode maps whose invalid/duplicate keys cannot be represented by dict."""
    def __init__(self, pairs):
        self.pairs = pairs


def pack(value, wide=False):
    """Reference encoding; deliberately not dependent on implementation bytes."""
    if isinstance(value, Raw):
        return value.data
    if value is None:
        return b"\xc0"
    if value is False:
        return b"\xc2"
    if value is True:
        return b"\xc3"
    if isinstance(value, int):
        if wide:
            return (b"\xcf" + struct.pack(">Q", value) if value >= 0
                    else b"\xd3" + struct.pack(">q", value))
        if 0 <= value < 128:
            return bytes([value])
        if -32 <= value < 0:
            return bytes([value & 255])
        formats = ((255, b"\xcc", ">B"), (65535, b"\xcd", ">H"),
                   (2 ** 32 - 1, b"\xce", ">I"), (2 ** 64 - 1, b"\xcf", ">Q"))
        if value >= 0:
            for limit, tag, fmt in formats:
                if value <= limit:
                    return tag + struct.pack(fmt, value)
        else:
            for limit, tag, fmt in ((-128, b"\xd0", ">b"), (-32768, b"\xd1", ">h"),
                                    (-(2 ** 31), b"\xd2", ">i"), (-(2 ** 63), b"\xd3", ">q")):
                if value >= limit:
                    return tag + struct.pack(fmt, value)
        raise AssertionError("fixture integer outside MessagePack range")
    if isinstance(value, float):
        # Nonfinite encodings are intentional in negative cases.
        return b"\xcb" + struct.pack(">d", value)
    if isinstance(value, str):
        data = value.encode("utf-8")
        n = len(data)
        if wide or n > 65535:
            head = b"\xdb" + struct.pack(">I", n)
        elif n > 255:
            head = b"\xda" + struct.pack(">H", n)
        elif n > 31:
            head = b"\xd9" + bytes([n])
        else:
            head = bytes([0xa0 | n])
        return head + data
    if isinstance(value, list):
        n = len(value)
        head = (b"\xdd" + struct.pack(">I", n) if wide or n > 65535 else
                b"\xdc" + struct.pack(">H", n) if n > 15 else bytes([0x90 | n]))
        return head + b"".join(pack(item, wide) for item in value)
    if isinstance(value, (dict, Pairs)):
        pairs = list(value.items()) if isinstance(value, dict) else value.pairs
        n = len(pairs)
        head = (b"\xdf" + struct.pack(">I", n) if wide or n > 65535 else
                b"\xde" + struct.pack(">H", n) if n > 15 else bytes([0x80 | n]))
        return head + b"".join(pack(k, wide) + pack(v, wide) for k, v in pairs)
    raise AssertionError("unsupported fixture encoding type")


def unpack(data):
    """Independent strict reader for the client's well-formed request frames."""
    offset = 0

    def take(n):
        nonlocal offset
        if n < 0 or offset + n > len(data):
            raise AssertionError("client sent truncated MessagePack")
        value = data[offset:offset + n]
        offset += n
        return value

    def integer(fmt):
        return struct.unpack(fmt, take(struct.calcsize(fmt)))[0]

    def value():
        tag = integer(">B")
        if tag <= 0x7f:
            return tag
        if tag >= 0xe0:
            return tag - 256
        if tag == 0xc0:
            return None
        if tag in (0xc2, 0xc3):
            return tag == 0xc3
        formats = {0xcc: ">B", 0xcd: ">H", 0xce: ">I", 0xcf: ">Q",
                   0xd0: ">b", 0xd1: ">h", 0xd2: ">i", 0xd3: ">q",
                   0xca: ">f", 0xcb: ">d"}
        if tag in formats:
            return integer(formats[tag])
        if 0xa0 <= tag <= 0xbf:
            return take(tag & 31).decode("utf-8", "strict")
        if tag in (0xd9, 0xda, 0xdb):
            return take(integer({0xd9: ">B", 0xda: ">H", 0xdb: ">I"}[tag])).decode("utf-8", "strict")
        if 0x90 <= tag <= 0x9f:
            return [value() for _ in range(tag & 15)]
        if tag in (0xdc, 0xdd):
            return [value() for _ in range(integer(">H" if tag == 0xdc else ">I"))]
        if 0x80 <= tag <= 0x8f or tag in (0xde, 0xdf):
            n = tag & 15 if tag < 0x90 else integer(">H" if tag == 0xde else ">I")
            result = {}
            for _ in range(n):
                key = value()
                if not isinstance(key, str) or key in result:
                    raise AssertionError("client sent a non-string or duplicate map key")
                result[key] = value()
            return result
        raise AssertionError("client sent a non-JSON MessagePack tag")

    result = value()
    if offset != len(data):
        raise AssertionError("client sent trailing bytes in a MessagePack value")
    return result


def candidates():
    # Scripted evidence only. Composed/decomposed IDs are distinct opaque IDs;
    # titles/bodies contain astral Unicode, combining marks, and real newlines.
    return [
        {"id": "opaque:/雪🧪", "title": "Été e\u0301 🐈", "document": DOCUMENT_MARKER + " A\n雪🧪 e\u0301", "s_vec": 0.99},
        {"id": "é", "title": "second\n標題", "document": DOCUMENT_MARKER + " B\t body", "s_vec": -0.625},
        {"id": "e\u0301", "title": "", "document": "", "s_vec": 0.0},
        {"id": "  opaque id  ", "title": "missing vector", "document": DOCUMENT_MARKER + " D"},
    ]


def envelope(items=None, status="applied", scores=None, ce_statuses=None):
    items = candidates() if items is None else items
    n = len(items)
    if scores is None:
        scores = ([0.25, 0.75, 0.75, 0.0] if n == 4 else [0.5] * n) if status == "applied" else [None] * n
    if ce_statuses is None:
        ce_statuses = ["ok" if score is not None else status for score in scores]
    ranks = list(range(1, n + 1))
    if status == "applied":
        for rank, i in enumerate(sorted(range(n), key=lambda i: (-scores[i], i)), 1):
            ranks[i] = rank
    rows = [{
        "id": item["id"], "original_rank": i + 1, "rank": ranks[i],
        "s_vec": item.get("s_vec"), "s_lex": [1.0, 0.0, 0.5, None][i % 4],
        "s_ce": scores[i], "ce_status": ce_statuses[i],
        "s_lex_source": "title_trigram_jaccard",
        "document_bytes": len(item["document"].encode("utf-8")),
    } for i, item in enumerate(items)]
    return {"status": 0, "result": {
        "version": 1, "status": status, "reason": "ok" if status == "applied" else status,
        "applied": status == "applied",
        "method": "cross_encoder" if status == "applied" else "original_order",
        "candidate_count": n, "scored_count": sum(score is not None for score in scores),
        "results": rows,
    }}


class FakeScorer:
    """One private real Unix listener, with interruptible scripts and cleanup."""
    sequence = 0

    def __init__(self, root, reply):
        FakeScorer.sequence += 1
        self.path = str(Path(root) / ("s%d" % FakeScorer.sequence))
        if len(os.fsencode(self.path)) >= 100:
            raise AssertionError("fixture socket path must be shorter than 100 bytes")
        self.reply = reply
        self.stop = threading.Event()
        self.connections = 0
        self.requests = []
        self.frames = []
        self.extra = bytearray()
        self.errors = []
        self.active = None
        self.progress = 0

    def __enter__(self):
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.listener.bind(self.path)
            self.listener.listen(8)
            self.listener.settimeout(0.02)
            self.thread = threading.Thread(target=self._run, daemon=True, name="scripted-scorer")
            self.thread.start()
        except BaseException:
            self.listener.close()
            Path(self.path).unlink(missing_ok=True)
            raise
        return self

    def _read(self, conn, n):
        chunks = []
        while n and not self.stop.is_set():
            chunk = conn.recv(n)
            if not chunk:
                return None
            chunks.append(chunk)
            n -= len(chunk)
        return b"".join(chunks) if n == 0 else None

    def _run(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if not self.stop.is_set():
                    self.errors.append("listener failed before cleanup")
                return
            self.connections += 1
            self.active = conn
            try:
                with conn:
                    conn.settimeout(2.0)
                    head = self._read(conn, 4)
                    if head is None:  # Deadline may expire before a request is sent.
                        continue
                    size = struct.unpack("<I", head)[0]
                    if not 0 < size <= REQUEST_CAP:
                        raise AssertionError("request is not a bounded little-endian frame")
                    body = self._read(conn, size)
                    if body is None:
                        continue
                    self.frames.append(head + body)
                    self.requests.append(unpack(body))
                    self.reply(self, conn)
                    # A health probe or second request on the same connection is
                    # not allowed, even if its own framing would be valid.
                    conn.settimeout(0.02)
                    while not self.stop.is_set():
                        try:
                            more = conn.recv(4096)
                        except socket.timeout:
                            continue
                        if not more:
                            break
                        self.extra.extend(more)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Expected when a malformed/trickled reply is rejected.
            except OSError as error:
                if not self.stop.is_set():
                    self.errors.append(type(error).__name__)
            except BaseException as error:
                self.errors.append("%s: %s" % (type(error).__name__, error))
            finally:
                self.active = None

    def __exit__(self, exc_type, exc, tb):
        self.stop.set()
        active = self.active
        if active is not None:
            try:
                active.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            active.close()
        self.listener.close()
        self.thread.join(2.0)
        Path(self.path).unlink(missing_ok=True)
        if self.thread.is_alive():
            raise AssertionError("fake scorer thread leaked")
        if exc_type is None and self.errors:
            raise AssertionError("fake scorer: " + "; ".join(self.errors))


class Clock:
    """Controlled monotonic clock for deterministic connect/send budget tests."""
    def __init__(self):
        self.now = 100.0

    def monotonic(self):
        return self.now

    def monotonic_ns(self):
        return int(self.now * 1_000_000_000)


class ObservedSocket:
    """Wrap a REAL socket; limit reads and observe budgets, not protocol logic."""
    def __init__(self, owner, real):
        self.owner = owner
        self.real = real

    def __enter__(self):
        self.real.__enter__()
        return self

    def __exit__(self, *args):
        return self.real.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self.real, name)

    def _phase(self, name):
        self.owner.budgets.append((name, self.real.gettimeout()))
        if self.owner.clock is not None:
            self.owner.clock.now += self.owner.costs.get(name, 0.0)

    def connect(self, path):
        self.owner.paths.append(path)
        if path != self.owner.path:
            self.owner.violations.append("alternate socket connection")
            raise AssertionError("client attempted a non-fixture socket")
        self._phase("connect")
        return self.real.connect(path)

    def connect_ex(self, path):
        self.connect(path)
        return 0

    def sendall(self, data, *args):
        self._phase("send")
        self.owner.sent.extend(data)
        return self.real.sendall(data, *args)

    def send(self, data, *args):
        self._phase("send")
        n = self.real.send(data, *args)
        self.owner.sent.extend(data[:n])
        return n

    def recv(self, size, *args):
        self._phase("recv")
        if self.owner.max_read is not None:
            size = min(size, self.owner.max_read)
        return self.real.recv(size, *args)


class SocketGuard:
    """Permit only the one explicit private AF_UNIX endpoint; never real state."""
    def __init__(self, path, max_read=None, clock=None, costs=None):
        self.path = path
        self.max_read = max_read
        self.clock = clock
        self.costs = costs or {}
        self.opens = 0
        self.paths = []
        self.sent = bytearray()
        self.budgets = []
        self.violations = []
        self.real_sockets = []

    def __getattr__(self, name):
        if name in ("create_connection", "socketpair", "fromfd", "getaddrinfo"):
            self.violations.append("non-Unix helper/probe")
            raise AssertionError("client attempted an unrelated socket helper")
        return getattr(socket, name)

    def socket(self, family=socket.AF_INET, type=socket.SOCK_STREAM, proto=0, fileno=None):
        self.opens += 1
        if family != socket.AF_UNIX or (type & 15) != socket.SOCK_STREAM or self.opens > 1:
            self.violations.append("extra or non-Unix socket")
            raise AssertionError("client must create only one Unix stream socket")
        real = socket.socket(family, type, proto, fileno=fileno)
        self.real_sockets.append(real)
        return ObservedSocket(self, real)

    def close(self):
        for real in self.real_sockets:
            real.close()


@contextlib.contextmanager
def guarded(module, path, **kwargs):
    guard = SocketGuard(path, **kwargs)
    old_socket, old_time = module.socket, module.time
    module.socket = guard
    if guard.clock is not None:
        module.time = guard.clock
    try:
        yield guard
    finally:
        module.socket, module.time = old_socket, old_time
        guard.close()


class Contract(unittest.TestCase):
    def setUp(self):
        self.module = MODULE
        self.root = ROOT
        self.assertEqual(os.environ["HOME"], str(Path(ROOT) / "home"))
        self.assertFalse(any(key.startswith(("HEIMDALL", "GRAFT")) for key in os.environ))
        self.assertEqual(os.stat(ROOT).st_mode & 0o777, 0o700)

    def tearDown(self):
        self.assertEqual(FORBIDDEN_ACTIONS, [], "client attempted to spawn or contact a non-private resource")

    def error(self, call, code=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                call()
            except self.module.ScorerError as error:
                caught = error
            except BaseException as error:
                self.fail("expected safe ScorerError, got " + type(error).__name__)
            else:
                self.fail("expected ScorerError; invalid input/reply was accepted")
        self.assertIsInstance(caught.code, str)
        self.assertRegex(caught.code, r"\A[A-Za-z0-9_.-]{1,80}\Z")
        if code is not None:
            self.assertEqual(caught.code, code)
        diagnostic = (str(caught) + repr(caught) + stdout.getvalue() + stderr.getvalue()
                      + "".join(traceback.format_exception(type(caught), caught, caught.__traceback__)))
        for secret in (QUERY_MARKER, DOCUMENT_MARKER):
            self.assertNotIn(secret, diagnostic)
        return caught

    def assert_exchange(self, server, guard, items, query=QUERY, timeout_s=2.0):
        self.assertEqual(guard.violations, [])
        self.assertEqual(guard.opens, 1)
        self.assertEqual(guard.paths, [server.path])
        self.assertEqual(server.connections, 1)
        self.assertEqual(len(server.requests), 1)
        self.assertEqual(server.extra, b"")
        self.assertEqual(bytes(guard.sent), server.frames[0], "more than one request/probe was sent")
        frame = server.frames[0]
        self.assertEqual(struct.unpack("<I", frame[:4])[0], len(frame) - 4)
        self.assertLessEqual(len(frame) - 4, REQUEST_CAP)
        request = server.requests[0]
        self.assertEqual(request.get("op"), "score_candidates")
        args = request["args"]
        self.assertEqual(args["query"], query)
        expected = [{"id": item["id"], "title": item["title"], "document": item["document"],
                     "s_vec": item.get("s_vec")} for item in items]
        self.assertEqual(args["candidates"], expected)
        self.assertIs(type(args["budget_ms"]), int)
        self.assertGreaterEqual(args["budget_ms"], 1)
        self.assertLessEqual(args["budget_ms"], min(8000, math.ceil(timeout_s * 1000)))

    def exchange(self, reply=DEFAULT_REPLY, items=None, query=QUERY, timeout_s=2.0,
                 bad=False, code=None, wire=None, script=None, **guard_options):
        items = candidates() if items is None else items
        reply = envelope(items) if reply is DEFAULT_REPLY else reply
        body = pack(reply) if wire is None else wire

        def send(server, conn):
            conn.sendall(struct.pack("<I", len(body)) + body)

        with FakeScorer(self.root, script or send) as server:
            with guarded(self.module, server.path, **guard_options) as guard:
                call = lambda: self.module.score_candidates(query, items, server.path, timeout_s)
                result = self.error(call, code) if bad else call()
        self.assert_exchange(server, guard, items, query, timeout_s)
        return result, server, guard

    def test_wire_unicode_and_missingness(self):
        expected = envelope()
        actual, server, _ = self.exchange(expected, timeout_s=0.875)
        self.assertEqual(actual, expected["result"])
        self.assertGreater(len(server.frames[0]) - 4, 255)
        self.assertEqual([r["id"] for r in actual["results"]], [c["id"] for c in candidates()])
        self.assertEqual([r["s_vec"] for r in actual["results"]], [0.99, -0.625, 0.0, None])
        self.assertEqual(actual["results"][3]["s_vec"], None)
        self.assertEqual(actual["results"][3]["s_lex"], None)
        self.assertEqual(actual["results"][3]["s_ce"], 0.0)
        self.assertEqual(actual["results"][3]["ce_status"], "ok")
        self.assertEqual(actual["scored_count"], 4, "zero is a real observed CE score")
        self.assertEqual(actual["results"][0]["document_bytes"], len(candidates()[0]["document"].encode("utf-8")))
        # Native finite float32 output is as legitimate as float64. Preserve
        # raw negative cosine, and allow exactly the native representation of
        # the supplied evidence rather than demanding decimal round-tripping.
        native = envelope()
        native["result"]["results"][0]["s_vec"] = Raw(b"\xca" + struct.pack(">f", 0.99))
        native["result"]["results"][1]["s_vec"] = Raw(b"\xca" + struct.pack(">f", -0.625))
        native["result"]["results"][2]["s_ce"] = Raw(b"\xca" + struct.pack(">f", 0.75))
        native_result, _, _ = self.exchange(native)
        self.assertEqual(native_result["results"][0]["s_vec"], struct.unpack(">f", struct.pack(">f", 0.99))[0])
        self.assertEqual(native_result["results"][1]["s_vec"], -0.625)
        self.assertEqual([r["rank"] for r in native_result["results"]], [3, 1, 2, 4])
        integer_items = candidates()
        integer_items[0]["s_vec"], integer_items[1]["s_vec"] = 0, -1
        integer_result, _, _ = self.exchange(envelope(integer_items), items=integer_items)
        self.assertEqual([r["s_vec"] for r in integer_result["results"]], [0, -1, 0.0, None])

    def test_ce_primary_and_stable_ties(self):
        actual, _, _ = self.exchange()
        self.assertEqual([r["rank"] for r in actual["results"]], [3, 1, 2, 4])
        self.assertEqual([r["original_rank"] for r in actual["results"]], [1, 2, 3, 4])
        for scores, expected in (([0.0] * 4, [1, 2, 3, 4]),
                                 ([1.0, 0.0, 1.0, 0.0], [1, 3, 2, 4])):
            with self.subTest(scores=scores):
                result, _, _ = self.exchange(envelope(scores=scores))
                self.assertEqual([r["rank"] for r in result["results"]], expected)

    def test_opaque_whitespace_ids(self):
        items = candidates()
        items[0]["id"], items[1]["id"] = " ", "\t\u2003"
        result, server, _ = self.exchange(envelope(items), items)
        self.assertEqual([r["id"] for r in result["results"]], [c["id"] for c in items])
        self.assertEqual(server.requests[0]["args"]["candidates"][0]["id"], " ")

    def test_fragmented_and_wide_encodings(self):
        reply = envelope()
        reply["result"]["extension"] = {
            "unsigned": [Raw(b"\xcc\xff"), Raw(b"\xcd\xff\xff"), Raw(b"\xce\xff\xff\xff\xff"),
                         Raw(b"\xcf" + b"\xff" * 8)],
            "signed": [Raw(b"\xd0\x80"), Raw(b"\xd1\x80\x00"), Raw(b"\xd2\x80\x00\x00\x00"),
                       Raw(b"\xd3\x80" + b"\x00" * 7), -1],
            "float32": Raw(b"\xca" + struct.pack(">f", 0.5)), "float64": -0.25,
            "json": [None, True, False, [], {}, {"text": "雪🧪"}],
        }
        # Accept all legal long-form container/string encodings even for small
        # values. A decoder must not assume the client's preferred encoding.
        body = pack(reply, wide=True)
        framed = struct.pack("<I", len(body)) + body

        def fragmented(server, conn):
            start = 0
            for size in (1, 1, 2, 3, 5, 7, 11):
                conn.sendall(framed[start:start + size])
                start += size
                if server.stop.wait(0.001):
                    return
            conn.sendall(framed[start:])

        result, _, _ = self.exchange(reply, wire=body, script=fragmented, max_read=3)
        self.assertEqual(result, unpack(body)["result"])
        self.assertEqual(result["extension"]["unsigned"], [255, 65535, 2 ** 32 - 1, 2 ** 64 - 1])
        self.assertEqual(result["extension"]["signed"], [-128, -32768, -(2 ** 31), -(2 ** 63), -1])
        self.assertEqual(result["extension"]["float32"], 0.5)

    def test_degraded_original_order(self):
        for status in ("disabled", "unavailable", "failed", "deadline"):
            with self.subTest(status=status):
                scores = [0.0, 0.9, None, None] if status in ("failed", "deadline") else [None] * 4
                states = ["ok", "ok", status, "not_scored"] if scores[0] is not None else [status] * 4
                reply = envelope(status=status, scores=scores, ce_statuses=states)
                if status == "unavailable":
                    reply["result"]["reason"] = "cpu_required"
                result, _, _ = self.exchange(reply)
                self.assertEqual(result, reply["result"])
                self.assertFalse(result["applied"])
                self.assertEqual(result["method"], "original_order")
                self.assertEqual([r["rank"] for r in result["results"]], [1, 2, 3, 4])
                self.assertEqual([r["s_ce"] for r in result["results"]], scores)
                self.assertEqual(result["scored_count"], 2 if status in ("failed", "deadline") else 0)
                bad = copy.deepcopy(reply)
                bad["result"]["results"][0]["rank"], bad["result"]["results"][1]["rank"] = 2, 1
                self.exchange(bad, bad=True)

    def test_empty_success(self):
        expected = envelope([], status="empty")
        result, _, _ = self.exchange(expected, items=[])
        self.assertEqual(result, expected["result"])
        self.assertEqual(result["results"], [])
        self.assertEqual(result["candidate_count"], 0)
        self.assertEqual(result["scored_count"], 0)
        self.assertFalse(result["applied"])
        self.exchange(envelope([], status="applied"), items=[], bad=True)
        self.exchange(envelope(status="empty"), bad=True)

    def test_maximum_valid_request(self):
        query = "🧪" * 4096  # exactly 16384 UTF-8 bytes
        title = "é" * 8192   # exactly 16384 bytes
        document = "文" * 43690 + "é"  # exactly 131072 bytes
        items = []
        for i in range(25):
            prefix = "%02d" % i
            cid = prefix + "é" * 2047  # exactly 4096 bytes, distinct IDs
            items.append({"id": cid, "title": title, "document": document, "s_vec": -0.125})
        reply = envelope(items, status="disabled")
        result, server, _ = self.exchange(reply, items=items, query=query, timeout_s=8.0)
        self.assertEqual(result, reply["result"])
        size = len(server.frames[0]) - 4
        self.assertGreater(size, RESPONSE_CAP, "request and response caps must not be confused")
        self.assertLessEqual(size, REQUEST_CAP)
        self.assertEqual(result["candidate_count"], 25)

    def test_envelope_and_result_shapes(self):
        cases = []
        for value in (None, [], "not a map", 0, True):
            cases.append(("envelope type " + type(value).__name__, value))
        for value in (None, False, True, 0.0, "0", 1, -1):
            bad = envelope()
            bad["status"] = value
            cases.append(("outer status " + repr(value), bad))
        bad = envelope()
        del bad["status"]
        cases.append(("missing outer status", bad))
        for value in (None, [], "bad", 1):
            bad = envelope()
            bad["result"] = value
            cases.append(("result type " + type(value).__name__, bad))
        for key, values in (
            ("version", [None, True, 0, 2, "1", 1.0]),
            ("status", [None, True, 0, "unknown", [], {}]),
            ("applied", [None, 1, "true", False]),
            ("method", [None, True, "original_order", "fused"]),
            ("reason", [None, True, {}, "bad\0reason"]),
            ("candidate_count", [None, True, 3, 5, -1, 4.0, "4"]),
            ("scored_count", [None, True, 3, 5, -1, 4.0, "4"]),
            ("results", [None, {}, "rows"]),
        ):
            for value in values:
                bad = envelope()
                bad["result"][key] = value
                cases.append((key + "=" + repr(value), bad))
        for key in ("version", "status", "applied", "method", "reason", "candidate_count", "scored_count", "results"):
            bad = envelope()
            del bad["result"][key]
            cases.append(("missing " + key, bad))
        for label, reply in cases:
            with self.subTest(case=label):
                self.exchange(reply, bad=True)

    def test_identity_and_rank_validation(self):
        cases = []
        for key, values in (
            ("id", [None, 1, "unknown", candidates()[1]["id"]]),
            ("original_rank", [None, True, 0, 2, 1.0, "1"]),
            ("rank", [None, True, 0, -1, 5, 3.0, "3"]),
        ):
            for value in values:
                bad = envelope()
                bad["result"]["results"][0][key] = value
                cases.append((key + "=" + repr(value), bad))
            bad = envelope()
            del bad["result"]["results"][0][key]
            cases.append(("missing " + key, bad))
        for label, ranks in (("duplicate ranks", [3, 1, 1, 4]),
                             ("CE not primary", [1, 2, 3, 4]),
                             ("unstable tie", [3, 2, 1, 4])):
            bad = envelope()
            for row, rank in zip(bad["result"]["results"], ranks):
                row["rank"] = rank
            cases.append((label, bad))
        bad = envelope()
        bad["result"]["results"].sort(key=lambda row: row["rank"])
        cases.append(("rows must stay in input order", bad))
        for label, change in (
            ("missing row", lambda rows: rows.pop()),
            ("extra row", lambda rows: rows.append(copy.deepcopy(rows[0]))),
            ("non-map row", lambda rows: rows.__setitem__(0, [])),
        ):
            bad = envelope()
            change(bad["result"]["results"])
            cases.append((label, bad))
        bad = envelope()
        bad["result"]["results"][0]["s_ce"] = None
        bad["result"]["results"][0]["ce_status"] = "not_scored"
        bad["result"]["scored_count"] = 3
        cases.append(("applied partial window", bad))
        for label, reply in cases:
            with self.subTest(case=label):
                self.exchange(reply, bad=True)

    def test_signal_validation(self):
        cases = []
        for key in ("s_vec", "s_lex", "s_ce"):
            for value in (False, True, "0", [], {}, float("nan"), float("inf"), -float("inf")):
                bad = envelope()
                bad["result"]["results"][0][key] = value
                cases.append((key + ":" + repr(value), bad))
            bad = envelope()
            del bad["result"]["results"][0][key]
            cases.append(("missing " + key, bad))
        for key in ("s_ce", "s_lex"):
            for value in (-0.01, 1.01):
                bad = envelope()
                bad["result"]["results"][0][key] = value
                cases.append((key + " outside normalized range", bad))
        for key, values in (
            ("ce_status", [None, True, "unknown", "not_scored", "failed"]),
            ("s_lex_source", [None, "bm25", "document_trigram_jaccard"]),
            ("document_bytes", [None, True, 0, -1, 1.0, "1"]),
        ):
            for value in values:
                bad = envelope()
                bad["result"]["results"][0][key] = value
                cases.append((key + "=" + repr(value), bad))
            bad = envelope()
            del bad["result"]["results"][0][key]
            cases.append(("missing " + key, bad))
        for label, index, value in (("missing vector cannot become fake zero", 3, 0.0),
                                    ("observed vector zero cannot become null", 2, None),
                                    ("vector evidence belongs to its candidate ID", 0, -0.625)):
            bad = envelope()
            bad["result"]["results"][index]["s_vec"] = value
            cases.append((label, bad))
        bad = envelope()
        bad["result"]["results"][0]["s_ce"] = None
        cases.append(("ok CE cannot be null", bad))
        bad = envelope(status="disabled")
        bad["result"]["results"][0]["s_ce"] = 0.0
        cases.append(("disabled CE cannot carry fake zero", bad))
        for tag, fmt in ((b"\xca", ">f"), (b"\xcb", ">d")):
            for value in (float("nan"), float("inf"), -float("inf")):
                bad = envelope()
                bad["result"]["additive_numeric"] = Raw(tag + struct.pack(fmt, value))
                cases.append(("nonfinite additive value " + fmt, bad))
        for label, reply in cases:
            with self.subTest(case=label):
                self.exchange(reply, bad=True)

    def test_map_keys(self):
        for layer in ("envelope", "result", "row"):
            for label, key in (("duplicate", "status" if layer != "row" else "id"),
                               ("integer", 7), ("bool", True), ("nil", None),
                               ("array", []), ("map", {})):
                with self.subTest(layer=layer, key=label):
                    reply = envelope()
                    mapping = reply if layer == "envelope" else reply["result"] if layer == "result" else reply["result"]["results"][0]
                    pairs = list(mapping.items()) + [(key, mapping[key] if label == "duplicate" else "value")]
                    replacement = Pairs(pairs)
                    if layer == "envelope":
                        reply = replacement
                    elif layer == "result":
                        reply["result"] = replacement
                    else:
                        reply["result"]["results"][0] = replacement
                    self.exchange(reply, bad=True)

    def test_malformed_messagepack(self):
        malformed = [
            ("reserved", b"\xc1"),
            ("missing string8 size", b"\xd9"),
            ("missing string16 size", b"\xda\x00"),
            ("missing string32 size", b"\xdb\x00\x00\x00"),
            ("short fixstr", b"\xa3ab"),
            ("short string16", b"\xda\x00\x05abc"),
            ("hostile string32 length", b"\xdb\xff\xff\xff\xff"),
            ("short integer", b"\xd3\x00"),
            ("short float32", b"\xca\x00\x00"),
            ("short float64", b"\xcb\x00\x00"),
            ("short array", b"\x92\xc0"),
            ("short map", b"\x81\xa1x"),
            ("array16 missing size", b"\xdc\x00"),
            ("array32 missing size", b"\xdd\x00\x00\x00"),
            ("map16 missing size", b"\xde\x00"),
            ("map32 missing size", b"\xdf\x00\x00\x00"),
            ("trailing second value", pack(envelope()) + b"\xc0"),
            ("trailing arbitrary byte", pack(envelope()) + b"\xff"),
        ]
        unsupported = [
            b"\xc4\x03abc", b"\xc5\x00\x03abc", b"\xc6\x00\x00\x00\x03abc",
            b"\xc7\x01\x00x", b"\xc8\x00\x01\x00x", b"\xc9\x00\x00\x00\x01\x00x",
            b"\xd4\x00x", b"\xd5\x00xx", b"\xd6\x00xxxx", b"\xd7\x00" + b"x" * 8,
            b"\xd8\x00" + b"x" * 16,
        ]
        for i, encoded in enumerate(unsupported):
            reply = envelope()
            reply["additive"] = Raw(encoded)
            malformed.append(("binary/ext tag %d" % i, pack(reply)))
        for i, encoded in enumerate((
            b"\xa1\xff", b"\xd9\x01\xff", b"\xda\x00\x01\xff", b"\xdb\x00\x00\x00\x01\xff",
            b"\xa2\xc0\x80", b"\xa3\xed\xa0\x80", b"\xa4\xf4\x90\x80\x80", b"\xa1\xc3",
        )):
            reply = envelope()
            reply["additive"] = Raw(encoded)
            malformed.append(("non-UTF8 string %d" % i, pack(reply)))
        # Every byte prefix of a legal small envelope must fail (not hang or
        # escape as struct.error/IndexError/UnicodeError). This is fixed data.
        short = pack(envelope([], status="empty"))
        for cut in (1, 2, 3, 4, 7, len(short) // 2, len(short) - 1):
            malformed.append(("truncated envelope at %d" % cut, short[:cut]))
        for label, body in malformed:
            with self.subTest(case=label):
                self.exchange(wire=body, bad=True)

    def test_response_frame_limits(self):
        for label, wire_header in (("zero", struct.pack("<I", 0)),
                                   ("over cap", struct.pack("<I", RESPONSE_CAP + 1)),
                                   ("max uint32", b"\xff" * 4),
                                   ("big-endian header", struct.pack(">I", 1000))):
            with self.subTest(header=label):
                def header_only(server, conn):
                    conn.sendall(wire_header)
                    server.stop.wait(1.0)  # Must reject length, not wait for body.
                error, _, _ = self.exchange(script=header_only, timeout_s=0.35, bad=True)
                self.assertNotEqual(error.code, "deadline", "oversized/zero frame was read instead of rejected")
        for label, sent in (("empty header", b""), ("one header byte", b"\x01"),
                            ("three header bytes", b"\x01\x00\x00"),
                            ("short body", struct.pack("<I", 10) + b"\x81\xa1x")):
            with self.subTest(truncation=label):
                def truncated(server, conn):
                    if sent:
                        conn.sendall(sent)
                    conn.shutdown(socket.SHUT_WR)
                self.exchange(script=truncated, bad=True)
        # An otherwise valid response exactly at the cap is legal. Extra fields
        # are additive, and request/response caps are intentionally different.
        reply = envelope()
        reply["padding"] = ""
        for _ in range(3):
            delta = RESPONSE_CAP - len(pack(reply))
            reply["padding"] = reply["padding"] + "x" * delta if delta >= 0 else reply["padding"][:delta]
        self.assertEqual(len(pack(reply)), RESPONSE_CAP)
        result, _, _ = self.exchange(reply)
        self.assertEqual(result, reply["result"])

    def test_complexity_limits(self):
        nested = None
        for _ in range(96):
            nested = [nested]
        many = [None] * 100_000
        for label, value in (("depth", nested), ("items", many),
                             ("array32 count", Raw(b"\xdd\xff\xff\xff\xff")),
                             ("map32 count", Raw(b"\xdf\xff\xff\xff\xff"))):
            with self.subTest(limit=label):
                reply = envelope()
                reply["extension"] = value
                self.assertLess(len(pack(reply)), RESPONSE_CAP)
                self.exchange(reply, bad=True)
        reply = envelope()
        reply["result"]["bounded_addition"] = [[[{"ok": [None, 0, False, "雪"]}]]]
        actual, _, _ = self.exchange(reply)
        self.assertEqual(actual, reply["result"])

    def assert_no_connection(self, call):
        path = str(Path(self.root) / "never-connect")
        with guarded(self.module, path) as guard:
            self.error(lambda: call(path))
        self.assertEqual(guard.opens, 0, "validation happened after constructing a socket")
        self.assertEqual(guard.paths, [])
        self.assertEqual(guard.sent, b"")
        self.assertEqual(guard.violations, [])

    def test_invalid_inputs_no_connection(self):
        cases = []
        for value in (None, True, 1, [], {}, "", " \t\u2003", "q\0tail", "\ud800", "é" * 8193):
            cases.append(("query " + type(value).__name__, value, candidates()))
        for value in (None, {}, (), "candidates", 1, [candidates()[0]] * 26):
            cases.append(("candidates " + type(value).__name__, QUERY, value))
        for value in (None, [], "candidate", 1):
            cases.append(("non-map candidate " + type(value).__name__, QUERY, [value]))
        for key, values in (
            ("id", [None, True, 0, [], {}, "", "id\0tail", "\ud800", "é" * 2049]),
            ("title", [None, True, 0, [], {}, "title\0tail", "\ud800", "é" * 8193]),
            ("document", [None, True, 0, [], {}, "body\0tail", "\ud800", "é" * 65537]),
            ("s_vec", [True, False, "0", [], {}, float("nan"), float("inf"), -float("inf"), 2 ** 64, 2 ** 4096]),
        ):
            for i, value in enumerate(values):
                items = candidates()
                items[0][key] = value
                cases.append((key + " invalid variant %d" % i, QUERY, items))
        for key in ("id", "title", "document"):
            items = candidates()
            del items[0][key]
            cases.append(("missing " + key, QUERY, items))
        items = candidates()
        items[1]["id"] = items[0]["id"]
        cases.append(("duplicate ID", QUERY, items))
        for label, query, items in cases:
            with self.subTest(case=label):
                self.assert_no_connection(lambda path: self.module.score_candidates(query, items, path, 0.5))

    def test_invalid_transport_inputs_no_connection(self):
        for i, value in enumerate((None, True, False, 0, -1, 8.001, "1", [], {}, float("nan"),
                                   float("inf"), -float("inf"), 2 ** 4096)):
            with self.subTest(timeout_variant=i):
                self.assert_no_connection(lambda path: self.module.score_candidates(QUERY, candidates(), path, value))
        for i, path in enumerate((None, True, 1, [], {}, "", "relative.sock", " \t", "/tmp/x\0tail", "/" + "x" * 4096, "\ud800")):
            with self.subTest(socket_variant=i):
                self.assert_no_connection(lambda unused: self.module.score_candidates(QUERY, candidates(), path, 0.5))

    def test_no_probe_retry_or_fallback(self):
        # Any inherited daemon environment is absent. Deliberate alternate paths
        # below are ALSO private, and must never be consulted for an explicit
        # request or for an unconfigured request.
        def decoy_reply(server, conn):
            conn.sendall(struct.pack("<I", 1) + b"\xc0")

        with FakeScorer(self.root, decoy_reply) as decoy:
            os.environ["HEIMDALL_RERANK_SOCKET"] = decoy.path
            os.environ["GRAFT_SOCKET"] = decoy.path
            try:
                missing = str(Path(self.root) / "absent.sock")
                with guarded(self.module, missing) as guard:
                    self.error(lambda: self.module.score_candidates(QUERY, candidates(), missing, 0.3))
                self.assertEqual(guard.opens, 1)
                self.assertEqual(guard.paths, [missing])
                self.assertEqual(guard.violations, [])
                self.assertEqual(guard.sent, b"")
                self.assert_no_connection(lambda unused: self.module.score_candidates(QUERY, candidates(), None, 0.3))
                self.exchange()
                self.exchange(wire=b"\xc1", bad=True)
                self.exchange(envelope(status="unavailable"))
            finally:
                os.environ.pop("HEIMDALL_RERANK_SOCKET", None)
                os.environ.pop("GRAFT_SOCKET", None)
        self.assertEqual(decoy.connections, 0, "client probed or fell back to the environment socket")
        self.assertEqual(decoy.requests, [])
        self.assertEqual(FORBIDDEN_ACTIONS, [], "client attempted to spawn a daemon or probe outside the fixture")

    def trickle(self, header):
        body = pack(envelope())
        frame = struct.pack("<I", len(body)) + body

        def reply(server, conn):
            start = 0 if header else 4
            if not header:
                conn.sendall(frame[:4])
            # Each gap is below timeout, but cumulative progress exceeds it.
            # Finish after a bounded number of gaps even for a broken client.
            for index in range(start, start + 8):
                conn.sendall(frame[index:index + 1])
                server.progress += 1
                if server.stop.wait(0.075):
                    return
            conn.sendall(frame[start + 8:])

        started = time.monotonic()
        _, server, _ = self.exchange(script=reply, timeout_s=0.25, bad=True, code="deadline")
        elapsed = time.monotonic() - started
        self.assertGreater(server.progress, 0, "peer never made partial progress")
        self.assertLess(elapsed, 1.25, "client did not bound total waiting (with scheduling allowance)")

    def test_trickled_header_deadline(self):
        self.trickle(header=True)

    def test_trickled_body_deadline(self):
        self.trickle(header=False)

    def test_deadline_across_connect_send_receive(self):
        clock = Clock()
        result, _, guard = self.exchange(timeout_s=0.8, clock=clock,
                                         costs={"connect": 0.2, "send": 0.2, "recv": 0.05})
        self.assertTrue(result["applied"])
        by_phase = {}
        for name, budget in guard.budgets:
            by_phase.setdefault(name, budget)
        self.assertAlmostEqual(by_phase["connect"], 0.8, places=6)
        self.assertAlmostEqual(by_phase["send"], 0.6, places=6)
        self.assertAlmostEqual(by_phase["recv"], 0.4, places=6)
        recv_budgets = [budget for name, budget in guard.budgets if name == "recv"]
        self.assertGreaterEqual(len(recv_budgets), 2)
        self.assertTrue(all(b < a for a, b in zip(recv_budgets, recv_budgets[1:])))
        for label, costs, expected_phases in (
            ("connect exhausted budget", {"connect": 0.6}, ["connect"]),
            ("send exhausted budget", {"connect": 0.1, "send": 0.6}, ["connect", "send"]),
        ):
            with self.subTest(phase=label):
                body = pack(envelope())
                with FakeScorer(self.root, lambda server, conn: conn.sendall(struct.pack("<I", len(body)) + body)) as server:
                    with guarded(self.module, server.path, clock=Clock(), costs=costs) as observed:
                        self.error(lambda: self.module.score_candidates(QUERY, candidates(), server.path, 0.5), "deadline")
                self.assertEqual(observed.opens, 1)
                self.assertEqual(observed.paths, [server.path])
                self.assertEqual(observed.violations, [])
                self.assertEqual([name for name, _ in observed.budgets], expected_phases)

    def test_enclosing_deadline_includes_preparation(self):
        for phase in ("validation", "encoding"):
            clock = Clock()
            path = str(Path(self.root) / "never-connect-after-preparation")
            target = "_validate_inputs" if phase == "validation" else "_pack"
            original = getattr(self.module, target)
            def slow(*args, **kwargs):
                value = original(*args, **kwargs)
                clock.now += 1.0  # controlled work, NOT a wall-time benchmark
                return value
            setattr(self.module, target, slow)
            try:
                with guarded(self.module, path, clock=clock) as observed:
                    self.error(lambda: self.module.score_candidates(
                        QUERY, candidates(), path, 8.0, deadline=100.5), "deadline")
                    self.assertEqual(observed.opens, 0)
                    self.assertEqual(observed.paths, [])
            finally:
                setattr(self.module, target, original)
        for deadline in (True, float("nan"), float("inf"), "later"):
            self.assert_no_connection(lambda path: self.module.score_candidates(
                QUERY, candidates(), path, 0.5, deadline=deadline))
        body = pack(envelope())
        with FakeScorer(self.root, lambda server, conn: conn.sendall(struct.pack("<I", len(body)) + body)) as server:
            with guarded(self.module, server.path, clock=Clock()) as observed:
                result = self.module.score_candidates(QUERY, candidates(), server.path, 8.0, deadline=100.2)
                self.assertTrue(result["applied"])
                self.assertAlmostEqual(observed.budgets[0][1], 0.2, places=6)
        self.assertGreater(server.requests[0]["args"]["budget_ms"], 0)
        self.assertLessEqual(server.requests[0]["args"]["budget_ms"], 200)

    def test_safe_diagnostics(self):
        # Do not let content from untrusted error envelopes/invalid fields turn
        # into exception messages, chained traceback details, stdout or stderr.
        for reply in (
            {"status": 1, "error": QUERY_MARKER + " " + DOCUMENT_MARKER, "result": {"raw": QUERY}},
            {"status": 0, "result": {"version": 99, "query": QUERY, "document": DOCUMENT_MARKER}},
            envelope(),
        ):
            if reply.get("result", {}).get("version") == 1:
                reply["result"]["results"][0]["id"] = QUERY_MARKER + DOCUMENT_MARKER
            with self.subTest(kind=reply["status"], version=reply.get("result", {}).get("version")):
                self.exchange(reply, bad=True)
        bad_reason = envelope()
        bad_reason["result"]["reason"] = QUERY_MARKER + DOCUMENT_MARKER + "\0"
        self.exchange(bad_reason, bad=True)
        for key in ("query", "document"):
            self.assert_no_connection(lambda path: self.module.score_candidates(
                QUERY + "\0" if key == "query" else QUERY,
                [{"id": "x", "title": "x", "document": DOCUMENT_MARKER + "\0"}] if key == "document" else candidates(),
                path, 0.5))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: contract.py CLIENT PRIVATE_ROOT TEST_METHOD")
    module_path, ROOT, method = sys.argv[1:]
    if not Path(ROOT).is_absolute() or not Path(ROOT, "home").is_dir():
        raise SystemExit("private test root/home required")
    def deny_external_actions(event, args):
        if event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.spawn",
                     "os.exec", "os.fork", "os.forkpty", "pty.spawn"):
            FORBIDDEN_ACTIONS.append(event)
            raise AssertionError("no subprocess/daemon spawning in scorer contract tests")
        if event == "socket.connect":
            sock, address = args
            path = os.fsdecode(address) if isinstance(address, (str, bytes)) else ""
            if sock.family != socket.AF_UNIX or not path.startswith(ROOT + os.sep):
                FORBIDDEN_ACTIONS.append("external socket.connect")
                raise AssertionError("only private fixture Unix sockets may be contacted")

    sys.addaudithook(deny_external_actions)
    spec = importlib.util.spec_from_file_location("candidate_scorer_under_test", module_path)
    MODULE = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(MODULE)
    suite = unittest.TestSuite([Contract(method)])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
