#!/usr/bin/env bash
# kb-health.sh — knowledge-base / Graft health check.
# Verifies: daemon up (exactly one), CLI responsive, index populated, inventory fresh.
# Exit 0 = healthy. Prints a compact report; -v for detail.
# Usage: bash ~/knowledge-base/kb-health.sh [-v]
set -u
KB="$HOME/knowledge-base"
GRAFT="${GRAFT:-$HOME/.local/bin/graft}"
VERBOSE=0; [ "${1:-}" = "-v" ] && VERBOSE=1

fail() { echo "FAIL: $1"; exit 1; }
ok() { [ "$VERBOSE" = 1 ] && echo "ok: $1"; }

# 1. daemon healthy = stats responds. Socket-holder count is NOT the signal:
#    the embedding worker legitimately inherits the listening fd via fork
#    (shows as an extra "holder"). The storm symptom is always a hung CLI.
if timeout 10 "$GRAFT" stats >/dev/null 2>&1; then
  ok "graft stats responsive"
else
  echo "WARN: graft stats unresponsive — killing all graftd, letting launchd KeepAlive respawn one"
  pkill -f "graftd --config"; sleep 10
  if ! timeout 10 "$GRAFT" stats >/dev/null 2>&1; then
    echo "WARN: still down — kickstarting launchd job"
    launchctl kickstart -k gui/$(id -u)/com.graft.daemon 2>/dev/null || { nohup "$GRAFT"d --config "$HOME/.graft/config.yaml" > "$HOME/.graft/graftd.log" 2>&1 & }
    sleep 8
    timeout 10 "$GRAFT" stats >/dev/null 2>&1 || fail "graft stats (daemon unreachable)"
  fi
fi

# 2. CLI responsive (daemon reachable)
timeout 10 "$GRAFT" stats >/dev/null 2>&1 || fail "graft stats (daemon unreachable)"
ok "graft stats responsive"

# 3. search smoke (query path, not just stats)
HIT=$(timeout 15 "$GRAFT" query "personal website deploy" 2>/dev/null | grep -c '"hit"')
[ "${HIT:-0}" -gt 0 ] 2>/dev/null || fail "search smoke (graft query)"
ok "search smoke hit"

# 4. inventory freshness (tsv rows)
if [ -f "$KB/.inventory.tsv" ]; then
  R=$(wc -l < "$KB/.inventory.tsv" | tr -d ' ')
  [ "${R:-0}" -gt 50 ] || echo "WARN: inventory thin ($R rows) — run seed-graft.sh"
  ok "inventory $R rows"
else
  echo "WARN: .inventory.tsv missing — run seed-graft.sh"
fi

echo "HEALTHY"
