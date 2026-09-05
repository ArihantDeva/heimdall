#!/usr/bin/env bash
# kb-rehome.sh — deterministic rehome for a stale node: find where the file moved.
# Desktop gets reorganized aggressively, so a dead path usually means "moved", not
# "gone". Bounded basename search in known roots; exactly one FILE hit → delete the
# old node and reinsert with the corrected path (rebuild in place). Directory-name
# matches are NOT treated as identity (dirs scatter on reorg) — those get removed.
#
# Usage: kb-rehome.sh <id_hex> <dead_path> <title> <body_file> [hits_cache_file]
#   hits_cache_file: precomputed find output (one path per line) for this basename,
#   to avoid re-running the expensive Desktop scan per node.
# Prints: REBUILT <newpath> | NOTFOUND | AMBIGUOUS
set -u
# graft via absolute path (env-overridable) — never PATH-resolved (supply-chain guard).
# Callers use "$GRAFT" directly; the wrapper is kept for the existing call sites.
GRAFT="${GRAFT:-$HOME/.local/bin/graft}"
graft() { "$GRAFT" "$@"; }
ID="${1:?kb-rehome.sh <id> <dead_path> <title> <body_file> [hits_cache]}"
DEAD="${2:?}"
TITLE="${3:-}"
BODYF="${4:?}"
CACHE="${5:-}"
[ -f "$BODYF" ] || { echo "NOTFOUND"; exit 0; }
BASE=$(basename "$DEAD")
# find -name treats the pattern as a glob — escape glob chars so a literal
# filename like "report[1].md" matches only itself, not report1.md.
GLOB_SAFE=$(printf '%s' "$BASE" | sed 's/[][*?]/\\&/g')

if [ -n "$CACHE" ] && [ -s "$CACHE" ]; then
	HITS=$(cat "$CACHE")
else
	# Known roots only — never a wholesale $HOME scan (bounded search boundary).
	ROOTS="$HOME/Desktop $HOME/projects $HOME/Music $HOME/.pi/agent $HOME/.local/bin $HOME/Library/LaunchAgents"
	HITS=""
	for r in $ROOTS; do
		[ -d "$r" ] || continue
		H=$(find "$r" -maxdepth 8 -name "$GLOB_SAFE" \
			-not -path '*/node_modules/*' -not -path '*/.git/*' \
			-not -path '*/linkedin_session/*' -not -path '*/.build/*' \
			-not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/Pods/*' \
			-not -path '*/DerivedData/*' 2>/dev/null)
		[ -n "$H" ] && HITS="${HITS}${H}"$'\n'
	done
	HITS=$(printf '%s' "$HITS" | sed '/^$/d')
fi
N=$(printf '%s\n' "$HITS" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$N" = "0" ]; then
	echo "NOTFOUND"
	exit 0
fi

# C2 narrow rehome: multiple basename hits used to be flat AMBIGUOUS. Compare
# each FILE candidate's content against the node body via char-trigram Jaccard:
#   >= 0.70 → confident rehome (with provenance note appended to the body)
#   <= 0.30 → no candidate resembles the old content → NOTFOUND (remove)
#   between → genuinely ambiguous → AMBIGUOUS (leave stale + report)
# ponytail: fixed thresholds, calibrated later if the rehome log says so.
if [ "$N" != "1" ] && [ -f "$BODYF" ]; then
	BEST=$(printf '%s\n' "$HITS" | sed '/^$/d' | python3 -c '
import sys, os
body = open(sys.argv[1], encoding="utf-8", errors="replace").read()
def tris(s):
    s = " ".join(s.split()).lower()
    return {s[i:i+3] for i in range(max(0, len(s)-2))} or {s}
bset = tris(body)
best_path, best_score = None, 0.0
for path in sys.argv[2:]:
    if not os.path.isfile(path): continue
    try: content = open(path, encoding="utf-8", errors="replace").read()
    except OSError: continue
    cset = tris(content)
    union = bset | cset
    score = len(bset & cset) / len(union) if union else 0.0
    if score > best_score:
        best_path, best_score = path, score
HI, LO = 0.70, 0.30
if best_path and best_score >= HI: print(f"REHOME|{best_path}|{best_score:.2f}")
elif best_path and best_score <= LO: print("NOTFOUND")
else: print("AMBIGUOUS")
' "$BODYF" $(printf '%s\n' "$HITS" | sed '/^$/d') )
	case "$BEST" in
		REHOME\|*)
			NEW=$(printf '%s' "$BEST" | cut -d'|' -f2)
			C2_SCORE=$(printf '%s' "$BEST" | cut -d'|' -f3)
			export C2_SCORE
			;;
		*) echo "$BEST"; exit 0 ;;
	esac
else
	[ "$N" != "1" ] && { echo "AMBIGUOUS"; exit 0; }
	NEW=$(printf '%s\n' "$HITS" | sed '/^$/d')
fi
# File moves only — a single dir-name match is not identity (dirs scatter on reorg).
[ -f "$NEW" ] || { echo "NOTFOUND"; exit 0; }

# Deterministic dedup: before rebuilding, drop any existing auto node(s) for the
# NEW path (title "<rel> — edited ...") so rehome never leaves a same-title dup.
# Use graft delete (daemon-aware) — raw SQL would desync FTS/vec indexes.
NEWREL=$(printf '%s' "$NEW" | sed "s|$HOME/||")
ESCAPED=$(python3 -c "import sys; print(sys.argv[1].replace('\\\\',r'\\\\').replace('%',r'\\%').replace('_',r'\\_').replace(\"\'\",\"\'\'\") + ' — edited %', end='')" "$NEWREL")
for OLDID in $(sqlite3 "${GRAFT_DB:-$HOME/.graft/profiles/default/graft.db}" "SELECT hex(id) FROM nodes WHERE title LIKE '$ESCAPED' ESCAPE '\\'" 2>/dev/null); do
	graft delete "$OLDID" >/dev/null 2>&1
done

# Fetch keywords BEFORE deleting the old node.
KWS=$(graft get "$ID" 2>/dev/null | python3 -c "
import json,sys
try: print(' '.join((json.load(sys.stdin).get('result') or {}).get('keywords') or []))
except Exception: pass")
NEWBODY=$(python3 -c 'import sys,re
import os
text=open(sys.argv[1]).read()
old,new=sys.argv[2],sys.argv[3]
# boundary-aware: only replace whole-path mentions (after old must be /, space, or EOS)
pat=re.compile(re.escape(old)+"(?=/| |$)")
out=pat.sub(lambda m:new, text)
score=os.environ.get("C2_SCORE")
if score and not out.endswith(chr(10)): out += chr(10)
if score: out += f"(rehomed by content match {score} — pre-delete snapshot verified)"+chr(10)
print(out, end="")' "$BODYF" "$DEAD" "$NEW")
DEADREL=$(printf '%s' "$DEAD" | sed "s|$HOME/||")
# titles hold REL paths — replace both abs and rel forms (rel first, then abs), boundary-aware
NEWTITLE=$(printf '%s' "$TITLE" | python3 -c 'import sys,re
s=sys.stdin.read()
for o,n in ((sys.argv[1],sys.argv[2]),(sys.argv[3],sys.argv[4])):
    s=re.compile(re.escape(o)+"(?=/| |$)").sub(lambda m:n, s)
print(s, end="")' "$DEADREL" "$NEWREL" "$DEAD" "$NEW")

graft delete "$ID" >/dev/null 2>&1
ARGS=(insert --title "$NEWTITLE" --body "$NEWBODY")
for k in $KWS; do ARGS+=(--keyword "$k"); done
if graft "${ARGS[@]}" >/dev/null 2>&1; then
	echo "REBUILT $NEW"
else
	echo "NOTFOUND"   # insert failed — report not-rebuilt so the caller can log/remove
fi
