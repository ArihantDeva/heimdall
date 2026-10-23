#!/usr/bin/env python3
"""query-shim.py — thin client for the warm query worker (bin/query-server.py).

Prints EXACTLY what `embed-index.py query <q> -n N --related` prints:

    [{score}] {title} — {path}
    [{score}] {title} ·related — {path}

so kb-search.sh's parser needs no branch. The shim only rewrites transport.

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
    # --fused asks the worker for the combined lexical+semantic search instead of
    # semantic-only. kb-search.sh uses it to replace its 99-repo graft fan-out
    # with one warm round trip; plain `query` keeps the old semantic behaviour
    # for callers that only want that leg.
    fused = "--fused" in argv
    argv = [a for a in argv if a != "--fused"]
    # --kind/--scope are accepted so a scoped search stays scoped. The worker
    # narrows on `scope` as a path substring, matching the old --scope contract.
    kind = None
    scope = None
    for flag, name in (("--kind", "kind"), ("--scope", "scope")):
        if flag in argv:
            try:
                val = argv[argv.index(flag) + 1]
            except IndexError:
                print(f"query-shim: {flag} requires a value", file=sys.stderr)
                return 1
            if name == "kind":
                kind = val
            else:
                scope = val
            i = argv.index(flag)
            argv = argv[:i] + argv[i + 2:]

    q = argv[0] if argv else ""
    if not q.strip():
        print("query-shim: empty query", file=sys.stderr)
        return 1
    n = 5
    related = "--related" in argv
    if "-n" in argv:
        try:
            n = int(argv[argv.index("-n") + 1])
        except (IndexError, ValueError):
            print("query-shim: -n requires an integer", file=sys.stderr)
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

    for h in reply.get("hits") or []:
        title = h.get("title", "")
        if h.get("related"):
            title += " ·related"
        print(f'[{h.get("score")}] {title} — {h.get("path")}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
