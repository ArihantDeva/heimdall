#!/usr/bin/env bash
# kb-search.sh — ranked knowledge search across the graft graph.
# Better than `graft query` (one gated top-1): returns top-k ranked candidates
# with paths, plus an optional directory scope filter. After the top matches it
# ALSO walks the graph (graft explore) to surface related prior work — edges are
# part of every search now.
#
# Usage:
#   kb-search "<query>"                top 6 ranked results + related graph walk
#   kb-search "<query>" -n 10          top 10
#   kb-search "<query>" --scope poker  only results whose path contains "poker"
#   kb-search "<query>" --no-explore   skip the related graph-walk results
set -u
Q="${1:?usage: kb-search \"<query>\" [-n N] [--scope S] [--no-explore]}"
shift
N=6
SCOPE=""
# Edges are part of every search now: after retrieve, also walk the graph
# (explore) so related prior work surfaces. Pass --no-explore to skip.
EXPLORE=1
while [ $# -gt 0 ]; do
	case "$1" in
		-n) [ $# -ge 2 ] && { N="${2:-6}"; shift 2; } || { N=6; shift; } ;;
		--scope) [ $# -ge 2 ] && { SCOPE="${2:-}"; shift 2; } || shift ;;
		--explore) EXPLORE=1; shift ;;
		--no-explore) EXPLORE=0; shift ;;
		*) shift ;;
	esac
done

print_results() {
	python3 "$HOME/knowledge-base/kb_search_verify.py" "$1" "$2" "$SCOPE" "$N" "$Q"
}

echo "== retrieve (hybrid ranked): $Q"
if ! command -v graft >/dev/null 2>&1; then
	echo "ERROR: graft binary not found — knowledge gate blind. Install or fix PATH."
	exit 1
fi
R=$(graft retrieve "$Q" --top-k 12 2>/dev/null)
if [ -z "$R" ] || ! printf '%s' "$R" | grep -q '"status": 0'; then
	echo "ERROR: graft daemon unreachable — knowledge gate blind (start graftd)."
	exit 1
fi
print_results "$R" "top matches"

if [ "$EXPLORE" = 1 ]; then
	echo "== explore (graph walk): $Q"
	E=$(graft explore "$Q" --depth 2 --beam 6 2>/dev/null)
	print_results "$E" "related"
fi
