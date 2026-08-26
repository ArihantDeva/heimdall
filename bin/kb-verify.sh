#!/usr/bin/env bash
# kb-verify.sh — end-to-end health gate for the Heimdall knowledge base.
# Exits 0 only if every layer works: status counts, semantic roundtrip,
# insert→searchable fact (scratch index), loud-failure assertion, graft ≥0.13.
set -u
BIN_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PY="$HOME/.heimdall/venv/bin/python3"
EMBED="$BIN_DIR/embed-index.py"
FAIL=0
ok()   { echo "  ok    $1"; }
bad()  { echo "  FAIL  $1"; FAIL=1; }

echo "== kb-verify =="

# 1. status counts + dim agreement
STATUS=$("$PY" "$EMBED" status 2>/dev/null || echo "{}")
FILES=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('files',0))" "$STATUS")
DOK=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('dimension_ok', False))" "$STATUS")
if [ "${FILES:-0}" -ge 800000 ]; then ok "status files=$FILES (≥800k)"; else bad "status files=${FILES:-none} (<800k)"; fi
[ "$DOK" = "True" ] && ok "dimension_ok=true (no mismatch possible)" || bad "dimension_ok=$DOK"

# 2. semantic roundtrip on a known non-Repos project
SEM_OUT=$(timeout 180 "$PY" "$EMBED" query "resume tailoring pipeline ats score" -n 3 2>/dev/null)
if echo "$SEM_OUT" | rg -q "job-automation|resume_tailoring"; then
	ok "semantic roundtrip hits job-automation/resume content"
else
	bad "semantic roundtrip returned no resume/job-automation hit: $(echo "$SEM_OUT" | tail -1)"
fi

# 3. insert→immediately-searchable fact, on a scratch HOME (prod DB untouched)
INS_OUT=$(mktemp)
HEIMDALL_SCRATCH=$(mktemp -d /tmp/kbverify-home-XXXXXX) "$PY" "$BIN_DIR"/../tests/kbverify_insert_probe.py "$EMBED" "$INS_OUT" >/dev/null 2>&1
if rg -q "INSERT-SEARCHABLE" "$INS_OUT" 2>/dev/null; then ok "insert→searchable roundtrip"; else bad "insert→searchable probe failed"; fi
rm -rf "${HEIMDALL_SCRATCH:-}" "$INS_OUT"

# 4. loud-failure assertion: kb-search.sh must surface semantic-layer death
KS="$BIN_DIR/kb-search.sh"
[ "$(rg -c 'LEXICAL-ONLY' "$KS" 2>/dev/null || echo 0)" -ge 1 ] \
	&& ok "kb-search.sh carries loud lexical-only banner" \
	|| bad "no loud banner in kb-search.sh"
SWALLOW=$(rg -n "except Exception:" "$KS" | rg -v "WARN|ERROR|print|raise|SystemExit" | head -3)
[ -z "$SWALLOW" ] && ok "no silent except-swallow around semantic call" || bad "silent swallow present: $SWALLOW"

# 5. graft ≥0.13 + ask works
GV=$(graft --version 2>/dev/null | head -1)
case "$GV" in
	0.1[3-9]*|0.[2-9]*|[1-9]*) ok "graft $GV ≥0.13" ;;
	*) bad "graft version '$GV' <0.13" ;;
esac
GASK=$(cd ~/Repos/cli-email && timeout 60 graft ask "daemon imap warm" . --json -n 1 2>/dev/null | rg -c '"hits"' || true)
[ "${GASK:-0}" -ge 1 ] && ok "graft ask returns JSON hits" || bad "graft ask broken"

echo "== kb-verify done (FAIL=$FAIL) =="
exit $FAIL
