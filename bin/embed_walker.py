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
}
# ponytail: 128KB payload cap — larger files still get indexed via their
# 3000-char preview; the cap only bounds the sniff/read window indirectly.
MAX_BYTES = 131_072
SNIFF_BYTES = 4096

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
                        if name not in PRUNE_DIRS:
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
