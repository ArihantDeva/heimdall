#!/usr/bin/env python3
"""embed_walker.py — max-depth $HOME file discovery for the semantic index.
Policy: everything textual under $HOME, minus junk dirs. Unknown extensions
AND dotfiles-without-ext are content-sniffed (27%+ of the corpus carries no
known extension). iCloud-evicted dataless files (st_blocks==0) are reported
separately so the indexer can make name-only cards without triggering a
multi-GB lazy download."""
from __future__ import annotations

import os
import pathlib

# Dirs never worth embedding: VCS/package/dependency/build/OS noise.
PRUNE_DIRS = {
    ".git", ".svn", ".hg", "node_modules", ".venv", "venv", "__pycache__",
    ".Trash", "Library", "Pictures", "Music", "Movies", ".cache", ".npm",
    ".cargo", ".rustup", ".ollama", ".lmstudio", "target", ".next", ".turbo",
    ".gradle", ".m2", ".cocoapods", "Pods", ".terraform", ".tox",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build", ".build",
    "DerivedData", ".expo", ".dart_tool", ".pub-cache", ".gem", ".kube",
    ".docker", ".colima", ".lima", ".orbstack",
    # Derived source that is not named venv/venv. Measured against the live
    # index (604,136 cards): site-packages 101,041 (16.7%), graphify-out
    # 55,688 (9.2%), worktrees 44,805 (7.4%), vendor 23,512 (3.9%), pipx/venvs
    # 23,539 (3.9%) -- together 34% of everything searchable. The effect on
    # recall was direct: "JWT auth middleware bearer token verification"
    # returned six vendored jwt_bearer.pyi / bearer_auth.py files and none of
    # the user's own auth_jwt.py, and 6 of 10 code golds fell outside the top
    # 100 despite every gold being present in the index exactly once.
    "site-packages", "graphify-out", "worktrees", "pipx",
}
# The five prefixes above are also in PRUNE_DIRS as basenames, which is
# correct and necessary: `worktrees` must not appear in any search result, and
# matching by basename is how that is guaranteed. It is also why a real repo
# containing a directory named `worktrees` or `vendor` would lose it -- the
# Phase 1 bench/*.py lesson, which is why the 2026-09-28 spec split the two
# mechanisms. Basename pruning here is a deliberate trade: these names are
# artifacts far more often than they are real source, and a false negative in
# the index is recoverable by re-running the build.
# Path-prefix exclusions, matched against the ABSOLUTE path (2026-09-28 spec
# E1). PRUNE_DIRS matches a BASENAME at every depth below the $HOME walk root,
# so a bare "bench" entry would prune every dir named bench on the volume --
# measured: heimdall's own bench/*.py, ~/.config/harness-truth/bench/, and
# ~/.bun/install/cache/@protobufjs/float@1.0.2@@@1/bench/ (1,230 real cards).
# These two subtrees are genuinely noise and have no such collateral:
#   /bench/runs/              162,276 cards of LongMemEval session transcripts
#   /.claude/file-history/      303 cards of superseded copies of real files
# vendor/.audit/.claire stay in PRUNE_DIRS: those names are artifacts at any
# depth and have no real-source sibling worth protecting.
PRUNE_PREFIXES = ("/bench/runs/", "/.claude/file-history/")


def _pruned_by_prefix(abs_path: str) -> bool:
    """True when `abs_path` sits under a PRUNE_PREFIXES subtree.

    Substring, not prefix-component: the caller passes a directory that may be
    any descendant, and a descendant of bench/runs/ is noise just as much as
    the subtree root is.
    """
    return any(p in abs_path for p in PRUNE_PREFIXES)
# ponytail: 128KB payload cap — larger files still get indexed via their
# 3000-char preview; the cap only bounds the sniff/read window indirectly.
MAX_BYTES = 131_072
SNIFF_BYTES = 4096

# Type-aware discovery caps (zvec-grep port, P5): known-text extensions are
# bucketed by family; each family has its own admission cap. Rationale: a
# 50MB machine-generated dump (data/log family) has near-zero retrieval value
# per embedding and pollutes k-NN — but a 5MB design doc is legitimately
# worth indexing (zg caps: code 1MiB, text 256MiB, data 16MiB). Files above
# their family cap are skipped from DISCOVERY (no card, no preview); flat
# MAX_BYTES stays as the sniff/read window for unknown-ext files.
CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go",
    ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".rb", ".php",
    ".sh", ".zsh", ".bash", ".sql", ".vue", ".svelte", ".lua", ".pl",
    ".ex", ".exs", ".erl", ".hs", ".clj", ".scala", ".dart", ".zig",
    ".nim", ".sol", ".cu", ".r", ".jl", ".tf", ".hcl", ".graphql",
    ".proto", ".ipynb",
}
DATA_EXTS = {".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
             ".env", ".xml", ".csv", ".tsv"}
DOC_EXTS = {".md", ".txt", ".rst", ".adoc", ".tex", ".html", ".css",
            ".scss"}
CAP_CODE = 1_048_576      # 1 MiB
CAP_DATA = 16_777_216     # 16 MiB
CAP_DOC = 268_435_456     # 256 MiB (zg text cap — admitted almost always)


def family_cap(name: str) -> int | None:
    """Admission cap for a known-text extension, or None if not a known ext."""
    ext = os.path.splitext(name)[1].lower()
    if ext in CODE_EXTS:
        return CAP_CODE
    if ext in DATA_EXTS:
        return CAP_DATA
    if ext in DOC_EXTS:
        return CAP_DOC
    return None

TEXT_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".java",
    ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".rb", ".php", ".sh", ".zsh",
    ".bash", ".sql", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".conf", ".html", ".css", ".scss", ".vue", ".svelte", ".tf",
    ".hcl", ".xml", ".csv", ".tsv", ".proto", ".graphql", ".ipynb", ".r",
    ".jl", ".lua", ".pl", ".ex", ".exs", ".erl", ".hs", ".clj", ".scala",
    ".dart", ".zig", ".nim", ".sol", ".cu", ".tex", ".rst", ".adoc", ".env",
}


def _looks_text(head: bytes) -> bool:
    """Content sniff: no NUL byte in the first SNIFF_BYTES => treat as text."""
    return b"\x00" not in head


def _sniff(p: pathlib.Path) -> bool:
    """Content gate for unknown-extension files (releases GIL on read)."""
    try:
        with open(p, "rb") as fh:
            return _looks_text(fh.read(SNIFF_BYTES))
    except OSError:
        return False


# Name-based skips: generated/dependency-lock noise with zero retrieval value
# (huge, duplicated across every project, pollutes k-NN with near-identical
# vectors). Everything here is text and would otherwise pass the sniffs.
SKIP_NAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
    "Pipfile.lock", "Cargo.lock", "composer.lock", "Gemfile.lock",
    "flake.lock", "bun.lockb", "deno.lock", "npm-shrinkwrap.json",
}
SKIP_SUFFIXES = {".min.js", ".min.css", ".map", ".d.ts"}
MIN_PREVIEW_CHARS = 24  # near-empty previews carry no signal worth a vector


def _name_skipped(p: pathlib.Path) -> bool:
    return p.name in SKIP_NAMES or p.name.endswith(tuple(SKIP_SUFFIXES))


def discover_files(root: pathlib.Path, graft_dirs_out=None):
    """Classify every regular file under root. Returns (text_files, dataless).

    text_files: known-text extension at ANY size (the indexer's 3000-char
    preview caps the embedding payload anyway), plus unknown-ext and dotfile
    names that pass the no-NUL sniff.
    dataless: iCloud-evicted placeholders (st_blocks==0) with plausible sizes —
    reading one would block on a cloud download, so callers index name-only.
    graft_dirs_out: optional list; receives every dir containing a graft/
    child (per-repo graph marker) so callers can enumerate searchable roots.
    """
    from concurrent.futures import ThreadPoolExecutor

    known: list[pathlib.Path] = []
    sniff_me: list[pathlib.Path] = []
    dataless: list[pathlib.Path] = []
    stack = [str(root)]
    while stack:
        dirpath = stack.pop()
        try:
            it = os.scandir(dirpath)
        except OSError:
            continue
        with it:
            for e in it:
                name = e.name
                try:
                    if e.is_symlink():
                        continue
                    if e.is_dir(follow_symlinks=False):
                        if name == "graft" and graft_dirs_out is not None:
                            graft_dirs_out.append(pathlib.Path(e.path).parent)
                        if name not in PRUNE_DIRS and not _pruned_by_prefix(e.path):
                            stack.append(e.path)
                        continue
                    if not e.is_file(follow_symlinks=False):
                        continue
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                p = pathlib.Path(e.path)
                if st.st_blocks == 0:
                    # Dataless placeholder: stat lies about size, read blocks.
                    if 0 < st.st_size <= MAX_BYTES:
                        dataless.append(p)
                    continue
                if st.st_size == 0:
                    continue
                if _name_skipped(p):
                    continue
                cap = family_cap(name)
                if cap is not None:
                    # Type-aware admission (P5): known-text families get their
                    # own cap; oversize machine-generated dumps are skipped.
                    if st.st_size <= cap:
                        known.append(p)
                    continue
                if os.path.splitext(name)[1].lower() in TEXT_EXTS:
                    known.append(p)
                else:
                    sniff_me.append(p)

    n = min(16, os.cpu_count() or 4)
    kept: list[pathlib.Path] = []
    with ThreadPoolExecutor(max_workers=n) as ex:
        for p, is_text in zip(sniff_me, ex.map(_sniff, sniff_me, chunksize=256)):
            if is_text:
                kept.append(p)
    return sorted(known + kept), sorted(dataless)


def read_preview(p: pathlib.Path, limit: int = 3000) -> str:
    """Text preview used as the embedding payload."""
    try:
        return p.read_text(encoding="utf-8", errors="replace")[:limit]
    except OSError:
        return ""
