#!/usr/bin/env bash
# graft-single.sh — ensure exactly ONE graft daemon runs for a profile.
#
# Root cause of daemon instability (2026-08-27): multiple graftd processes
# (manual launches + a stale launchd plist pointing at a missing binary)
# fought over the same socket/DB, crashing under embed load. This guard:
#   1. takes an exclusive flock (only one launcher at a time)
#   2. kills any stray graftd for THIS profile (socket match)
#   3. starts exactly one graftd, detached, with the CPU-safe config
#   4. waits for the socket, verifies with a query
#
# Usage: graft-single.sh [--profile longmemeval|default] [--foreground]
set -euo pipefail

PROFILE="${1:-longmemeval}"
SOCK="/tmp/graft-$PROFILE.sock"
GRAFTD="/Users/arihantdeva/Repos/heimdall/vendor/graft/build/graftd"
GRAFT="/Users/arihantdeva/Repos/heimdall/vendor/graft/build/graft"
CONFIG="/Users/arihantdeva/Repos/heimdall/vendor/graft/config.cpu.yaml"
LOCK="/tmp/graft-$PROFILE.lock"

# mkdir-based lock (portable, atomic — macOS has no flock). Only one
# launcher proceeds; others exit cleanly.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "graft-single: another launcher holds $LOCK; exiting" >&2
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# Kill stray daemons bound to THIS profile's socket only (a default-profile
# daemon must keep serving kb_search — one daemon PER PROFILE is the rule).
for pid in $(pgrep -f "graftd" || true); do
  if lsof -p "$pid" 2>/dev/null | grep -q "$SOCK"; then
    echo "graft-single: killing stray graftd pid $pid on $SOCK" >&2
    kill -9 "$pid" 2>/dev/null || true
  fi
done
sleep 1
rm -f "$SOCK"

DB="$HOME/.graft/profiles/$PROFILE/graft.db"
echo "graft-single: starting one $PROFILE daemon (CPU-safe config)" >&2
env GRAFT_SOCKET="$SOCK" GRAFT_DB_PATH="$DB" \
  "$GRAFTD" --config "$CONFIG" > "/tmp/graftd-$PROFILE.log" 2>&1 &

# Wait for socket readiness (up to 90s — model load takes a while).
for i in $(seq 1 90); do
  [ -S "$SOCK" ] && break
  sleep 1
done

if [ ! -S "$SOCK" ]; then
  echo "graft-single: daemon failed to start (no socket)" >&2
  tail -5 "/tmp/graftd-$PROFILE.log" >&2 || true
  exit 1
fi

# Verify with a query (fast, exercises the socket).
if timeout 15 env GRAFT_PROFILE="$PROFILE" "$GRAFT" query "probe" 2>/dev/null | grep -q '"status"'; then
  echo "graft-single: OK — one $PROFILE daemon on $SOCK" >&2
else
  echo "graft-single: daemon on $SOCK not responding to query" >&2
  exit 1
fi
