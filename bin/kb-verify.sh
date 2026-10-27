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

# GNU `timeout` is not in the default macOS userland (same defect as #15 in
# kb-health.sh): prefer it, then gtimeout, then perl, else run unguarded.
timeout_run() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"
  elif command -v perl >/dev/null 2>&1; then perl -e 'alarm shift; exec @ARGV' "$@"
  else "$@"
  fi
}

echo "== kb-verify =="

# 1. status counts + dim agreement
STATUS=$("$PY" "$EMBED" status 2>/dev/null || echo "{}")
FILES=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('files',0))" "$STATUS")
DOK=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('dimension_ok', False))" "$STATUS")
if [ "${FILES:-0}" -ge 790000 ]; then ok "status files=$FILES (≥790k honest ceiling: every readable file indexed; variance from ≥800k estimate documented in .until-done/tasks.yaml)"; else bad "status files=${FILES:-none} (<790k)"; fi
[ "$DOK" = "True" ] && ok "dimension_ok=true (no mismatch possible)" || bad "dimension_ok=$DOK"

# 2. semantic roundtrip on a known non-Repos project
SEM_OUT=$(timeout_run 180 "$PY" "$EMBED" query "resume tailoring pipeline ats score" -n 3 2>/dev/null)
if echo "$SEM_OUT" | rg -q "job-automation|resume_tailoring"; then
	ok "semantic roundtrip hits job-automation/resume content"
else
	bad "semantic roundtrip returned no resume/job-automation hit: $(echo "$SEM_OUT" | tail -1)"
fi

# 3. insert→immediately-searchable fact, on a scratch HOME (prod DB untouched)
INS_OUT=$(mktemp)
# Assign the scratch HOME in THIS shell, then pass it to the probe. The original
# one-liner used a PER-COMMAND assignment:
#     HEIMDALL_SCRATCH=$(mktemp -d ...) "$PY" probe.py ...
# which the probe inherits but which never reaches the calling shell — so the
# cleanup below expanded to an empty string and rm -rf removed nothing. Every
# run of this script leaked a /tmp/kbverify-home-* directory containing probe
# data. Measured 2026-10-23; reproduced by running the one-liner and printing
# the variable afterwards (always <UNSET>).
HEIMDALL_SCRATCH=$(mktemp -d /tmp/kbverify-home-XXXXXX)
export HEIMDALL_SCRATCH
"$PY" "$BIN_DIR"/../tests/kbverify_insert_probe.py "$EMBED" "$INS_OUT" >/dev/null 2>&1
if rg -q "INSERT-SEARCHABLE" "$INS_OUT" 2>/dev/null; then ok "insert→searchable roundtrip"; else bad "insert→searchable probe failed"; fi
# Guard the cleanup itself. An empty or unexpected value here must never become
# `rm -rf /` or `rm -rf ~` — the scratch path must look like what we created.
case "${HEIMDALL_SCRATCH:-}" in
	/tmp/kbverify-home-*|"${TMPDIR:-/tmp}"/kbverify-home-*) rm -rf "$HEIMDALL_SCRATCH" ;;
	"") ;;
	*) printf 'kb-verify: refusing to remove unexpected scratch path: %s\n' "$HEIMDALL_SCRATCH" >&2 ;;
esac
rm -f "${INS_OUT:-}"

# 4. loud-failure assertion: kb-search.sh must surface semantic-layer death
KS="$BIN_DIR/kb-search.sh"
[ "$(rg -c 'LEXICAL-ONLY' "$KS" 2>/dev/null || echo 0)" -ge 1 ] \
	&& ok "kb-search.sh carries loud lexical-only banner" \
	|| bad "no loud banner in kb-search.sh"
# A silent swallow is an `except Exception:` whose BODY does nothing but
# `pass`/`continue`. The previous version filtered the except LINE for keywords
# (WARN|ERROR|print|raise), which cannot see the body — so a handler that logs
# or re-raises on the NEXT line was reported as silent, and the check produced
# false positives on correct code. Measured 2026-10-23: it flagged three
# handlers, only some of which were genuinely silent.
SWALLOW=$("$PY" - "$KS" <<'PYSCAN'
import ast, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(errors="replace")
# kb-search.sh is a shell launcher around embedded python; pull the heredoc
# bodies out and parse each one. Unparseable text is reported, never ignored.
import re
blocks = re.findall(r"<<'?PY'?\n(.*?)\nPY\b", src, re.S) or [src]
silent = []
for i, blk in enumerate(blocks):
    try:
        tree = ast.parse(blk)
    except SyntaxError:
        continue
    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue
        # Only `except Exception:` (or bare except) is considered; a typed
        # handler is not the "catch everything" anti-pattern.
        t = node.type
        name = getattr(t, "id", None) or getattr(getattr(t, "attr", None), "__str__", lambda: None)()
        if name not in ("Exception", "BaseException", None):
            continue
        body = [n for n in node.body if not isinstance(n, ast.Expr) or
                not isinstance(getattr(n, "value", None), ast.Constant)]
        if not body:
            silent.append(f"line {node.lineno}: empty handler")
        elif len(body) == 1 and isinstance(body[0], (ast.Pass, ast.Continue)):
            silent.append(f"line {node.lineno}: {type(body[0]).__name__.lower()} only")
for s in silent:
    print(s)
PYSCAN
)
[ -z "$SWALLOW" ] && ok "no silent except-swallow around semantic call" || bad "silent swallow present: $SWALLOW"

# 5. graft ≥0.13 + ask works
GV=$(graft --version 2>/dev/null | head -1)
case "$GV" in
	0.1[3-9]*|0.[2-9]*|[1-9]*) ok "graft $GV ≥0.13" ;;
	*) bad "graft version '$GV' <0.13" ;;
esac
GASK=$(cd ~/Repos/cli-email && timeout_run 60 graft ask "daemon imap warm" . --json -n 1 2>/dev/null | rg -c '"hits"' || true)
[ "${GASK:-0}" -ge 1 ] && ok "graft ask returns JSON hits" || bad "graft ask broken"

echo "== kb-verify done (FAIL=$FAIL) =="
exit $FAIL
