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
echo "== retrieve (per-repo graft + global semantic): $Q"
if [ ! -x "$GRAFT" ]; then
	# Not a tool failure: a fresh/unconfigured machine has validly zero results.
	# Exit 0 so callers (MCP kb_search) get an answer, not isError.
	echo "WARN: graft binary not found at $GRAFT (set GRAFT=/path/to/graft). Install: npm i -g @nanonets/graft. Search unavailable until indexed — this is an empty result, not an error."
	exit 0
fi

# Global semantic layer (bge-m3 embeddings over repo source).
EMBED="$HOME/.heimdall/venv/bin/python3"
if [ ! -x "$EMBED" ] || [ ! -f "$HOME/.heimdall/global.db" ]; then
	echo "SEMANTIC_ERROR: not-configured (venv or global.db missing). Run: ~/.heimdall/venv/bin/python3 bin/embed-index.py build"
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

if [ ${#REPO_LIST[@]} -eq 0 ] && [ -z "${SCOPE:-}" ]; then
	# Fresh install / no indexed repos yet: valid empty answer (exit 0), with
	# setup guidance in-band. Exit 1 here broke MCP kb_search (isError) on CI.
	echo "No repos with a graft graph found under ~/Repos yet. Index one: cd <repo> && heimdall index (or graft build). Search returns no hits until then."
	exit 0
fi

# Merge JSON hits from every repo into one JSON array shaped like graft
# retrieve results: {result:{results:[{title,score,id_hex}]}} with paths.
# PLUS global semantic hits from embed-index.py.
# SCOPE-AWARE ROOT EXPANSION: --scope poker must also search non-Repos roots
# whose path contains 'poker' (e.g. ~/poker-bot). Roots persisted by
# embed-index.py build in ~/.heimdall/search-roots.json enumerate every
# graft-bearing project on the volume — not just ~/Repos/*/graft.
ALL_ROOTS=$(mktemp)
{
	# bash 3.2 + set -u: "${ARR[@]}" on an empty array aborts as unbound —
	# guard with length check (reviewer finding, empirically confirmed).
	[ ${#REPO_LIST[@]} -gt 0 ] && printf '%s\n' "${REPO_LIST[@]}"
	[ -f "$HOME/.heimdall/search-roots.json" ] && \
		python3 -c 'import json,sys; [print(r) for r in json.load(open(sys.argv[1]))["roots"]]' \
			"$HOME/.heimdall/search-roots.json"
} | sort -u > "$ALL_ROOTS"

if [ -n "${SCOPE:-}" ]; then
	SCOPE_ROOTS=$(rg -i -- "${SCOPE}" "$ALL_ROOTS" || true)
else
	SCOPE_ROOTS="$(cat "$ALL_ROOTS")"
fi
rm -f "$ALL_ROOTS"
# SCOPE_ROOTS may be unset when the scope branch produced nothing; default it.
SCOPE_ROOTS="${SCOPE_ROOTS:-}"
if [ -z "$SCOPE_ROOTS" ]; then
	echo "No indexed roots match scope '${SCOPE}'. Known scopes include path substrings of any graft-bearing project (try: heimdall search '<q>' without --scope)."
	exit 0
fi

# Paths may contain spaces (~/My Projects/app) — expand newline-separated
# entries to an argv array, with globbing off. bash 3.2 compatible; the
# empty case already exited above so "${ROOT_ARGS[@]}" is never unbound.
set -f
ROOT_ARGS=()
while IFS= read -r root; do
	[ -n "$root" ] && ROOT_ARGS+=("$root")
done <<< "$SCOPE_ROOTS"

python3 - "$Q" "$N" "$SCRIPT_DIR" "${ROOT_ARGS[@]}" <<'PYEOF'
import json, os, subprocess, sys

q = sys.argv[1]
n = int(sys.argv[2])
script_dir = sys.argv[3]
repos = sys.argv[4:]
graft = os.environ.get("GRAFT", "graft")
from concurrent.futures import ThreadPoolExecutor

def ask_repo(repo):
    try:
        out = subprocess.run([graft, "ask", q, repo, "--json", "-n", str(n)],
                             capture_output=True, text=True, timeout=60).stdout
        hits = []
        for h in json.loads(out).get("hits", []):
            pointer = h.get("pointer", "")
            fname = pointer.split(":")[0]
            full = os.path.join(repo, fname)
            hits.append({
                "id_hex": f"graft-{repo}-{pointer}",
                "title": h.get("title", ""),
                "score": float(h.get("score", 0)),
                "body": f"{h.get('snippet','')} [{full}]",
                "path": full,
            })
        return hits
    except Exception as e:
        # Per-repo graft failure must not kill the whole search, but must be
        # visible (2026-08-25 silent-swallow lesson).
        print(f"WARN: graft ask failed for {repo}: {e}", file=sys.stderr)
        return []

# Parallel across roots — 95 sequential spawns measured 37s; a thread pool
# cuts wall time to the slowest single ask (graft releases the GIL on subprocess).
with ThreadPoolExecutor(max_workers=16) as ex:
    results = [h for hits in ex.map(ask_repo, repos) for h in hits]
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
                             capture_output=True, text=True, timeout=90)
        if out.returncode != 0:
            # LOUD + machine-readable (2026-09-10 zvec-grep port, live incident):
            # a dead semantic leg must be (a) visible and (b) parseable by the
            # caller. Never a raw traceback, never a silent lex-only fallback.
            tail_lines = [ln for ln in out.stderr.splitlines() if ln.strip()][-3:]
            reason = (" | ".join(tail_lines[-1:]) if tail_lines else "unknown embed-index.py failure")
            print(f"SEMANTIC_ERROR: {reason}")
            print("WARN: semantic layer failed — results are LEXICAL-ONLY (sem_coverage=degraded):")
            for ln in tail_lines:
                print(f"  {ln}")
        for line in out.stdout.splitlines():
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
        print(f"SEMANTIC_ERROR: semantic layer exception: {e}", file=sys.stderr)
        print("WARN: semantic layer failed — results are LEXICAL-ONLY (sem_coverage=degraded)", file=sys.stderr)
# dedupe by title, keep top score
seen = {}
for r in sorted(results, key=lambda x: -x["score"]):
    seen.setdefault(r["title"], r)
merged = sorted(seen.values(), key=lambda x: -x["score"])[:n]

# Verdict pass: STRONG requires identity with the indexed content — the path
# exists AND the file on disk still matches the card that was indexed (size +
# mtime). Query-token coverage is a RANKING signal, never a trust signal: a
# semantic hit's body is synthesized as `semantic hit [<path>]`, so the path
# alone scores full coverage, and a stale card still points at a live file.
# Size/mtime come from the card, so this opens nothing — verification costs one
# stat per hit. (See tests/kb-search-identity.test.mjs.)
q_toks = set(q.lower().split())
# Freshness anchors: per-card mtime from global.db = when the snapshot was
# indexed. Read-only, final hits only; absent db / errors => unknown freshness.
import sqlite3, time

card_mtimes = {}
card_sizes = {}
db_path = os.path.expanduser("~/.heimdall/global.db")
if os.path.exists(db_path):
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        hit_paths = [r["path"] for r in merged if r.get("path")]
        if hit_paths:
            qm = ",".join("?" * len(hit_paths))
            for p_, mt_, sz_ in con.execute(
                    f"SELECT path, mtime, size FROM cards WHERE path IN ({qm})", hit_paths):
                card_mtimes[p_] = mt_
                card_sizes[p_] = sz_
        con.close()
    except Exception as e:
        print(f"WARN: freshness lookup failed: {e}", file=sys.stderr)
        card_mtimes = {}
        card_sizes = {}
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
    # Content identity: the card this hit came from recorded the size AND mtime
    # the file had when it was indexed. A file that has moved on since then is
    # not the content we matched — whatever it now says is unverified, so it
    # cannot be STRONG no matter how well the query tokens line up. Size alone
    # would miss a same-length rewrite (ALLOWED=1 -> DELETED=1); the mtime
    # comparison closes that, and matches the freshness token below so a hit can
    # never read `possibly_stale` and STRONG at the same time.
    #
    # Two stats, zero reads: this is what makes the README's "act on STRONG
    # without a confirmation round-trip" true without opening the file.
    identity = None
    if exists and p in card_sizes:
        try:
            st = os.stat(p)
            identity = st.st_size == card_sizes[p] and (st.st_mtime - card_mtimes[p]) <= 1.0
        except OSError:
            identity = None
    # Indexed backends (graft, mnemosyne) return no card, so identity is
    # unknown there; file identity is all we can honestly claim, and only when
    # the query tokens actually appear in content we hold.
    if identity is True and cov >= 0.5:
        verdict = "STRONG"
        why = ""
    elif not exists:
        verdict = "NOPATH"
        why = "anchor is gone from disk"
    elif identity is False:
        verdict = "WEAK"
        why = "file changed since it was indexed"
    elif cov == 0.0:
        verdict = "WEAK"
        why = "path only — no query token in the indexed card"
    elif p in card_sizes:
        # identity is None: stat failed on a path that os.path.exists accepted
        verdict = "WEAK"
        why = "could not read file metadata"
    else:
        # No card (indexed backend). Name the content that was actually
        # matched — the label must never claim a check that did not happen.
        snippet = " ".join(r["body"].split())[:180]
        verdict = "STRONG"
        why = f'matched file content [{p}] "{snippet}"'
    if r.get("semantic") and exists and identity is not False and verdict == "WEAK" and cov > 0:
        # Semantic similarity proves relevance, not liveness: an existing path
        # whose content matches NO query token stays WEAK; any (>0) lexical
        # corroboration lets the semantic signal carry it to STRONG. Never
        # upgrades NOPATH — a dead anchor must not look trustworthy — and never
        # upgrades a file that changed after it was indexed (identity False).
        verdict = "STRONG"
        why = f'semantic match corroborated by query tokens "{q}"'
    # Freshness (zvec-grep port): the card's mtime is the as_of anchor of the
    # indexed snapshot. Older than the file on disk (1s tolerance) =>
    # possibly_stale; no card row (e.g. graft-only hits) => freshness unknown,
    # no token printed. Dead path (NOPATH) => no token: "fresh" on a corpse
    # would be a lie.
    fr = ""
    cm = card_mtimes.get(p)
    if cm is not None and exists:
        age = max(0.0, time.time() - cm)
        as_of = f"{age/3600:.1f}h" if age < 86400 * 14 else f"{age/86400:.1f}d"
        try:
            stale = os.path.getmtime(p) - cm > 1.0
        except OSError:
            stale = False
        fr = f"as_of={as_of} " + ("possibly_stale" if stale else "fresh")
    fr_s = f"  {fr}" if fr else ""
    print(f"{i:>2}. [{verdict:<6}] cov{int(cov*100):02d}%{fr_s}  {p}")
    print(f"      {r['title']}")
    if why:
        print(f"      {why}")
PYEOF
