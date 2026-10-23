#!/usr/bin/env bash
# seed-graft.sh — load ~/knowledge-base/.inventory.tsv into Graft.
# Idempotent: graft dedupes by (title, body) — re-runs add nothing.
# Usage: bash ~/knowledge-base/seed-graft.sh [--dry-run]
set -u
DRY=0
for a in "$@"; do
	case "$a" in
		--dry-run) DRY=1 ;;
		*)
			# Same shape as sync-edits.sh: a typo'd --dry-run must not fall through
			# and let the script insert/graft-delete for real. seed-graft deletes
			# and re-inserts graph rows, so this is a durable-state command.
			echo "seed-graft: unknown option: $a" >&2
			echo "seed-graft: usage: seed-graft.sh [--dry-run]" >&2
			exit 2
			;;
	esac
done

TSV="$HOME/knowledge-base/.inventory.tsv"
[ -f "$TSV" ] || { echo "no $TSV"; exit 1; }

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
		# CAPTURE BEFORE DELETE. The old order was delete-then-insert with no
		# rollback: if the insert failed, the node was already gone and its content
		# existed nowhere — a silent, permanent deletion of a row that may have been
		# the only copy of a decision (measured 2026-10-23 by reducing the sequence:
		# delete succeeds, insert returns 1, nothing restores it). The row's title and
		# body are read back from the same DB this block already queries.
		q="'"; esc="${title//$q/$q$q}"
		DB="$HOME/.graft/profiles/default/graft.db"
		old=$(sqlite3 "$DB" "select hex(id) from nodes where title='$esc';" 2>/dev/null)
		saved_titles=(); saved_bodies=()
		for id in $old; do
			# -separator with a byte that cannot appear in the row keeps the two
			# fields distinguishable even when the body contains newlines or tabs.
			rec=$(sqlite3 -separator $'\x1f' "$DB" "select title, body from nodes where hex(id)='$id';" 2>/dev/null)
			[ -n "$rec" ] || { echo "WARN: could not read node $id before delete — skipping it" >&2; continue; }
			# `arr=("${arr[@]}" x)` reads as a plain append but fatally is not
			# one: under `set -u`, expanding an EMPTY array is an unbound-variable
			# error in bash 3.2 — the bash macOS ships at /bin/bash, and what
			# `#!/usr/bin/env bash` resolves to for every Mac user. Measured
			# 2026-10-23: seed-graft.sh died on line 58 ("saved_titles[@]: unbound
			# variable") on EVERY run, before touching the graph, so re-seeding was
			# completely broken on macOS while CI's bash 5 passed. `+=` is the
			# portable append and behaves identically where the old form worked.
			saved_titles+=("${rec%%$'\x1f'*}")
			saved_bodies+=("${rec#*$'\x1f'}")
		done
		# Refuse to delete anything we could not read back. Deleting unreadable
		# content is unrecoverable by construction.
		if [ "${#old}" -gt 0 ] && [ "${#saved_titles[@]}" -eq 0 ]; then
			fails=$((fails+1)); echo "FAIL read-before-delete: $title (node kept)" >&2; n=$((n+1)); continue
		fi
		for id in $old; do graft delete "$id" >/dev/null || echo "WARN: graft delete $id failed" >&2; done
		if ! ins_err=$(graft insert "${args[@]}" 2>&1 >/dev/null); then
			[ -n "$ins_err" ] && echo "   reason: ${ins_err}" >&2
			fails=$((fails+1)); echo "FAIL insert: $title" >&2
			# ROLLBACK: put the captured content back.
			for idx in "${!saved_titles[@]}"; do
				if graft insert --title "${saved_titles[$idx]}" --body "${saved_bodies[$idx]}" >/dev/null 2>&1; then
					echo "   restored: ${saved_titles[$idx]}" >&2
				else
					echo "   COULD NOT RESTORE: ${saved_titles[$idx]} — content lost" >&2
				fi
			done
		fi
	fi
	n=$((n+1))
done < "$TSV"
if [ "$DRY" = 1 ]; then echo "processed $n entries (dry-run)"; else
  echo "processed $n entries${fails:+, $fails failed}";
  [ "$fails" -eq 0 ] || exit 1; fi
[ "$DRY" = 1 ] || graft stats 2>/dev/null | grep -E 'n_nodes' | sed 's/^/graft /'
