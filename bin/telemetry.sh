#!/usr/bin/env bash
# telemetry.sh — track whether Graft is actually working.
#   collect  → append one snapshot row to ~/knowledge-base/telemetry.tsv
#   view     → last N rows + trends (nodes/day, sync health, quality, usage)
#   usage    → kb_* tool calls in session logs, last 24h
# Snapshot row: epoch | iso | daemon | nodes | edges | keywords | insert_p50 | query_p50 | sync_age_h | gates | calls_24h | hit_rate | errors_24h | est_saved_h
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
TSV="$HOME/knowledge-base/telemetry.tsv"
KB="$HOME/knowledge-base"

collect() {
  local now epoch iso daemon nodes edges kws i50 q50 sync_age gates calls hr err saved
  now=$(date -u +%s); iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if command -v graft >/dev/null 2>&1 && graft stats >/dev/null 2>&1; then
    daemon=1
    local st; st=$(graft stats 2>/dev/null)
    read -r nodes edges kws i50 q50 <<<"$(printf '%s' "$st" | python3 -c '
import json,sys
d = json.load(sys.stdin).get("result") or {}
print(d.get("n_nodes",0), d.get("n_edges",0), d.get("n_keywords",0),
      (d.get("distributions") or {}).get("insert_topk",{}).get("p50",0),
      (d.get("distributions") or {}).get("query_top1",{}).get("p50",0))')"
    # value signals from graft analytics: hit rate, errors, estimated time saved
    local an; an=$(graft analytics --since 24h 2>/dev/null || echo "")
    read -r hr err saved <<<"$(printf '%s' "$an" | python3 -c '
import json,sys
try: d = json.load(sys.stdin)
except Exception: print("0 0 0"); sys.exit()
c = d.get("cache") or {}
strong=c.get("strong",0); weak=c.get("weak",0); miss=c.get("miss",0)
tot = strong+weak+miss
hr = round(strong/tot,3) if tot else 0
err = d.get("events",{}).get("errors",0)
saved = round((d.get("estimated_seconds_saved",0) or 0)/3600,1)
print(hr, err, saved)')"
  else
    daemon=0; nodes=0; edges=0; kws=0; i50=0; q50=0; hr=0; err=0; saved=0
  fi
  local last_sync; last_sync=$(cat "$HOME/.graft/.last-sync" 2>/dev/null || echo 0)
  sync_age=$(( (now - last_sync) / 3600 ))
  [ "$last_sync" = 0 ] && sync_age=-1
  if bash "$KB/.graft-verify.sh" >/dev/null 2>&1; then gates=1; else gates=0; fi
  calls=$(usage)
  echo "$now | $iso | $daemon | $nodes | $edges | $kws | $i50 | $q50 | $sync_age | $gates | $calls | $hr | $err | $saved" >> "$TSV"
  echo "collected: $iso nodes=$nodes daemon=$daemon sync_age=${sync_age}h gates=$gates calls_24h=$calls hit_rate=$hr errors_24h=$err est_saved_h=$saved"
}

usage() {
  # count ACTUAL kb_* tool invocations ("name": "kb_search" records) in session logs from the last 24h.
  # Main sessions log as <ts>_<uuid>.jsonl; subagent runs as <sub>/run-0/session.jsonl — glob *.jsonl covers both.
  # Counting raw mentions (earlier bug) inflated ~24x via AGENTS.md prompt text.
  find "$HOME/.pi/agent/sessions" -name '*.jsonl' -mtime -1 2>/dev/null \
    -exec grep -h -o '"name": *"kb_search"\|"name": *"kb_insert"\|"name": *"kb_sync"' {} + 2>/dev/null | wc -l | tr -d ' '
}

view() {
  local n=${1:-14}
  [ -f "$TSV" ] || { echo "no telemetry yet — run: bash $KB/telemetry.sh collect"; exit 1; }
  echo "== last $n snapshots (epoch | iso | daemon | nodes | edges | kws | ins_p50 | qry_p50 | sync_age_h | gates | calls_24h | hit_rate | errors_24h | est_saved_h)"
  tail -n "$n" "$TSV"
  local rows; rows=$(grep -cE '^[0-9]+ \|' "$TSV")
  if [ "$rows" -ge 2 ]; then
    local first last
    first=$(grep -E '^[0-9]+ \|' "$TSV" | sed -n '1p' | cut -d'|' -f4 | tr -d ' ')
    last=$(tail -1 "$TSV" | cut -d'|' -f4 | tr -d ' ')
    local days
    days=$(python3 -c "import sys; rows=[l for l in open('$TSV') if l.split('|')[0].strip().isdigit()]; a=int(rows[0].split('|')[0]); b=int(rows[-1].split('|')[0]); print(max(1, round((b-a)/86400,1)))")
    echo "-- nodes: $first → $last (+$((last-first)) over ~${days}d = $(python3 -c "print(int(round(($last-$first)/$days)))") nodes/day)"
    echo "-- last sync age: $(tail -1 "$TSV" | cut -d'|' -f9 | tr -d ' ')h | last daemon: $(tail -1 "$TSV" | cut -d'|' -f3 | tr -d ' ') | last gates: $(tail -1 "$TSV" | cut -d'|' -f10 | tr -d ' ')"
    echo "-- last hit_rate: $(tail -1 "$TSV" | cut -d'|' -f12 | tr -d ' ') | errors_24h: $(tail -1 "$TSV" | cut -d'|' -f13 | tr -d ' ') | est_saved_h: $(tail -1 "$TSV" | cut -d'|' -f14 | tr -d ' ')"
  else
    echo "-- only $rows snapshot(s) — collect again in ≥24h for trends"
  fi
}

case "${1:-view}" in
  collect) collect ;;
  view)    view "${2:-14}" ;;
  usage)   echo "kb_* calls (24h): $(usage)" ;;
  *) echo "usage: telemetry.sh {collect|view [N]|usage}"; exit 1 ;;
esac
