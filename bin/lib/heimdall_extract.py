#!/usr/bin/env python3
"""heimdall_extract.py — per-file AST extraction bridge over vendored graphify.

Reads one or more absolute file paths from argv, writes a single JSON object to
stdout: {"results": {"<path>": {"nodes": [...], "edges": [...], "error": ...}}}

Deliberately calls graphify's per-language extractors DIRECTLY rather than
graphify.extract(), for two reasons:

  1. graphify.extract() writes a `graphify-out/cache/` directory next to the
     files it reads. Heimdall indexes the user's whole home tree, so that would
     litter every source directory it touches.
  2. Heimdall's journal already skips unchanged files by content hash. A second
     cache with its own invalidation rules is one more thing that can disagree
     with reality — the exact failure mode this whole subsystem exists to
     eliminate.

Zero model calls; tree-sitter only.
"""
import json
import os
import sys
from pathlib import Path

VENDOR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "vendor")
sys.path.insert(0, VENDOR)

# suffix -> name of the module-level extractor in graphify.extract
DISPATCH = {
    ".py": "extract_python",
    ".js": "extract_js", ".jsx": "extract_js",
    # .mts/.cts deliberately absent: vendored extract_js only selects the TS
    # grammar for .ts/.tsx — routing here would parse TS lossily under the JS
    # grammar (plausible-but-wrong symbols beat an honest L1 degrade). Add
    # them when the vendored extractor learns the suffix split.
    ".mjs": "extract_js", ".cjs": "extract_js",
    ".ts": "extract_js", ".tsx": "extract_js",
    ".go": "extract_go",
    ".rs": "extract_rust",
    ".java": "extract_java",
    ".c": "extract_c", ".h": "extract_c",
    ".cpp": "extract_cpp", ".cc": "extract_cpp", ".cxx": "extract_cpp", ".hpp": "extract_cpp",
    ".rb": "extract_ruby",
    ".cs": "extract_csharp",
    ".kt": "extract_kotlin", ".kts": "extract_kotlin",
    ".scala": "extract_scala",
    ".php": "extract_php",
    ".swift": "extract_swift",
    ".lua": "extract_lua", ".toc": "extract_lua",
    ".zig": "extract_zig",
    ".ps1": "extract_powershell",
    ".ex": "extract_elixir", ".exs": "extract_elixir",
    ".m": "extract_objc", ".mm": "extract_objc",
    ".jl": "extract_julia",
}


def extract_one(path):
    suffix = Path(path).suffix.lower()
    fn_name = DISPATCH.get(suffix)
    if fn_name is None:
        return {"nodes": [], "edges": [], "error": "unsupported-extension"}
    try:
        from graphify import extract as gx
    except Exception as exc:  # graphify or its deps unavailable
        return {"nodes": [], "edges": [], "error": "graphify-import: %s" % exc}
    fn = getattr(gx, fn_name, None)
    if fn is None:
        return {"nodes": [], "edges": [], "error": "no-extractor:%s" % fn_name}
    try:
        result = fn(Path(path))
    except Exception as exc:
        # A parse failure must never lose the file — the caller degrades this
        # path to L1 and still indexes it.
        return {"nodes": [], "edges": [], "error": "extract: %s" % exc}
    return {
        "nodes": result.get("nodes", []),
        "edges": result.get("edges", []),
        "error": result.get("error"),
    }


def main():
    out = {}
    for path in sys.argv[1:]:
        try:
            out[path] = extract_one(path)
        except Exception as exc:
            out[path] = {"nodes": [], "edges": [], "error": "bridge: %s" % exc}
    json.dump({"results": out}, sys.stdout)


if __name__ == "__main__":
    main()
