#!/usr/bin/env bash
# sync-edits.sh — one-shot bootstrap: replay agent session edit logs into the
# reconciler queue.
#
# This script used to write graft directly (delete node, insert node) for every
# path it found. That made it a SECOND concurrent writer alongside the daemon,
# and its delete+insert pair was not atomic: a reader between the two saw the
# file missing from the graph entirely, and two copies of this script running
# at once could interleave into duplicate or lost nodes.
#
# It now emits hints and asks the reconciler to converge. The reconciler holds
# the single-writer lock, reads each file from disk, and makes the graph match.
# Whatever this script gets wrong — a path that was never edited, a path listed
# twice, a stale log entry — costs one stat and nothing more.
#
# Usage: bash sync-edits.sh [--dry-run] [--full]
set -u
STATE="$HOME/.graft/.last-sync"
DRY=0; FULL=0
for a in "$@"; do
  [ "$a" = "--dry-run" ] && DRY=1
  [ "$a" = "--full" ] && FULL=1
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEIMDALL="$HERE/heimdall.js"
if [ ! -f "$HEIMDALL" ]; then
  echo "ERROR: heimdall.js not found next to sync-edits.sh ($HERE)" >&2
  exit 1
fi
heimdall() { node "$HEIMDALL" "$@"; }

SESSIONS="$HOME/.pi/agent/sessions"
if [ ! -d "$SESSIONS" ]; then
  echo "sync: no session logs at $SESSIONS — nothing to replay"
  exit 0
fi

SINCE=0; [ -f "$STATE" ] && SINCE=$(cat "$STATE" 2>/dev/null || echo 0)
[ "$SINCE" = 0 ] && SINCE=$(( $(date +%s) - 7*86400 ))
REF=$(mktemp); touch -t "$(date -r "$SINCE" +%Y%m%d%H%M.%S)" "$REF" 2>/dev/null

# One parser, used for both modes — the two copies that used to differ only in
# the find predicate had already drifted apart once.
read -r -d '' PARSE <<'PY' || true
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
PY

LIST=$(mktemp)
if [ "$FULL" = 1 ]; then
  find "$SESSIONS" -name '*.jsonl' -print0 2>/dev/null
else
  find "$SESSIONS" -name '*.jsonl' -newer "$REF" -print0 2>/dev/null
fi | xargs -0 python3 -c "$PARSE" 2>/dev/null | sort -u > "$LIST"

n=$(wc -l < "$LIST" | tr -d ' ')
if [ "$DRY" = 1 ]; then
  echo "sync: would hint $n path(s) (dry-run)"
  sed -n '1,20p' "$LIST"
  rm -f "$REF" "$LIST"
  exit 0
fi

if [ "$n" -gt 0 ]; then
  # The reconciler applies its own skip rules and dedups by path, so passing a
  # path it will ignore is free. xargs chunks so a huge --full run still works.
  xargs -a "$LIST" -n 200 node "$HEIMDALL" hint || {
    echo "ERROR: heimdall hint failed" >&2; rm -f "$REF" "$LIST"; exit 1; }
fi

# Converge now if no daemon holds the lock; if one does, it will pick the hints
# up on its next pass and there is nothing to wait for.
heimdall reconcile || true

date -u +%s > "$STATE"
rm -f "$REF" "$LIST"
echo "sync: $n edited path(s) hinted"
