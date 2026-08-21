#!/usr/bin/env python3
"""kb_search_verify.py — verify + enrich graft retrieve results so agents can trust them.
Input: argv[1]=retrieve JSON  [2]=label  [3]=scope  [4]=N  [5]=query
Per candidate: fetch full node (body), lexical coverage vs query tokens, path existence.
Output: ranked lines — verdict (STRONG/WEAK/STALE/NOPATH), coverage %, path, title, score.
"""
import json, os, re, subprocess, sys, tempfile, time

STOP = {
    "the", "and", "for", "with", "from", "that", "this", "have", "are", "was",
    "you", "your", "not", "but", "its", "all", "can", "has", "had", "she",
    "her", "him", "his", "our", "their", "them", "who", "whom", "which",
    "what", "when", "where", "why", "how", "into", "than", "then", "they",
}


def toks(s):
    return set(
        t for t in re.findall(r"[a-zA-Z0-9_\-\./]{3,}", (s or "").lower())
        if t not in STOP
    )


def get_node(id_hex):
    # selftest:<path> ids bypass the daemon: body is read straight from disk so
    # content-aware verdicts are testable without graft running.
    if id_hex.startswith("selftest:"):
        path = id_hex[len("selftest:"):].rsplit(":", 1)[0]
        try:
            with open(path, "r", errors="replace") as f:
                return {"body": f.read(262144), "title": os.path.basename(path)}
        except Exception:
            return {"body": "", "title": ""}
    try:
        out = subprocess.run(
            ["graft", "get", id_hex], capture_output=True, text=True, timeout=15
        ).stdout
        return (json.loads(out).get("result") or {})
    except Exception:
        return {}


HOME = os.path.expanduser("~")
HOME_RE = re.compile(r"~?" + re.escape(HOME + "/") + r"[^\s\"]+")


def extract_paths(text):
    """All home-anchored paths (/Users/... or ~/...) in prose, resolved to
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
    if not paths:
        # absolute fallback: any /Users/... token (e.g. quoted inside JSON)
        for m in re.finditer(r"/Users/[^\s\"]+", text):
            tok = m.group(0).rstrip(".,;:")
            if tok.startswith("/Users/") and tok not in paths:
                paths.append(tok)
    return paths


def handle_stale(id_hex, title, path, body):
    """STALE node: anchor path is gone. Desktop gets reorganized aggressively, so
    first try a deterministic rehome (kb-rehome.sh — bounded basename search in
    known roots; exactly one hit → rebuild the node with the corrected path).
    If truly gone or ambiguous: append the full node to stale-removals.log
    (recoverable), then delete it so dead anchors stop ranking.
    Returns (verdict, path_or_newpath)."""
    bodyf = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".body", delete=False) as f:
            f.write(body or "")
            bodyf = f.name
        r = subprocess.run(
            [os.path.expanduser("~/knowledge-base/kb-rehome.sh"), id_hex, path, title or "", bodyf],
            capture_output=True, text=True, timeout=25,
        )
        out = r.stdout.strip()
    except Exception:
        out = "NOTFOUND"
    finally:
        if bodyf:
            try:
                os.unlink(bodyf)
            except OSError:
                pass
    if out.startswith("REBUILT "):
        return "REBUILT", out.split(" ", 1)[1]
    log = os.path.expanduser("~/knowledge-base/stale-removals.log")
    try:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(log, "a") as f:
            f.write(f"{stamp} | {id_hex} | {path} | {out}\n  title: {title}\n  body: {(body or '').replace(chr(10), ' ⏎ ')}\n")
    except Exception:
        pass
    try:
        subprocess.run(["graft", "delete", id_hex], capture_output=True, text=True, timeout=15)
        return "REMOVED", path
    except Exception:
        return "STALE", path


def content_score(path, query_tokens):
    """Lexical coverage of query tokens against the anchored file's content.
    None = cannot read (binary/missing/oversized) -> fall back to path+body
    verdict only. Caps read at 256KB."""
    if not path or not query_tokens:
        return None
    try:
        if os.path.getsize(path) > 262144:
            return None
        with open(path, "rb") as f:
            raw = f.read(262144)
        if b"\x00" in raw[:1024]:
            return None
        text = raw.decode("utf-8", errors="replace").lower()
        return sum(1 for t in query_tokens if t in text) / len(query_tokens)
    except OSError:
        return None


def main():
    try:
        r_ = json.loads(sys.argv[1]).get("result") or {}
        res = r_.get("results") or r_.get("nodes") or []
    except Exception:
        res = []
    label = sys.argv[2]
    scope = sys.argv[3]
    try:
        N = max(0, int(sys.argv[4]))
    except ValueError:
        N = 6
    query = sys.argv[5] if len(sys.argv) > 5 else ""
    qt = toks(query)

    if scope:
        res = [r for r in res if scope.lower() in ((r.get("title") or "") + " " + (r.get("body") or "")).lower()]
    clean = [r for r in res if "unclassified" not in (r.get("title") or "").lower()
             and "auto-sync" not in (r.get("title") or "").lower()]
    if clean:
        res = clean
    if res:
        top = max(abs(r.get("score", 0)) for r in res)
        res = [r for r in res if abs(r.get("score", 0)) >= top * 0.3]
    if N == 0 or not res:
        print("  (no %s)" % label)
        return

    rows = []
    for r in res[: max(N * 2, 8)]:
        node = get_node(r.get("id_hex") or "")
        node.update(r)
        title = node.get("title") or ""
        body = node.get("body") or ""
        hay = (title + " " + body).lower()
        cov = (sum(1 for t in qt if t in hay) / len(qt)) if qt else 0.0
        paths = extract_paths(body or title)
        # selftest ids anchor the path explicitly — trust it over prose extraction
        if (r.get("id_hex") or "").startswith("selftest:"):
            paths = [r["id_hex"][len("selftest:"):].rsplit(":", 1)[0]]
        alive = [p for p in paths if os.path.exists(p)]
        path = alive[0] if alive else (paths[0] if paths else "")
        if alive:
            cs = content_score(path, qt)
            eff = cs if cs is not None else cov
            verdict = "STRONG" if eff >= 0.5 else "WEAK"
        elif paths:
            verdict = "STALE"
        else:
            verdict = "NOPATH"
        if verdict == "STALE" and r.get("id_hex"):
            # Deterministic self-heal: rehome if the file moved, else log + delete.
            verdict, path = handle_stale(r["id_hex"], title, path, body)
        vrank = {"STRONG": 0, "REBUILT": 0, "WEAK": 1, "STALE": 2, "REMOVED": 2, "NOPATH": 3}[verdict]
        # Sort primarily by the daemon's semantic score (it already captures semantic
        # similarity; cov/verdict is a trust label, not a relevance ranking). Verdict
        # only breaks ties. This keeps the true STRONG hit on top instead of burying
        # it under a junk node whose tokens happen to lexically overlap.
        rows.append((-(r.get("score") or 0), vrank, verdict, cov, path, title, cs if alive else None))

    # dedupe by path — prefer the non-auto-sync ("edited") node for the same path
    seen = {}
    for row in rows:
        key = row[4] or row[5]
        if key not in seen:
            seen[key] = row
        elif "edited" not in row[5].lower() and "edited" in seen[key][5].lower():
            seen[key] = row
    rows = sorted(seen.values(), key=lambda x: (x[0], x[1]))[:N]

    print("  [%s — verified: STRONG=lex+path, REBUILT=path moved+node rebuilt, WEAK=semantic-only, STALE=path gone (auto-removed), REMOVED=deleted just now]" % label)
    for i, (vrank, nsc, verdict, cov, path, title, cs) in enumerate(rows):
        p = ("  " + path) if path else ""
        cs_s = " content:%d%%" % int(cs * 100) if cs is not None else ""
        print("  %2d. [%-6s] cov%02d%%%s  %s — %s" % (i + 1, verdict, int(cov * 100), cs_s, p, title))


if __name__ == "__main__":
    main()
