#!/usr/bin/env bash
# sync-edits.sh — refresh graft index + inventory from agent session edit logs.
# Scans pi session .jsonl newer than last sync, extracts write/edit/hashline_edit
# paths, filters to indexed project roots, then per path: ensure tsv row,
# delete stale graft node (same path), insert fresh "edited <date>" node.
# Usage: bash ~/knowledge-base/sync-edits.sh [--dry-run]
set -u
KB="$HOME/knowledge-base"
TSV="$KB/.inventory.tsv"
STATE="$HOME/.graft/.last-sync"
DRY=0; FULL=0
for a in "$@"; do
  [ "$a" = "--dry-run" ] && DRY=1
  [ "$a" = "--full" ] && FULL=1
done

now_s() { date +%s; }
fmt() { date -r "$1" +%Y-%m-%d 2>/dev/null || date -d "@$1" +%Y-%m-%d; }

SINCE=0; [ -f "$STATE" ] && SINCE=$(cat "$STATE")
[ "$SINCE" = 0 ] && SINCE=$(( $(now_s) - 7*86400 ))
REF=$(mktemp); touch -t "$(date -r "$SINCE" +%Y%m%d%H%M.%S)" "$REF" 2>/dev/null

NEWER="-newer $REF"
[ "$FULL" = 1 ] && NEWER=""

extract_paths() {
  if [ "$FULL" = 1 ]; then
    find "$HOME/.pi/agent/sessions" -name '*.jsonl' -print0 2>/dev/null | xargs -0 python3 -c '
import json, os, sys
for f in sys.argv[1:]:
    try: fh = open(f, errors="ignore")
    except OSError: continue
    cwd = None
    for line in fh:
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "session" and e.get("cwd"): cwd = e["cwd"]
        for c in (e.get("message") or {}).get("content") or []:
            if not isinstance(c, dict): continue
            if c.get("type") == "toolCall" and c.get("name") in ("write","edit","hashline_edit"):
                p = (c.get("arguments") or {}).get("path")
                if not p: continue
                p = p if os.path.isabs(p) else os.path.join(cwd or "", p)
                print(os.path.expanduser(p))
' 2>/dev/null | sort -u
  else
    find "$HOME/.pi/agent/sessions" -name '*.jsonl' -newer "$REF" -print0 2>/dev/null | xargs -0 python3 -c '
import json, os, sys
for f in sys.argv[1:]:
    try: fh = open(f, errors="ignore")
    except OSError: continue
    cwd = None
    for line in fh:
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "session" and e.get("cwd"): cwd = e["cwd"]
        for c in (e.get("message") or {}).get("content") or []:
            if not isinstance(c, dict): continue
            if c.get("type") == "toolCall" and c.get("name") in ("write","edit","hashline_edit"):
                p = (c.get("arguments") or {}).get("path")
                if not p: continue
                p = p if os.path.isabs(p) else os.path.join(cwd or "", p)
                print(os.path.expanduser(p))
' 2>/dev/null | sort -u
  fi
}

in_skip() {
  case "$1" in
    /tmp/*|/private/tmp/*) return 0 ;;
    "$HOME"/.*) return 0 ;;
    "$HOME"/.pi/*|"$HOME"/.local/*|"$HOME"/.graft/*|"$HOME"/Library/*) return 0 ;;
    "$HOME"/knowledge-base/*|"$HOME"/Desktop/Archives/*) return 0 ;;
    *) return 1 ;;
  esac
}

# graft CLI auto-spawns a daemon when a connect times out under embedding load;
# a spawned daemon can steal the socket (unlink+rebind) and orphan the launchd
# one. Before each graft call, converge to exactly one socket holder.
guard_daemon() {
  if [ "$(lsof /tmp/graft-default.sock 2>/dev/null | awk 'NR>1{print $2}' | sort -u | wc -l | tr -d ' ')" -gt 1 ]; then
    pkill -f "graftd --config" 2>/dev/null; sleep 10
  fi
}

graft() {
  guard_daemon
  command graft "$@"
}

sync_path() {
  local p="$1" rel id
  [ -f "$p" ] || return 0
  rel="${p#"$HOME"/}"
  if ! grep -qF "$rel	" "$TSV"; then
    if [ "$DRY" = 1 ]; then echo "tsv+ $rel"; else
      echo -e "$rel	edited $(fmt $(now_s)) (auto-sync from agent edit log)	auto,edited" >> "$TSV"; fi
  fi
  # Deterministic lookup by exact title prefix — graft query top-1 is ambiguous
  # when multiple nodes share a path (case variants, stale dupes). Escape LIKE
  # wildcards (% _) in the rel path so a filename with _ doesn't match siblings.
  escaped=$(python3 -c "import sys; print(sys.argv[1].replace('\\\\',r'\\\\').replace('%',r'\\%').replace('_',r'\\_').replace(\"'\",\"''\") + ' — edited %', end='')" "$rel")
  id=$(sqlite3 "$HOME/.graft/profiles/default/graft.db" "SELECT hex(id) FROM nodes WHERE title LIKE '$escaped' ESCAPE '\\' LIMIT 1;" 2>/dev/null)
  if [ -n "$id" ] && [ "$DRY" = 1 ]; then echo "node- $id ($rel)"; return 0; fi
  if [ -n "$id" ]; then
    # delete ALL auto nodes for this path (not just the first) — no dups survive
    for x in $(sqlite3 "$HOME/.graft/profiles/default/graft.db" "SELECT hex(id) FROM nodes WHERE title LIKE '$escaped' ESCAPE '\\';" 2>/dev/null); do
      graft delete "$x" >/dev/null 2>&1
    done
  fi
  if [ "$DRY" = 1 ]; then echo "node+ $rel (edited $(fmt $(now_s)))"; else
    if graft insert --title "$rel — edited $(fmt $(now_s))" \
      --body "$p — auto-refreshed from agent edit log $(fmt $(now_s))" \
      --keyword auto --keyword edited >/dev/null 2>&1; then
      : # ok
    else
      echo "FAIL insert: $rel" >&2
      return 1
    fi
  fi
}

if ! command -v graft >/dev/null 2>&1 || ! graft stats >/dev/null 2>&1; then
	echo "ERROR: graft daemon unreachable — knowledge gate blind."
	exit 1
fi
LIST=$(mktemp); extract_paths > "$LIST"
n=0; fails=0
while read -r p; do
  in_skip "$p" && continue
  case "$p" in *node_modules/*|*/.git/*|*/__pycache__/*|*/dist/*|*/build/*|*/.venv/*) continue ;; esac
  if sync_path "$p"; then n=$((n+1)); else fails=$((fails+1)); fi
done < "$LIST"
[ "$DRY" = 1 ] || [ "$fails" -eq 0 ] || { rm -f "$REF" "$LIST"; exit 1; }
[ "$DRY" = 1 ] || date -u +%s > "$STATE"
# graft CLI auto-spawns a daemon when a connect times out under embedding load;
# reconcile to exactly one socket holder (kb-health counts lsof, not pgrep).
bash "$KB/kb-health.sh" >/dev/null 2>&1 || true
rm -f "$REF" "$LIST"
if [ "$DRY" = 1 ]; then echo "sync: $n edited paths processed (dry-run)"; else
  echo "sync: $n edited paths processed, $fails failed"; fi
