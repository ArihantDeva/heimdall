#!/usr/bin/env python3
"""kb_search_verify.py — path extraction for stale-node rehoming.

extract_paths() is the shared path-anchor logic: bin/kb-stale-scan.py imports it
so the stale scan and search agree on which home-anchored paths a node names.

Historically this module also held a `graft retrieve` verdict CLI; that path
targets the retired global daemon API, nothing invoked it, and it was deleted.
Live verdicts are computed in-process by bin/kb-search.sh.
"""
import os, re

HOME = os.path.expanduser("~")
# Home-anchored forms: ~/... shorthand and the /Users/<name>/... absolute form
# (macOS layout; on Linux HOME itself is the anchor, e.g. /home/runner).
# The older "~?/Users/..." pattern could never match "~/..." because a literal
# tilde sits where the optional prefix expects the abs prefix.
_HOME_ABS = "/Users/" if os.path.isdir("/Users") else HOME + "/"
HOME_RE = re.compile(r"~/[^\s\"]+|" + re.escape(_HOME_ABS) + r"[^\s\"]+")


def extract_paths(text):
    """All home-anchored paths (~/... or /Users/<name>/...; the /var/folders
    temp-tree is excluded — it is not home-anchored) in prose, resolved to
    existing paths only. Handles: prose labels before paths ("Package
    '~/a/b'", cprune preview=\"/a/b ...\"), spaces inside dir names
    ("Shepherd Ventures", "burner (Sep 2024)"), apostrophes, brace groups
    ("~/.pi/x.{md,yaml}"), and trailing punctuation after the path."""
    paths = []
    for m in HOME_RE.finditer(text):
        tok = os.path.expanduser(m.group(0)).rstrip(".,;:\"").rstrip("'")
        # brace groups: ~/x.{md,yaml} -> each alternative tried separately
        cands = [tok]
        if "{" in tok:
            pre, _, post = tok.partition("{")
            inner, _, rest = post.partition("}")
            cands = [pre + alt + rest for alt in inner.split(",")]
        for base in cands:
            # extend across spaces while the extended path exists (dir names
            # with spaces: "TypeE Winners Package - George 08-15") — longest
            # existing wins, prose never gets glued on.  No per-word rstrip:
            # ")" / "." are part of real names ("burner (Sep 2024)").
            rest_text = text[m.end():]
            words = rest_text.split()
            best = base
            for k in range(1, min(len(words), 8) + 1):
                cand = (base + " " + " ".join(words[:k])).rstrip(".,;:")
                if os.path.exists(cand):
                    best = cand
                # no break: "Connections Enrichment KB" needs k=3 but k=1..2
                # don't exist — only a longest-existing match wins
            if os.path.exists(best):
                if best not in paths:
                    paths.append(best)
            elif base not in paths:
                # unresolvable token (reorg'd-away / case-variant): return it so
                # the stale scan can flag/rehome/remove it
                paths.append(base)
    # absolute fallback: any home-anchored token (e.g. quoted inside JSON, or
    # a path under a different home root than this machine's HOME) not already
    # caught by HOME_RE. The whole-token rstrip is safe here because the loop
    # above already extended through spaces when the long form resolved.
    if not paths:
        for m in re.finditer(re.escape(_HOME_ABS) + r"[^\s\"]+", text):
            tok = m.group(0).rstrip(".,;:")
            if tok.startswith(_HOME_ABS) and tok not in paths:
                paths.append(tok)
    return paths
