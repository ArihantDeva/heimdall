#!/usr/bin/env bash
# kb-health.sh — Heimdall / @nanonets/graft health check.
# Verifies: graft CLI present, per-repo graphs built, search smoke passes,
# and — the part that matters most — that the index is not drifting.
# Exit 0 = healthy.
#
# Why the drift gate exists (2026-10-15): the eight structural checks below all
# passed while the index was actively rotting. Measured on the real machine:
#     heimdall score --count-only  ->  band "critical", errors 152, exit 1
#     heimdall doctor              ->  "HEALTHY",                 exit 0
# A health check that cannot fail on the signal that is red is worse than no
# health check: it launders a broken index into a green light. Every check below
# asks "is the plumbing installed", which stayed true the whole time. The final
# gate asks "does the store actually agree with the filesystem", which did not.
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
# GNU `timeout` is not in the default macOS userland, and macOS is the primary
# supported platform — a hard dependency here failed the smoke test before it
# even ran the command. Prefer whatever exists, fall back to perl (present on
# macOS + Linux by default), and run unguarded if neither does.
timeout_run() {
  if command -v timeout >/dev/null 2>&1; then timeout 15 "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout 15 "$@"
  elif command -v perl >/dev/null 2>&1; then perl -e 'alarm shift; exec @ARGV' 15 "$@"
  else "$@"
  fi
}
if timeout_run "$GRAFT" ask "function" "$FIRST" --json >/dev/null 2>&1; then
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

# 9. index truthfulness — the gate that can actually fail (2026-10-15).
#
# Everything above asks whether the plumbing is installed; none of it looks at
# the store. Drift is the one signal that means "retrieval is lying to you": a
# journal row in state=present for a file that no longer exists still answers
# searches with a path that is gone. That is measured two ways and both must be
# clean: `score` (graded 0-100, weighted so one missing anchor is 10 points) and
# `verify` (the raw drift rows, for a reason string the user can act on).
#
# `heimdall score` exits non-zero on a critical band, so the command itself is
# allowed to fail — we read its JSON either way rather than treating a non-zero
# exit as "no output".
# Resolving the CLI (issue #15 lesson): this script ships INSIDE the heimdall
# package, so it must not depend on `heimdall` being on PATH. Prefer the explicit
# override, then PATH, then the bin/heimdall.js sibling next to this file. When
# none resolve, the drift check is UNVERIFIABLE — say so loudly and continue,
# rather than hard-failing a minimal sandbox that has no index to measure.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEIMDALL_CMD=""
if [ -n "${HEIMDALL_BIN:-}" ] && command -v "$HEIMDALL_BIN" >/dev/null 2>&1; then
  HEIMDALL_CMD="$HEIMDALL_BIN"
elif command -v heimdall >/dev/null 2>&1; then
  HEIMDALL_CMD="heimdall"
elif [ -f "$SCRIPT_DIR/heimdall.js" ] && command -v node >/dev/null 2>&1; then
  HEIMDALL_CMD="node $SCRIPT_DIR/heimdall.js"
fi

if [ -z "$HEIMDALL_CMD" ]; then
  # No CLI. Two cases, and they differ in whether anything can be laundered:
  #
  #   an index EXISTS and cannot be measured -> FAIL. Reporting HEALTHY here is
  #     the defect this script was fixed to stop doing: the drift gate never ran,
  #     so the verdict would be unearned.
  #   NO index exists -> genuinely nothing to verify. A minimal sandbox with no
  #     index is the issue #15 portability case, and hard-failing it would be
  #     wrong for the opposite reason: it would report a problem where none
  #     exists. (tests/c11-observability.test.mjs pins this.)
  #
  # The existence test must cover every database this check actually inspects,
  # not just the default path. Adversarial review 2026-10-15 reproduced a false
  # "no index" verdict by pointing HEIMDALL_DB at a live global.db from an empty
  # sandbox HOME, and noted the graph verifier reads journal.db (bin/lib/depth.mjs),
  # so a journal-only install was misclassified as an empty sandbox too.
  _state="${HEIMDALL_HOME:-$HOME}"
  _found=""
  for _db in "${HEIMDALL_DB:-}" "$_state/.heimdall/global.db" "$_state/.heimdall/journal.db"; do
    if [ -n "$_db" ] && [ -e "$_db" ]; then _found="$_db"; break; fi
  done
  if [ -n "$_found" ]; then
    echo "FAIL: cannot verify index health — an index exists at $_found"
    echo "      but no heimdall CLI was found (PATH, \$HEIMDALL_BIN, or $SCRIPT_DIR/heimdall.js)."
    echo "      Health is UNKNOWN, not healthy — the drift gate never ran."
    echo "  Fix: put heimdall on PATH, or set HEIMDALL_BIN=/path/to/heimdall."
    exit 1
  fi
  echo "no index yet (no global.db or journal.db under $_state, and \$HEIMDALL_DB unset) — nothing to verify."
  echo "      Everything above only proves the plumbing is installed."
  echo "HEALTHY (no index)"
  exit 0
fi

HEALTH_JSON="$(timeout_run $HEIMDALL_CMD score --count-only 2>/dev/null || true)"

if [ -z "$HEALTH_JSON" ]; then
  fail "index health unreadable ($HEIMDALL_CMD score --count-only returned nothing).\
  A health check must never read a broken payload as healthy.\
  Fix: $HEIMDALL_CMD score --count-only   # see the error; the index may be unreadable"
fi

# Parse in python3 (already a dependency of this script) so a malformed payload
# fails loudly instead of silently reading as "healthy".
VERDICT="$(printf '%s' "$HEALTH_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("PARSE_ERROR " + str(e)); raise SystemExit(0)
score = d.get("score")
band = d.get("band", "?")
iss = d.get("issues", {}) or {}
errors = iss.get("errors", 0) or 0
warnings = iss.get("warnings", 0) or 0
infos = iss.get("infos", 0) or 0
print(f"OK {score} {band} {errors} {warnings} {infos}")
' 2>/dev/null || echo 'PARSE_ERROR python failed')"

case "$VERDICT" in
  PARSE_ERROR*)
    fail "index health payload unparseable (${VERDICT#PARSE_ERROR }).\
  A health check must never read a broken payload as healthy." ;;
  OK\ *)
    set -- $VERDICT
    _score="$2"; _band="$3"; _errors="$4"; _warnings="$5"; _infos="$6"
    ok "index score ${_score}/100 (${_band}); errors=${_errors} warnings=${_warnings} infos=${_infos}"
    if [ "$_band" != "healthy" ] || [ "$_errors" != "0" ]; then
      echo "FAIL: index is not healthy — score ${_score}/100, band ${_band}, errors ${_errors}."
      echo "  A missing anchor means a search can return a path that no longer exists."
      echo "  Fix: heimdall daemon --dry-run   # rehearsal, retracts nothing"
      echo "       heimdall reconcile --all    # converge for real (holds the lock)"
      echo "       heimdall verify             # confirm the drift is gone"
      exit 1
    fi ;;
  *)
    fail "unexpected index health verdict: $VERDICT" ;;
esac

# Raw drift rows, for a human-readable reason when the score says something is wrong.
#
# This block must be able to FAIL, not just decorate a pass. Before 2026-10-15 it
# was advisory in the worst way: unparseable output, EMPTY output, and a payload
# saying ok:false with no rows all fell through to `echo HEALTHY; exit 0`.
# Reproduced by adversarial review — `bad-verify`, `empty-verify` and
# `false-verify` each printed HEALTHY and exited 0. An unreadable drift payload is
# an UNKNOWN, and an unknown must never be reported as healthy.
#
# `ok` is the verifier verdict, not a schema constant. A valid ok:false
# payload can report real drift or a corrupt/unreadable graph. Keep it failing,
# but name the evidence and repair direction instead of claiming a broken schema.
DRIFT_JSON="$(timeout_run $HEIMDALL_CMD verify --json 2>/dev/null)"
DRIFT_RC=$?
if [ -z "$DRIFT_JSON" ]; then
  fail "index drift check returned nothing ($HEIMDALL_CMD verify --json produced no output, exit ${DRIFT_RC}).\
  Health is UNKNOWN, not healthy — an empty payload must never read as a pass.\
  Fix: $HEIMDALL_CMD verify --json   # see the error; the index may be unreadable"
fi
DRIFT_LINE="$(printf '%s' "$DRIFT_JSON" | python3 -c '
import json, sys, collections
# Preserve diagnostics even under an ASCII-only pipe encoding.
sys.stdout.reconfigure(errors="backslashreplace")
try:
    d = json.load(sys.stdin.buffer)
except Exception:
    print("PARSE_ERROR"); raise SystemExit(0)

def emit(token, message):
    print(token + " " + message)
    raise SystemExit(0)

# Validate shape, not the truth value: runVerify uses ok:false for real drift
# and for a broken graph. Neither is a malformed payload or a healthy index.
if not isinstance(d, dict):
    emit("SCHEMA_ERROR", "not-an-object")
if not isinstance(d.get("ok"), bool):
    emit("SCHEMA_ERROR", "ok-missing-or-not-boolean")
rows = d.get("drift")
if not isinstance(rows, list):
    emit("SCHEMA_ERROR", "drift-missing-or-not-a-list")
if any(not isinstance(r, dict) for r in rows):
    emit("SCHEMA_ERROR", "drift-row-not-an-object")
if any(not isinstance(r.get("why", "?"), str) for r in rows):
    emit("SCHEMA_ERROR", "drift-reason-not-a-string")
graph = d.get("graph", {})
if not isinstance(graph, dict):
    emit("SCHEMA_ERROR", "graph-not-an-object")
state = graph.get("state")
if "state" in graph and state not in ("present", "absent", "corrupt", "unreadable"):
    emit("SCHEMA_ERROR", "graph-state-not-recognized")
graph_broken = state in ("corrupt", "unreadable")
if d["ok"] and (rows or graph_broken):
    emit("SCHEMA_ERROR", "contradictory ok:true with drift rows or a broken graph")

if rows:
    c = collections.Counter(r.get("why", "?") for r in rows)
    reasons = "; ".join(f"{k}={v}" for k, v in c.most_common())
    graph_note = f" Graph store is {state}; inspect verify --json before repair." if graph_broken else ""
    emit("DRIFT", f"{len(rows)} drift row(s) - retrieval is stale for those paths ({reasons})." + graph_note)
if not d["ok"]:
    detail = f"the graph store is {state}" if graph_broken else "the verifier did not complete; health is UNKNOWN, not healthy"
    if graph_broken and isinstance(graph.get("why"), str):
        detail += " (" + graph["why"] + ")"
    emit("UNHEALTHY", "index verify reported ok=false with 0 drift rows - " + detail + ".")
emit("CLEAN", "no drift (0 row(s), verify ok)")
' 2>/dev/null || echo 'PARSE_ERROR')"
case "$DRIFT_LINE" in
  PARSE_ERROR)
    fail "index drift payload unparseable — health is UNKNOWN, not healthy.\
  A health check must never read a broken payload as healthy.\
  Fix: $HEIMDALL_CMD verify --json   # see the error" ;;
  SCHEMA_ERROR\ *)
    fail "index drift payload malformed (${DRIFT_LINE#SCHEMA_ERROR }) — health is UNKNOWN, not healthy.\
  Required: an object with boolean ok and drift as a LIST of row objects, without contradictory verdicts.\
  Fix: $HEIMDALL_CMD verify --json   # inspect the payload shape" ;;
  DRIFT\ *)
    echo "FAIL: ${DRIFT_LINE#DRIFT }"
    echo "  Fix: heimdall reconcile --all && heimdall verify"
    exit 1 ;;
  UNHEALTHY\ *)
    fail "${DRIFT_LINE#UNHEALTHY }\
  Health cannot be certified; a negative verdict is not a schema defect.\
  Fix: $HEIMDALL_CMD verify --json   # inspect the verifier or graph-store failure before repair" ;;
  CLEAN\ *)
    # A clean-looking payload cannot overrule a failing verifier process.
    if [ "${DRIFT_RC:-0}" != "0" ]; then
      fail "index verify exited ${DRIFT_RC} — health is UNKNOWN, not healthy.\
  A verifier that fails to complete cannot certify the index, even if its payload looks clean.\
  Fix: $HEIMDALL_CMD verify --json   # see the error"
    fi
    ok "${DRIFT_LINE#CLEAN }" ;;
  *)
    fail "unexpected index drift verdict: $DRIFT_LINE" ;;
esac

# Credential material in the index is a distinct class of un-health that the drift
# gates above CANNOT see. Measured 2026-10-15: `verify` reported ok:true drift:0
# and `score` reported 100/healthy while 231 cards containing ssh private keys,
# live API keys and 40 real .env files were being returned by `kb_search` - and
# kb-health printed HEALTHY. Every gate was green because a secret-bearing card is
# not drift; it is a row doing exactly what the index was built to do.
#
# A WARNING, not a hard failure, deliberately: this is advisory about index
# CONTENT, and a non-zero count must not turn a structurally healthy index into
# exit 1. tests/c11-observability.test.mjs pins that a minimal sandbox still
# passes. The point is that it is no longer SILENT.
CRED_COUNT="$(timeout_run $HEIMDALL_CMD credentials --count 2>/dev/null || true)"

case "${CRED_COUNT:-}" in
  ''|*[!0-9]*) : ;;  # unsupported here, unreadable, or no index: stay quiet
  *)
    if [ "$CRED_COUNT" -gt 0 ]; then
      echo ""
      echo "WARNING: ${CRED_COUNT} credential-bearing card(s) are retrievable from the index."
      echo "         These are files whose CONTENTS are secrets (ssh private keys,"
      echo "         auth.json / API keys, real .env files). Search output is sent to"
      echo "         third-party model providers, so a card that can be returned is an"
      echo "         exfiltration path."
      echo "         The verdict below reflects STRUCTURE (drift + score), not this."
      echo "  Fix: heimdall purge     # apply the exclusion policy to existing rows"
      echo "  Note: deleting a card does NOT un-leak the value - rotate the keys."
    fi ;;
esac

echo "HEALTHY"
