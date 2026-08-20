#!/usr/bin/env bash
# seed-graft.sh — load ~/knowledge-base/.inventory.tsv into Graft.
# Idempotent: graft dedupes by (title, body) — re-runs add nothing.
# Usage: bash ~/knowledge-base/seed-graft.sh [--dry-run]
set -u
TSV="$HOME/knowledge-base/.inventory.tsv"
[ -f "$TSV" ] || { echo "no $TSV"; exit 1; }
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

if ! command -v graft >/dev/null 2>&1 || ! graft stats >/dev/null 2>&1; then
	echo "ERROR: graft daemon unreachable — cannot seed."
	exit 1
fi
n=0; fails=0
while IFS=$'\t' read -r path purpose keywords; do
	case "$path" in \#*|"") continue ;; esac
	case "$purpose" in *auto-sync*) continue ;; esac   # sync-edits owns those rows
	[ -e "$HOME/$path" ] || { echo "skip missing: $path"; continue; }
	title="$path — ${purpose}"
	spaced="$(printf '%s' "$purpose" | tr '_' ' ')"
	body="$HOME/$path — ${purpose}"
	[ "$spaced" != "$purpose" ] && body="$body | ${spaced}"
	args=(--title "$title" --body "$body")
	if [ -n "${keywords:-}" ]; then
		IFS=',' read -r -a kw <<<"$keywords"
		for k in "${kw[@]}"; do args+=(--keyword "$k"); done
	fi
	if [ "$DRY" = 1 ]; then echo "would insert: $title"; else
		q="'"; esc="${title//$q/$q$q}"
		old=$(sqlite3 "$HOME/.graft/profiles/default/graft.db" "select hex(id) from nodes where title='$esc';" 2>/dev/null)
		for id in $old; do graft delete "$id" >/dev/null 2>&1; done
		if ! graft insert "${args[@]}" >/dev/null 2>&1; then fails=$((fails+1)); echo "FAIL insert: $title"; fi
	fi
	n=$((n+1))
done < "$TSV"
if [ "$DRY" = 1 ]; then echo "processed $n entries (dry-run)"; else
  echo "processed $n entries${fails:+, $fails failed}";
  [ "$fails" -eq 0 ] || exit 1; fi
[ "$DRY" = 1 ] || graft stats 2>/dev/null | grep -E 'n_nodes' | sed 's/^/graft /'
