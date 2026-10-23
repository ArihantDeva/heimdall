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
  case "$a" in
    --dry-run) DRY=1 ;;
    --full) FULL=1 ;;
    *)
      # A typo'd flag must not silently become the real thing. Measured
      # 2026-10-23: `sync-edits.sh --dry-runn` fell through this loop, DRY stayed
      # 0, and the run proceeded past the dry-run branch to actually hint paths
      # and ADVANCE the durable high-water mark in $STATE — a rehearsal the
      # operator believes is safe, performing permanent work.
      echo "sync: unknown option: $a" >&2
      echo "sync: usage: sync-edits.sh [--dry-run] [--full]" >&2
      exit 2
      ;;
  esac
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
# Portable epoch -> touch stamp. `date -r <epoch>` is BSD; GNU reads `-r` as
# --reference=FILE, so on any machine with GNU coreutils in front (measured here:
# GNU 9.11 on macOS, and every ubuntu CI runner) this line failed silently under
# 2>/dev/null and left REF "now". --full=false then compared against the WRONG
# timestamp and, worse, $SINCE=0's seven-day default window was never applied.
# Try each dialect and, if all fail, fall back to a stamp that errs toward
# scanning MORE (an older reference), never fewer.
_stamp() {
  local e=$1
  # BSD: date -r <epoch>       GNU: date -d @<epoch>
  date -r "$e" +%Y%m%d%H%M.%S 2>/dev/null \
    || date -d "@$e" +%Y%m%d%H%M.%S 2>/dev/null
}
REF=$(mktemp)
STAMP=$(_stamp "$SINCE")
if [ -n "$STAMP" ]; then
  touch -t "$STAMP" "$REF" 2>/dev/null || rm -f "$REF" 2>/dev/null
fi
if [ ! -f "$REF" ]; then
  echo "sync: WARN could not set the since-reference from $SINCE; scanning ALL logs" >&2
  FULL=1
fi

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
# CAPTURE find's EXIT STATUS. A permission error on any scanned directory makes
# find exit 1 while printing nothing, which is indistinguishable from "no logs
# changed" — and that false negative is not harmless here: the run then advances
# $STATE, so the scans it missed are treated as already-hinted and those edits
# are never seen again. Measured 2026-10-23 (chmod 000 on a subdirectory:
# `find` status 1, zero matches). Same class as a fixed bug in kb-rehome.sh.
SCAN=$(mktemp)
if [ "$FULL" = 1 ]; then
  find "$SESSIONS" -name '*.jsonl' -print0 2>"$SCAN.err" > "$SCAN"
else
  find "$SESSIONS" -name '*.jsonl' -newer "$REF" -print0 2>"$SCAN.err" > "$SCAN"
fi
FIND_RC=$?
if [ "$FIND_RC" -ne 0 ]; then
  # Do NOT advance $STATE. Report the directories we could not read so the cause
  # is fixable rather than invisible.
  echo "sync: ERROR scanning $SESSIONS (exit $FIND_RC) — state NOT advanced, so the" >&2
  echo "      unscanned logs will be retried next run. Unreadable paths:" >&2
  sed -n '1,5p' "$SCAN.err" >&2 || true
  rm -f "$SCAN" "$SCAN.err" "$LIST" "$REF"
  exit 1
fi
rm -f "$SCAN.err"
xargs -0 -r python3 -c "$PARSE" < "$SCAN" 2>/dev/null | sort -u > "$LIST"
rm -f "$SCAN"

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
