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
# This backend has no index cards, so there is nothing here that could ever
# corroborate the content it returns. A path that exists plus tokens that appear
# in the memory's own prose is evidence of a mention, not of verification — so
# these hits are WEAK with the reason stated, exactly like a cardless hit on the
# graft path. Claiming STRONG here would mean the same word meaning two
# different things depending on which backend answered.
for i, r in enumerate(sorted(results, key=lambda x: -x["score"])[:n], 1):
    p = r["path"]
    exists = os.path.exists(p)
    blob = (r["title"] + " " + r["body"] + " " + p).lower()
    cov = round(sum(1 for t in q_toks if t in blob) / len(q_toks), 2) if q_toks else 0.0
    if not exists:
        verdict, why = "NOPATH", "anchor is gone from disk"
    else:
        verdict = "WEAK"
        why = "memory store has no index card — content not verified"
    print(f"{i:>2}. [{verdict:<6}] cov{int(cov*100):02d}%  {p}")
    print(f"      {r['title']}")
    print(f"      {why}")
PYEOF
	exit 0
}

if [ "$BACKEND" = "mnemosyne" ]; then
	run_mnemosyne
fi

# (No legacy verifier wiring here. The `kb_search_verify.py` graft-retrieve CLI
# targeted the retired global `graft retrieve` daemon API and had no callers, so
# it was deleted; only its extract_paths() helper survives, for the stale scan.
# Both backends above compute their own verdicts in-process.)
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
import sqlite3, stat, time

card_mtimes = {}
card_sizes = {}
# Index availability is part of the verdict: when the cards table cannot be
# read, NO hit can be identity-checked, so every result degrades to WEAK. That
# must be visible on the stream the caller actually reads — this script's own
# stdout — because bin/lib/mcp-server.mjs returns stdout only and drops stderr,
# so a stderr-only warning made "index is broken" and "path was never indexed"
# print the identical reason line to an agent.
index_reason = None
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
        # Machine-readable on stdout so the MCP caller (which drops stderr)
        # can tell "the index is unreadable" from "this path was never
        # indexed". Same convention as SEMANTIC_ERROR above.
        print(f"INDEX_ERROR: cards lookup failed — no hit can be identity-verified ({e})")
        index_reason = f"index unreadable — content not verified ({e})"
        card_mtimes = {}
        card_sizes = {}
for i, r in enumerate(merged, 1):
    p = r["path"]
    exists = os.path.exists(p)
    title_l = r["title"].lower()
    body_l = r["body"].lower()
    # Coverage is measured over the INDEXED TEXT only — never the path. The old
    # expression included p.lower(), which let a filename supply the whole
    # score: `deploy_policy_backup.md` full of lorem ipsum read cov100% off its
    # own name and reached STRONG. The path is a retrieval signal (which is why
    # it belongs in the ranking above); it is not evidence that content answers
    # the query, which is the only thing this bar is for. Tokens here come from
    # the card body ([path] is appended) or the backend's snippet, so a hit
    # whose text genuinely contains the query still passes.
    covered = title_l + " " + body_l
    # ...and the path must be REMOVED from that text, not merely excluded as a
    # field: every producer embeds it in the body (graft: `snippet [path]`,
    # semantic: `semantic hit [path]`), so leaving it in re-admits exactly the
    # filename-as-coverage bug this line exists to prevent.
    if p:
        covered = covered.replace(p.lower(), " ")
    cov = 0.0
    if q_toks:
        matched = sum(1 for tok in q_toks if tok in covered)
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
    #
    # ponytail: a same-size rewrite that ALSO restores mtime (os.utime) defeats
    # any stat-based check by construction, so query time cannot see it — and
    # paying for it here would mean hashing every hit, which is the read this
    # layer exists to avoid. The card is keyed on (size, mtime) all the way
    # down, including index/embed-index.py's own
    # `prev[1] == st.st_mtime and prev[2] == st.st_size` fast-path, so that same
    # fast-path will NOT notice the rewrite either: the card keeps the stale
    # hash and this stays wrong until something re-reads the file on purpose.
    # The boundary is owned by `heimdall verify --deep`, which re-hashes and
    # reports `why: "hash"` drift (reconcile.mjs). Note its scope: it audits the
    # reconciler journal, which is not the same path set as semantic cards.
    # tests/kb-search-identity.test.mjs pins this as a known ceiling — if that
    # test ever fails toward WEAK, query-time identity became content-based and
    # this comment is what to update.
    identity = None
    # A directory or a symlink is not the file the card describes: os.stat
    # follows links, and a directory can carry a plausible size/mtime, so both
    # would otherwise inherit the verdict the path used to deserve. Read the
    # entry itself (lstat) and require it to be a regular file.
    try:
        link_st = os.lstat(p)
        is_file = stat.S_ISREG(link_st.st_mode)
    except OSError:
        is_file = False
    if exists and is_file and p in card_sizes:
        try:
            st = os.stat(p)
            cm = card_mtimes[p]
            # Card columns are only loosely typed, so a non-numeric mtime must
            # fail the check rather than raise inside it.
            numeric_mtime = isinstance(cm, (int, float))
            # SYMMETRIC and TIGHT. `st.st_mtime - card <= 1.0` accepted a
            # downward skew of any size, which is reachable without utime:
            # embed-index fast-paths on EXACT mtime equality, so an edit landing
            # in the same coarse tick as the index pass keeps the old content
            # hash, as does any mtime-preserving restore. Mirroring that exact
            # equality (with an epsilon only for float round-tripping) is what
            # "the file is unchanged since we indexed it" actually means; a
            # loose window would re-admit the evidence-free STRONG this whole
            # check exists to prevent.
            identity = (numeric_mtime
                        and st.st_size == card_sizes[p]
                        and abs(st.st_mtime - cm) < 1e-6)
        except OSError:
            identity = None
    if not exists:
        verdict = "NOPATH"
        why = "anchor is gone from disk"
    elif not is_file:
        verdict = "WEAK"
        why = "path is no longer a regular file (directory or symlink)"
    elif identity is False:
        verdict = "WEAK"
        why = "file changed since it was indexed"
    elif identity is None:
        # No card (graft/mnemosyne backends return none) or an unreadable stat.
        # Nothing was verified here, so this must not be STRONG: an unverifiable
        # hit is labelled as one, with the reason on its own line. The remedy is
        # to index the path, which is what creates the card STRONG is built on.
        verdict = "WEAK"
        if index_reason:
            why = index_reason
        elif p in card_sizes:
            why = "could not read file metadata"
        else:
            why = "no index card for this path — content not verified"
    elif cov < 0.5:
        # Identity holds, but the card's own text barely overlaps the query:
        # an intact anchor is not the same thing as an answer. A semantic hit
        # may still upgrade this below, on top of the identity.
        verdict = "WEAK"
        why = f"indexed content intact, but query tokens cover only {int(cov*100)}% of it"
    else:
        verdict = "STRONG"
        why = ""
    if r.get("semantic") and identity is True and verdict == "WEAK" and cov > 0:
        # Semantic similarity proves relevance, not liveness. It only carries a
        # hit to STRONG on top of an identity that already holds (card agrees
        # with the file), where the lexical overlap is partial rather than
        # absent: "the file is unchanged AND its indexed content is what the
        # query is near". Never upgrades NOPATH — a dead anchor must not look
        # trustworthy — never upgrades a changed file, and never upgrades a hit
        # with no card to check, so every STRONG rests on verified identity.
        verdict = "STRONG"
        why = f'semantic similarity to unchanged content "{q}"'
    # Freshness (zvec-grep port): the card's mtime is the as_of anchor of the
    # indexed snapshot. Older than the file on disk (1s tolerance) =>
    # possibly_stale; no card row (e.g. graft-only hits) => freshness unknown,
    # no token printed. Dead path (NOPATH) => no token: "fresh" on a corpse
    # would be a lie.
    fr = ""
    cm = card_mtimes.get(p)
    # SQLite is dynamically typed, so a hand-edited or older cards row can hold
    # a non-numeric mtime. Arithmetic on it would raise and take the whole
    # result set down (every other hit is lost to one bad row), so the type is
    # checked before use.
    if isinstance(cm, (int, float)) and exists:
        age = max(0.0, time.time() - cm)
        as_of = f"{age/3600:.1f}h" if age < 86400 * 14 else f"{age/86400:.1f}d"
        # The freshness token says exactly what identity verified: the file's
        # mtime still equals the card's. Same test, same tightness, so the token
        # and the verdict can never disagree.
        try:
            stale = abs(os.path.getmtime(p) - cm) >= 1e-6
        except OSError:
            stale = False
        fr = f"as_of={as_of} " + ("possibly_stale" if stale else "fresh")
    fr_s = f"  {fr}" if fr else ""
    print(f"{i:>2}. [{verdict:<6}] cov{int(cov*100):02d}%{fr_s}  {p}")
    print(f"      {r['title']}")
    if why:
        print(f"      {why}")
PYEOF
