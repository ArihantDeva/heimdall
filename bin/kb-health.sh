#!/usr/bin/env bash
# kb-health.sh — Heimdall / @nanonets/graft health check.
# Verifies: graft CLI present, per-repo graphs built, search smoke passes.
# Exit 0 = healthy.
set -u
GRAFT="${GRAFT:-$(command -v graft 2>/dev/null || echo "$HOME/.local/bin/graft")}"
VERBOSE=0; [ "${1:-}" = "-v" ] && VERBOSE=1

fail() { echo "FAIL: $1"; exit 1; }
ok() { [ "$VERBOSE" = 1 ] && echo "ok: $1"; }

# 1. graft CLI present
if [ ! -x "$GRAFT" ]; then
  echo "SETUP NEEDED: graft binary not found at $GRAFT."
  echo "  Install: npm i -g @nanonets/graft"
  echo "  Then re-run: heimdall init"
  exit 1
fi
ok "graft CLI present ($GRAFT)"

# 2. version
V="$("$GRAFT" version 2>/dev/null | head -1)"
ok "graft $V"

# 3. at least one repo graph exists under ~/Repos
COUNT=0
for d in "$HOME"/Repos/*/; do
  [ -d "${d%/}/graft" ] && COUNT=$((COUNT+1))
done
if [ "$COUNT" -eq 0 ]; then
  echo "SETUP NEEDED: no repo graphs found under ~/Repos. For each repo: cd <repo> && graft build"
  exit 1
fi
ok "$COUNT repo graph(s) under ~/Repos"

# 4. search smoke: ask the first repo graph
FIRST="$(for d in "$HOME"/Repos/*/; do [ -d "${d%/}/graft" ] && echo "${d%/}" && break; done)"
if timeout 15 "$GRAFT" ask "function" "$FIRST" --json >/dev/null 2>&1; then
  ok "search smoke (graft ask)"
else
  fail "search smoke (graft ask) on $FIRST"
fi

# 5. semantic layer availability (C11): last transitions from semantic-state.json
STATE="$HOME/.heimdall/semantic-state.json"
if [ -f "$STATE" ]; then
  python3 - "$STATE" <<'PYEOF'
import json, sys, time
try:
    events = json.load(open(sys.argv[1]))[-200:]
except Exception:
    print("WARN: semantic-state.json unreadable"); raise SystemExit(0)
if not events:
    print("semantic availability: no transitions recorded yet")
    raise SystemExit(0)
last = events[-1]
age_min = round((time.time() - last["t"]) / 60)
streak = 0
for e in reversed(events):
    if e["state"] != last["state"]:
        break
    streak += 1
busy24 = sum(1 for e in events if e["state"] == "busy" and time.time() - e["t"] < 86400)
ok24 = sum(1 for e in events if e["state"] == "ok" and time.time() - e["t"] < 86400)
print(f"semantic availability: {last['state']} for {streak} transitions (last {age_min}m ago); 24h busy={busy24} ok={ok24}")
if last["state"] == "busy":
    print("WARN: semantic layer last seen BUSY — recent searches may have degraded to lexical-only")
PYEOF
else
  echo "semantic availability: no state recorded yet (embed-index.py records busy/ok transitions)"
fi

# 6. graft daemon config (heimdall setup output) + validity
CONFIG_YAML="$HOME/.graft/config.yaml"
GRAFTD=""
for c in "$HOME/.local/bin/graftd" "$HOME/Repos/graft-cpp/build/graftd" "$HOME/Repos/heimdall/vendor/graft/build/graftd"; do
  [ -x "$c" ] && GRAFTD="$c" && break
done

if [ ! -f "$CONFIG_YAML" ]; then
  echo "WARN: $CONFIG_YAML not found — semantic backend not configured yet. Run: heimdall setup"
else
ok "graft config present ($CONFIG_YAML)"

if [ -z "$GRAFTD" ]; then
  echo "SETUP NEEDED: graftd not found (~/.local/bin/graftd or vendor/graft/build/graftd). Run: heimdall setup"
  exit 1
fi
if "$GRAFTD" --check-config "$CONFIG_YAML" > /tmp/graft-check-config.$$ 2>&1; then
  ok "graft config valid (graftd --check-config)"
  [ "$VERBOSE" = 1 ] && cat /tmp/graft-check-config.$$
else
  cat /tmp/graft-check-config.$$ >&2
  echo "FAIL: graftd --check-config rejected $CONFIG_YAML. Re-run: heimdall setup"
  rm -f /tmp/graft-check-config.$$; exit 1
fi
rm -f /tmp/graft-check-config.$$

# 7. embedding model file exists + sane size (read model_path out of check-config output)
MODEL_PATH="$($GRAFTD --check-config "$CONFIG_YAML" 2>/dev/null | sed -n 's/^model_path: //p')"
if [ -z "$MODEL_PATH" ] || [ ! -f "$MODEL_PATH" ]; then
  echo "SETUP NEEDED: embedding model missing ($MODEL_PATH). Run: heimdall setup --model bge-m3"
  exit 1
fi
MODEL_MB=$(( $(stat -f%z "$MODEL_PATH" 2>/dev/null || stat -c%s "$MODEL_PATH" 2>/dev/null || echo 0) / 1024 / 1024 ))
if [ "$MODEL_MB" -lt 10 ]; then
  echo "SETUP NEEDED: embedding model too small (${MODEL_MB}MB at $MODEL_PATH). Re-run: heimdall setup"
  exit 1
fi
ok "embedding model present (${MODEL_MB}MB: $MODEL_PATH)"

# 8. launchd daemon installed + alive (macOS only; elsewhere informational)
PLIST="$HOME/Library/LaunchAgents/com.graft.daemon.plist"
if [ "$(uname)" = "Darwin" ]; then
  if [ ! -f "$PLIST" ] || ! plutil -lint "$PLIST" >/dev/null 2>&1; then
    echo "SETUP NEEDED: $PLIST missing/invalid. Run: heimdall setup"
    exit 1
  fi
  ok "launchd plist installed ($PLIST)"
  UID_N="$(id -u)"
  if launchctl print "gui/$UID_N/com.graft.daemon" 2>/dev/null | grep -q "state = running"; then
    ok "graft daemon running (launchd com.graft.daemon)"
  else
    echo "WARN: graft daemon not running — start with: heimdall setup (or launchctl bootstrap gui/$UID_N $PLIST)"
  fi
else
  ok "daemon: non-macOS — ensure graftd --config $CONFIG_YAML is running"
fi
fi # config-exists guard

echo "HEALTHY"
