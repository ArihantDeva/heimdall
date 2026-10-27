#!/usr/bin/env python3
"""query-shim.py — thin client for the warm query worker (bin/query-server.py).

Prints EXACTLY what `embed-index.py query <q> -n N --related` prints:

    [{score}] {title} — {path}
    [{score}] {title} ·related — {path}

so existing text callers need no branch. --json preserves the complete worker
reply (including leg/related provenance) for kb-search.sh's shared verdict pass.
The shim only rewrites transport; a successful reply is not a trust verdict.

Exit codes are the shell's decision point:
    0  answered (hits may legitimately be empty)
    1  worker unreachable / error  → kb-search.sh falls back to the cold
       `embed-index.py query` path. A missing worker must NEVER silently
       degrade the semantic leg to lexical-only; that is the exact failure
       mode the 2026-09-10 note in kb-search.sh exists to make loud.
"""
from __future__ import annotations

import json
import os
import pathlib
import socket
import sys
import time

DEFAULT_SOCKET = pathlib.Path.home() / ".heimdall" / "query.sock"


def main(argv: list[str]) -> int:
    # Consume option values as data: globally removing "--json" would also
    # remove a literal scope with that name. -- consumes ONE literal query, so
    # internal callers can transport flag-shaped queries and options after it.
    fused = json_out = related = False
    kind = scope = q = None
    n = 5
    i = 0
    while i < len(argv):
        arg = argv[i]
        i += 1
        if arg == "--":
            if i == len(argv) or q is not None:
                print("query-shim: -- requires one query", file=sys.stderr)
                return 1
            q = argv[i]
            i += 1
        elif arg == "--fused":
            fused = True
        elif arg == "--json":
            json_out = True
        elif arg == "--related":
            related = True
        elif arg in ("--kind", "--scope", "-n"):
            if i == len(argv):
                print(f"query-shim: {arg} requires a value", file=sys.stderr)
                return 1
            value = argv[i]
            i += 1
            if arg == "--kind":
                kind = value
            elif arg == "--scope":
                scope = value
            else:
                try:
                    n = int(value)
                except ValueError:
                    print("query-shim: -n requires an integer", file=sys.stderr)
                    return 1
        elif q is None:
            q = arg
        else:
            print(f"query-shim: unexpected argument {arg}", file=sys.stderr)
            return 1
    if q is None or not q.strip():
        print("query-shim: empty query", file=sys.stderr)
        return 1

    sock_path = pathlib.Path(os.environ.get("HEIMDALL_QUERY_SOCK", str(DEFAULT_SOCKET))).expanduser()
    req = {"op": "search" if fused else "query", "q": q, "n": n, "related": related}
    if kind:
        req["kind"] = kind
    if scope:
        req["scope"] = scope
    # ONE DEADLINE FOR THE WHOLE EXCHANGE, not per-recv. `settimeout` applies to
    # each individual socket operation, so a worker that trickles a byte at a time
    # resets the clock on every recv: measured 2026-10-23, a 1s timeout took 7.7s
    # against a server sending one byte every 0.3s. With the default 90s and a
    # stalled worker that is an unbounded search — and every caller of
    # kb-search.sh waits on it. The absolute deadline below cannot be reset.
    timeout = float(os.environ.get("HEIMDALL_QUERY_TIMEOUT", "90"))
    deadline = time.monotonic() + timeout
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(str(sock_path))
            s.sendall((json.dumps(req) + "\n").encode())
            buf = b""
            while b"\n" not in buf:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"no complete reply within {timeout}s")
                s.settimeout(remaining)
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
    except (OSError, ValueError) as e:
        print(f"query-shim: worker unreachable ({e})", file=sys.stderr)
        return 1

    try:
        reply = json.loads(buf.split(b"\n", 1)[0].decode("utf-8", "replace"))
    except (json.JSONDecodeError, IndexError) as e:
        print(f"query-shim: bad reply ({e})", file=sys.stderr)
        return 1
    if not reply.get("ok"):
        print(f"query-shim: {reply.get('error', 'unknown error')}", file=sys.stderr)
        return 1

    # FORWARD the coverage the server reported. `ok` only means the request was
    # understood; it says nothing about whether BOTH legs ran. Measured
    # 2026-10-23: fused_search degraded to lexical-only (semantic leg blew its
    # deadline), the server correctly reported sem_coverage=degraded, and this
    # shim dropped the field on the floor — so kb-search.sh printed
    # "retrieve (warm fused: lexical + semantic)" for a lexical-only answer.
    # The docstring above promises a missing semantic leg is never silent; a
    # DEGRADED reply is the same failure with the worker still alive, so it gets
    # the same treatment: say so on stderr, where kb-search.sh already looks.
    coverage = reply.get("sem_coverage")
    if coverage == "degraded":
        print(
            "WARN: semantic layer failed — results are LEXICAL-ONLY (sem_coverage=degraded)",
            file=sys.stderr,
        )

    if json_out:
        print(json.dumps(reply))
        return 0

    for h in reply.get("hits") or []:
        title = h.get("title", "")
        if h.get("related"):
            title += " ·related"
        print(f'[{h.get("score")}] {title} — {h.get("path")}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
