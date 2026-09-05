#!/usr/bin/env python3
"""embed-index stub for kb-search verdict-gate tests.
Emits one semantic hit whose path exists in the sandbox but whose title/body
match NO query token — the exact F1 case: semantic + zero lexical coverage
must stay WEAK, never STRONG. Path comes from FAKE_SEMANTIC_PATH."""
import os
import sys

args = sys.argv[1:]
n = int(args[args.index("-n") + 1]) if "-n" in args else 5
q = next((a for a in args if not a.startswith("-") and a != str(n)), "")
path = os.environ.get("FAKE_SEMANTIC_PATH", "/nonexistent/zznomatch.py")
title = os.environ.get("FAKE_SEMANTIC_TITLE", "zzunrelated words")
print(f"[0.99] {title} — {path}")
