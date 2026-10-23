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
    "site-packages", "graphify-out", "worktrees", ".worktrees", "pipx",
    # Found by auditing the index AFTER the rebuild, i.e. by asking "what is
    # still large and clearly not authored work". Both are tool state that
    # happens to live outside the usual dotdirs the rules above already cover:
    #   .hypothesis  pytest's example DB (equitylens/.hypothesis, 1,318 files)
    #   .lunarclient a Minecraft launcher install (~/.lunarclient/shared — jre,
    #                game-cache, assets/skins/*, jit; 1,477 files)
    ".hypothesis", ".lunarclient",
    # Any-depth name prunes: these are agent/harness scratch dirs that appear
    # inside project trees, not only under $HOME, so a $HOME-anchored prefix
    # cannot reach them. Measured 2026-10-15: 1,935 files of subagent transcripts
    # and briefs sat in per-project .pi-subagents/ copies (1,073 in one Desktop
    # project, 193 in arihantdeva-content, 104 in a Repos repo) while the rule
    # only covered ~/.pi-subagents. Basename matching is the correct instrument
    # here because the directory NAME is the artifact marker.
    ".pi-subagents",
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

# $HOME-anchored exclusions (2026-10-15).
#
# PRUNE_DIRS matches a BASENAME at any depth, which is the wrong instrument here:
# a real project directory called `telemetry`, `install` or `plugins` is source,
# while `~/.claude/telemetry` is machine exhaust. These entries are therefore
# matched against the path RELATIVE TO THE WALK ROOT ($HOME), so they only fire
# for the specific tool tree they name and can never eat a project's own dirs.
#
# Why they exist: a live audit of the index (99,302 cards) found the user's own
# source was 0 cards under ~/Repos, ~/projects and ~/arihantdeva-content, while
# 83,150 cards (84% of everything searchable) were toolchain caches, plugin
# marketplaces, harness session logs and telemetry:
#     .pi/agent 19,322   .local/share 11,682   .claude/telemetry 9,258
#     .bun/install 6,183 .vscode/extensions 5,904  .local/lib 5,587
#     .claude/plugins 5,481  .codex/.tmp 4,977  .pi-subagents 4,146
#     .openhands 3,359   .claude/archive 2,618  .nvm 2,613  .claude/jobs 2,020
# Retrieval is a claim about what is WORTH finding; none of these are authored
# work, and their near-duplicate vectors crowd the real content out of k-NN.
#
# Deliberately NOT included: .pi/agent/sessions — spec P3 keeps session logs as a
# fact source, so only the REST of .pi/agent is excluded. The rule for
# .pi/agent/ is written as a prefix that excludes "sessions/" explicitly.
HOME_PRUNE_PREFIXES = (
    ".local/share/",
    ".local/lib/",
    ".claude/telemetry/",
    ".claude/plugins/",
    ".claude/jobs/",
    ".claude/archive/",
    ".claude/file-history/",
    ".bun/",
    ".vscode/extensions/",
    ".codex/.tmp/",
    ".openhands/",
    ".nvm/",
    # `.pi-subagents` is excluded at ANY depth, not just under $HOME. Measured
    # 2026-10-15: 1,935 files / 2,386 cards live in PER-PROJECT copies that a
    # $HOME-anchored rule cannot see — .claude/.pi-subagents (1,073 under one
    # Desktop project alone), arihantdeva-content/.pi-subagents (193),
    # Repos/shepherd-mvo-engine (104), Repos/Pi-Bolt/.work/plugins (102).
    # Content is subagent transcripts and *_input.md/*_output.md briefs: the
    # agent's own scratch, never authored source. It is listed in HOME_PRUNE_*
    # for the $HOME copy AND in ANAME_PRUNE below for every nested one.
    ".pi-subagents/",
    ".pi/tmp/",                          # harness scratch — measured: held a stale
                                          # Sep-16 COPY OF THE HEIMDALL REPO (289
                                          # cards) that out-ranked the live source
                                          # it was copied from. Distinct from
                                          # .pi/agent/, which is handled below with
                                          # its sessions/ carve-out.
    "heim-build-check/package/",         # extraction of arihantdeva-heimdall-0.12.2.tgz
                                          # — an OLD 0.12.2 build whose mtimes are
                                          # stamped 1985-10-26 by npm's tarball
                                          # normalization. 680 cards, identical
                                          # content to .pi/tmp/sim1 (both sha
                                          # 397f7010cd58), and it ranked ABOVE
                                          # live source for "reconciler single
                                          # writer". The 1985 mtimes also render as
                                          # as_of=14963.9d in search output.

    # Generated-data classes, measured 2026-10-15.
    # The walk discovers 432,523 files under $HOME while the previous index held
    # only 99,303 cards, so the earlier build never finished its walk — that, not
    # a filtering rule, is why ~/Repos had 0 cards. Excluding the tool trees above
    # is necessary but not sufficient: six generated classes then account for
    # 232k files (54% of everything discoverable). Each entry below is anchored
    # to $HOME and is derived data, evidenced by volume vs. tracked-file count.
    "go/pkg/mod/",                       # GOPATH module cache — 46,947, zero authored
    "backups/",                           # dated machine-state snapshots — 44,581
    "Documents/curseforge/",              # game installs — 18,618
    "Desktop/Code Projects/Lumina/_work/",  # scraped page dumps — 30,366 ($HOME-anchored so a
                                          # project's own _work/ is untouched). Path moved from
                                          # Desktop/Lumina/ on 2026-10-16 desktop reorg.
    "equitylens/research/hyperagent-sales-prospector/data/",  # 119,530 generated
                                          # llm_queue/locks/mx_cache rows; 1 file tracked in git
    "equitylens/data/vendor/",            # 18,443 vendored third-party tree
    "arihantdeva-content/.pi/workflows/",          # gitignored workflow state — 8,423
    "arihantdeva-content/.pi/workflow-subagents/",  # gitignored workflow state — 2,938
)


# .pi/agent is excluded EXCEPT its sessions/ fact source, so it cannot be a plain
# prefix in the tuple above (a tuple entry would also drop sessions/).
HOME_PRUNE_EXCEPT = ((".pi/agent/", (".pi/agent/sessions/",)),)


def _pruned_by_prefix(abs_path: str) -> bool:
    """True when `abs_path` sits under, or IS, a PRUNE_PREFIXES subtree.

    Component-boundary matched. A plain substring test cannot match the subtree
    ROOT, because the entries carry a trailing slash: `"/bench/runs/" in
    "/x/bench/runs"` is False, so the directory itself survived the test while its
    children passed it. That asymmetry is what let the walk and the policy
    predicate disagree (adversarial review 2026-10-15).
    """
    s = abs_path.replace(os.sep, "/")
    for p in PRUNE_PREFIXES:
        e = p.rstrip("/")
        if s == e or s.endswith(e) or f"{e}/" in s:
            return True
    return False


def _pruned_by_home_prefix(abs_path: str, walk_root: str) -> bool:
    """True when `abs_path` sits under an excluded $HOME tool tree.

    Matched on the path RELATIVE to the walk root, so it is anchored: the rule
    `".claude/telemetry/"` fires for $HOME/.claude/telemetry but NOT for
    <repo>/claude/telemetry or any project directory of the same name. That is
    the whole reason this is separate from PRUNE_DIRS — basename matching would
    delete real source, and losing a real repo is far worse than indexing noise.

    Carve-outs are checked FIRST and apply to the path itself as well as to any
    ancestor, so descending INTO ~/.pi/agent does not prune ~/.pi/agent/sessions.
    """
    try:
        rel = os.path.relpath(abs_path, walk_root)
    except ValueError:  # different drive (Windows); not our platform, skip
        return False
    if rel.startswith(".."):
        return False
    rel = rel.replace(os.sep, "/")  # forward slashes so the tuple reads uniformly

    for prefix, excepts in HOME_PRUNE_EXCEPT:
        if rel == prefix.rstrip("/") or rel.startswith(prefix):
            # The carve-out protects the excepted subtree AND its ancestors: if
            # this path is an ancestor of a carve-out (exactly ~/.pi/agent when
            # the carve-out is ~/.pi/agent/sessions/) it must NOT be pruned, or
            # the walk never descends far enough to reach the carve-out at all.
            if any(rel.startswith(x) or x.startswith(rel + "/") for x in excepts):
                return False
            return True

    return any(rel == p.rstrip("/") or rel.startswith(p) for p in HOME_PRUNE_PREFIXES)
# ponytail: 128KB payload cap — larger files still get indexed via their
# 3000-char preview; the cap only bounds the sniff/read window indirectly.
# Credential material: paths whose CONTENTS are secrets, never retrievable text.
#
# Why this is a separate list from SKIP_NAMES (measured 2026-10-15, read-only audit):
#   `kb_search "ssh private key ed25519 openssh"` returned ~/.ssh/id_ed25519 and
#   three sibling private keys as STRONG hits. The stored card body was 411 chars
#   containing the OpenSSH PEM header plus 5 key-material lines — the COMPLETE key.
#   Search output is sent to third-party model providers, so a served card is an
#   exfiltration path. 252 cards carried a credential-shaped string.
#
# This is PRE-EXISTING, not a regression: at git HEAD no exclusion list covered
# any of these paths.
#
# Deliberately NOT SKIP_NAMES, because the matching has to be partial in both
# directions and a bare basename/suffix rule gets both wrong:
#   - `.env` is in DATA_EXTS and is legitimately indexed as `.env.example`,
#     `.env.sample`, `.env.template` (templates carry no secret and are the
#     documented way to configure a project — excluding them removes real source)
#   - `*.key` would swallow `key-rotation.md`; `*.pub` must stay (not a secret)
#   - `.ssh/` must exclude private keys but keep `config` out only where it is a
#     credential lens, and must never swallow a repo directory named `.ssh`
CREDENTIAL_BASENAMES = {
    ".netrc", ".npmrc", ".pypirc", ".git-credentials",
    "auth.json", ".htpasswd", "secring.gpg",
}
# Matched as a path SEGMENT, so a repo's own `secrets/` directory is not pruned by
# name (only the credential stores below are).
CREDENTIAL_PATH_SEGMENTS = (
    "/.ssh/", "/.aws/", "/.gnupg/", "/.docker/", "/.kube/",
    "/.config/gh/", "/.config/gcloud/", "/.terraform.d/",
)
CREDENTIAL_SUFFIXES = (".pem", ".p12", ".pfx", ".jks", ".keystore", ".key")
# Templates are NOT secrets: the suffix must be present but the name must not end
# in one of these markers.
ENV_TEMPLATE_MARKERS = (".example", ".sample", ".template", ".dist", ".defaults")


def _is_credential_path(abs_path: str) -> bool:
    """True when the path holds secret material that must never be indexed.

    Reads only the path, never the file: a rule that needed the contents would
    have to open the very file it is trying to keep out of the index.
    """
    s = abs_path.replace(os.sep, "/")
    name = os.path.basename(s)
    lower = name.lower()

    # A public key is not a secret, and it is the one file family inside ~/.ssh
    # that is safe and useful to index.
    if lower.endswith(".pub"):
        return False
    if lower in CREDENTIAL_BASENAMES:
        return True
    # auth.json.bak.20261012-1400, auth.json.bak — the backups carry the same
    # credentials as the file they back up, and were measured serving.
    if lower.startswith(tuple(b + "." for b in CREDENTIAL_BASENAMES)):
        return True
    # `.env` and every generated variant (`.env.local`, `.env.production.local`,
    # `.vercel/.env.production.local`) EXCEPT the checkable-in templates.
    if name.startswith(".env") or "/.env" in s:
        return not lower.endswith(ENV_TEMPLATE_MARKERS)
    if lower.endswith(CREDENTIAL_SUFFIXES):
        return True
    if any(seg in s for seg in CREDENTIAL_PATH_SEGMENTS):
        # ~/.ssh/config is a credential lens (it names every host and identity),
        # so it goes too. The .pub carve-out above already handled public keys.
        return True
    return False


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
    return (p.name in SKIP_NAMES or p.name.endswith(tuple(SKIP_SUFFIXES))
            or _is_credential_path(str(p)))


def should_exclude_path(abs_path: str, walk_root: str = None) -> bool:
    """True when `abs_path` is excluded by policy, whatever is on disk.

    The discovery walk prunes DIRECTORIES as it descends, so it can never answer
    "is this already-indexed row excluded?" for a whole path. This predicate can,
    and it exists so an exclusion can be applied to existing rows cheaply — see
    embed_index._purge_policy_excluded, which runs before the walk so a killed
    build still leaves the index policy-consistent.

    It reuses the same rules as discovery rather than restating them, because two
    copies of a policy drift: `walk_root` defaults to $HOME so the anchored
    rules behave exactly as they do during a build.
    """
    p = pathlib.Path(abs_path)
    if walk_root is None:
        walk_root = str(pathlib.Path.home())
    # Credential material is checked FIRST and independently of the tree rules:
    # a secret is a secret whether it sits in $HOME, in a repo, or in a directory
    # whose name looks like ordinary source. Measured: 8 *.key under ~/Downloads
    # and ~/Desktop plus 40 real .env files inside repos, none of which any
    # tree-shaped rule reaches.
    if _is_credential_path(abs_path):
        return True
    # Any component matching a basename prune excludes the path. Checked per
    # component because the walk prunes the DIRECTORY, and any row beneath it is
    # therefore excluded too.
    if any(part in PRUNE_DIRS for part in p.parts):
        return True
    if _pruned_by_home_prefix(abs_path, walk_root):
        return True
    if _pruned_by_prefix(abs_path):
        return True
    return _name_skipped(p)


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
                        # $HOME-anchored tool-tree exclusion, checked BEFORE the
                        # basename rules: it is anchored, so it is safe for names
                        # that are also legitimate inside a project.
                        if _pruned_by_home_prefix(e.path, str(root)):
                            continue
                        if name not in PRUNE_DIRS and not _pruned_by_prefix(e.path):
                            stack.append(e.path)
                        continue
                    if not e.is_file(follow_symlinks=False):
                        continue
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                p = pathlib.Path(e.path)
                # Policy is applied to FILES as well as to directories, through
                # the same predicate the retroactive purge uses. The walk used to
                # check these rules only while descending, so any file sitting
                # directly in (or under) a pruned-but-not-descended-into tree was
                # admitted anyway — measured: ~/.pi/agent/auth.json (a credential
                # store) and 2 bench/runs/*.md were indexed while
                # should_exclude_path() correctly rejected them.
                if _pruned_by_home_prefix(e.path, str(root)) or _pruned_by_prefix(e.path):
                    continue
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
