#!/usr/bin/env bash
# kb-search.sh — ranked knowledge search across per-repo graft graphs.
#
# The current @nanonets/graft product is a per-repo code-graph builder: each
# repo gets `graft build`, and retrieval is `graft ask --json`. This script
# iterates the configured repo roots, runs `graft ask` on each, merges the
# JSON hits, and feeds the merged shape to kb_search_verify.py for trust
# verdicts.
#
# Usage:
#   kb-search "<query>" [-n N] [--scope S] [--no-explore]
#   HEIMDALL_REPOS="~/Repos/a:~/Repos/b" kb-search "query"   # override roots
set -u
Q="${1:?usage: kb-search \"<query>\" [-n N] [--scope S] [--no-explore]}"
shift
N=6
SCOPE=""
while [ $# -gt 0 ]; do
	case "$1" in
		-n) [ $# -ge 2 ] && { N="${2:-6}"; shift 2; } || { N=6; shift; } ;;
		--scope) [ $# -ge 2 ] && { SCOPE="${2:-}"; shift 2; } || shift ;;
		--no-explore) shift ;;
		*) shift ;;
	esac
done

SELF="$(readlink -f "$0" 2>/dev/null || python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd -P)"
VERIFY="$SCRIPT_DIR/kb_search_verify.py"
[ -f "$VERIFY" ] || VERIFY="$HOME/knowledge-base/kb_search_verify.py"

GRAFT="${GRAFT:-$(command -v graft 2>/dev/null || echo "$HOME/.local/bin/graft")}"

print_results() {
	[ -f "$VERIFY" ] || { echo "ERROR: verify script missing: $VERIFY"; exit 1; }
	python3 "$VERIFY" "$1" "$2" "$SCOPE" "$N" "$Q"
}

echo "== ask (per-repo graft): $Q"
if [ ! -x "$GRAFT" ]; then
	echo "ERROR: graft binary not found at $GRAFT (set GRAFT=/path/to/graft). Install: npm i -g @nanonets/graft"
	exit 1
fi

# Repo roots: env override, else ~/Repos (expand ~). Colon-separated.
if [ -n "${HEIMDALL_REPOS:-}" ]; then
	REPOS="${HEIMDALL_REPOS//\~/$HOME}"
	IFS=':' read -ra REPO_LIST <<< "$REPOS"
else
	REPO_LIST=()
	if [ -d "$HOME/Repos" ]; then
		for d in "$HOME"/Repos/*/; do
			[ -d "${d%/}/graft" ] && REPO_LIST+=("${d%/}")
		done
	fi
fi

if [ ${#REPO_LIST[@]} -eq 0 ]; then
	echo "ERROR: no repos with a graft graph found under ~/Repos. Run: cd <repo> && graft build"
	exit 1
fi

# Merge JSON hits from every repo into one JSON array shaped like graft
# retrieve results: {result:{results:[{title,score,id_hex}]}} with paths.
python3 - "$Q" "$N" "${REPO_LIST[@]}" <<'PYEOF'
import json, os, subprocess, sys

q = sys.argv[1]
n = int(sys.argv[2])
repos = sys.argv[3:]
graft = os.environ.get("GRAFT", "graft")
results = []
for repo in repos:
    try:
        out = subprocess.run([graft, "ask", q, repo, "--json", "-n", str(n)],
                             capture_output=True, text=True, timeout=60).stdout
        data = json.loads(out)
        for h in data.get("hits", []):
            pointer = h.get("pointer", "")
            # pointer is file:line or symbol · function — resolve to the file
            fname = pointer.split(":")[0]
            full = os.path.join(repo, fname)
            results.append({
                "id_hex": f"graft-{repo}-{pointer}",
                "title": h.get("title", ""),
                "score": float(h.get("score", 0)),
                "body": f"{h.get('snippet','')} [{full}]",
                "path": full,
            })
    except Exception:
        continue
# dedupe by title, keep top score
seen = {}
for r in sorted(results, key=lambda x: -x["score"]):
    seen.setdefault(r["title"], r)
merged = sorted(seen.values(), key=lambda x: -x["score"])[:n]

# Verdict pass: STRONG if path exists on disk + lexical coverage of query,
# WEAK if path exists, NOPATH/STALE otherwise. (Replaces kb_search_verify.py,
# which was built around the old daemon's `graft get`.)
q_toks = set(q.lower().split())
for i, r in enumerate(merged, 1):
    p = r["path"]
    exists = os.path.exists(p)
    title_l = r["title"].lower()
    body_l = r["body"].lower()
    cov = 0.0
    if q_toks:
        matched = 0
        for tok in q_toks:
            if tok in title_l or tok in body_l or tok in p.lower():
                matched += 1
        cov = round(matched / len(q_toks), 2)
    verdict = "STRONG" if exists and cov >= 0.5 else ("WEAK" if exists else "NOPATH")
    print(f"{i:>2}. [{verdict:<6}] cov{int(cov*100):02d}%  {p}")
    print(f"      {r['title']}")
PYEOF
