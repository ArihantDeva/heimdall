#!/usr/bin/env bash
# kb-search.sh — ranked knowledge search across per-repo graft graphs.
#
# Backends (resolution: $HEIMDALL_BACKEND > ~/.heimdall/config.json "backend"
# > default "graft"):
#   graft      — per-repo @nanonets/graft code graphs (`graft ask --json`),
#                merged with the global bge-m3 semantic layer. Zero-config
#                default.
#   mnemosyne  — mnemosyne-oss CLI memory store (`mnemosyne recall <q> <k>
#                --json`). Set MNEMOSYNE=/path/to/bin to pin the binary;
#                results map into the same ranked/verified output.
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

export GRAFT="${GRAFT:-$(command -v graft 2>/dev/null || echo "$HOME/.local/bin/graft")}"
MNEMOSYNE="${MNEMOSYNE:-$(command -v mnemosyne 2>/dev/null || echo "$HOME/.local/bin/mnemosyne")}"
BACKEND="${HEIMDALL_BACKEND:-}"
if [ -z "$BACKEND" ] && [ -f "$HOME/.heimdall/config.json" ]; then
	BACKEND=$(python3 -c 'import json,os,sys;
try: print(json.load(open(os.path.expanduser("~/.heimdall/config.json"))).get("backend","graft"))
except Exception: print("graft")' 2>/dev/null || echo graft)
fi
BACKEND="${BACKEND:-graft}"

run_mnemosyne() {
	if [ ! -x "$MNEMOSYNE" ]; then
		echo "Mnemosyne backend selected but binary not found at $MNEMOSYNE. Install: pip install mnemosyne-memory (or uv pip install mnemosyne-memory), or set MNEMOSYNE=/path/to/mnemosyne. Falling back would need graft — set HEIMDALL_BACKEND=graft for the default code-graph search."
		exit 0
	fi
	python3 - "$Q" "$N" "$MNEMOSYNE" <<'PYEOF'
import json, os, subprocess, sys

q = sys.argv[1]
n = int(sys.argv[2])
mnemo = sys.argv[3]
results = []
try:
    out = subprocess.run([mnemo, "recall", q, str(n), "--json"],
                         capture_output=True, text=True, timeout=90).stdout
    data = json.loads(out)
except Exception as e:
    print(f"WARN: mnemosyne recall failed: {e}", file=sys.stderr)
    data = {}
for r in (data.get("results") or []):
    try:
        content = str(r.get("content", ""))
        # Home-anchored paths in the content drive the same verdict logic as
        # graft hits; memories without paths still rank via title coverage.
        path = next((tok for tok in content.replace('"', ' ').split()
                     if tok.startswith("~/") or tok.startswith("/Users/") or tok.startswith("/home/")), "")
        results.append({
            "id_hex": f"mnemo-{r.get('id', '?')}",
            "title": content[:120],
            "score": float(r.get("score", 0)),
            "body": f"memory [{path or 'no-path'}] {content}",
            "path": os.path.expanduser(path) if path else "/nonexistent-mnemosyne-memory",
        })
    except (TypeError, ValueError) as e:
        print(f"WARN: skipping malformed memory result: {e}", file=sys.stderr)
q_toks = set(q.lower().split())
for i, r in enumerate(sorted(results, key=lambda x: -x["score"])[:n], 1):
    p = r["path"]
    exists = os.path.exists(p)
    blob = (r["title"] + " " + r["body"] + " " + p).lower()
    cov = round(sum(1 for t in q_toks if t in blob) / len(q_toks), 2) if q_toks else 0.0
    verdict = "STRONG" if exists and cov >= 0.5 else ("WEAK" if exists else "NOPATH")
    print(f"{i:>2}. [{verdict:<6}] cov{int(cov*100):02d}%  {p}")
    print(f"      {r['title']}")
PYEOF
	exit 0
}

if [ "$BACKEND" = "mnemosyne" ]; then
	run_mnemosyne
fi

print_results() {
	[ -f "$VERIFY" ] || { echo "ERROR: verify script missing: $VERIFY"; exit 1; }
	python3 "$VERIFY" "$1" "$2" "$SCOPE" "$N" "$Q"
}
echo "== retrieve (manual memory + per-repo graft + global semantic): $Q"
if [ ! -x "$GRAFT" ]; then
	echo "WARN: graft binary not found at $GRAFT (set GRAFT=/path/to/graft). Code-graph search is unavailable; manual-memory search remains active."
	export HEIMDALL_GRAFT_AVAILABLE=0
else
	export HEIMDALL_GRAFT_AVAILABLE=1
fi

# Global semantic layer (bge-m3 embeddings over repo source).
EMBED="$HOME/.heimdall/venv/bin/python3"
if [ ! -x "$EMBED" ] || [ ! -f "$HOME/.heimdall/global.db" ]; then
	echo "WARN: semantic layer missing (venv or global.db). Run: ~/.heimdall/venv/bin/python3 bin/embed-index.py build"
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

# Merge JSON hits from every repo into one JSON array shaped like graft
# retrieve results: {result:{results:[{title,score,id_hex}]}} with paths.
# PLUS global semantic hits from embed-index.py.
python3 - "$Q" "$N" "$SCRIPT_DIR" "${REPO_LIST[@]}" <<'PYEOF'
import json, os, subprocess, sys

q = sys.argv[1]
n = int(sys.argv[2])
script_dir = sys.argv[3]
repos = sys.argv[4:]
graft = os.environ.get("GRAFT", "graft")
results = []
for repo in (repos if os.environ.get("HEIMDALL_GRAFT_AVAILABLE") == "1" else []):
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
# Immediate machine-global memory lane. This reads canonical JSON records and
# needs neither Graft nor the optional embedding environment.
manual = os.path.join(script_dir, "manual-memory.js")
try:
    out = subprocess.run(["node", manual, "search", q, str(n)],
                         capture_output=True, text=True, timeout=10).stdout
    for h in json.loads(out).get("hits", []):
        results.append({
            "id_hex": h.get("id", "manual-?"),
            "title": h.get("title", ""),
            "score": 3.0 + min(float(h.get("score", 0)) / 10.0, 1.0),
            "body": "\n".join([
                h.get("body", ""),
                "keywords: " + " ".join(h.get("keywords", [])),
                "cwd: " + h.get("cwd", ""),
            ]),
            "path": h.get("path", ""),
            "manual": True,
        })
except Exception as e:
    print(f"WARN: manual-memory lane failed: {e}", file=sys.stderr)
# Global semantic hits (bge-m3): append as top-ranked candidates.
# embed-index.py lives next to kb-search.sh; the shell passes SCRIPT_DIR in
# argv[3] because sys.argv[0] is "-" for stdin-invoked python.
sem = os.path.join(script_dir, "embed-index.py")
# fall back to cwd-relative if the script-dir guess misses
if not os.path.exists(sem):
    sem = os.path.join(os.getcwd(), "bin", "embed-index.py")
venv_py = os.path.expanduser("~/.heimdall/venv/bin/python3")
if os.path.exists(venv_py) and os.path.exists(os.path.expanduser("~/.heimdall/global.db")) and os.path.exists(sem):
    try:
        out = subprocess.run([venv_py, sem, "query", q, "-n", str(n), "--related"],
                             capture_output=True, text=True, timeout=90).stdout
        for line in out.splitlines():
            line = line.strip()
            if not line.startswith("[") or "—" not in line:
                continue
            score_s, rest = line[1:].split("]", 1)
            title, _, path = rest.partition("—")
            full = path.strip()
            is_related = "·related" in title
            title = title.replace("·related", "").strip()
            if is_related:
                results.append({
                    "id_hex": f"sem-{full}",
                    "title": title,
                    "score": -5.0,  # structural siblings rank below semantic+lexical
                    "body": f"related file [{full}]",
                    "path": full,
                    "semantic": False,
                })
            else:
                results.append({
                    "id_hex": f"sem-{full}",
                    "title": title,
                    "score": float(score_s) + 3.0,  # semantic scores are tiny; offset so they rank above lexical
                    "body": f"semantic hit [{full}]",
                    "path": full,
                    "semantic": True,
                })
    except Exception as e:
        print(f"WARN: semantic layer failed: {e}", file=sys.stderr)
# dedupe by title, keep top score
seen = {}
for r in sorted(results, key=lambda x: -x["score"]):
    seen.setdefault(r["title"], r)
merged = sorted(seen.values(), key=lambda x: -x["score"])[:n]

if not merged:
    print("No knowledge hits. Manual memories are searched immediately; index a repo with `graft build` for code-graph results.")

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
    if r.get("semantic") and exists:
        verdict = "STRONG"  # semantic similarity already proves relevance
    print(f"{i:>2}. [{verdict:<6}] cov{int(cov*100):02d}%  {p}")
    print(f"      {r['title']}")
PYEOF
