#!/usr/bin/env bash
# C2 narrow-rehome test: content-verified disambiguation when basename hits are
# multiple. Uses a stub graft so no daemon is needed.
set -u
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

GRAFT="$TMP/graft"
cat > "$GRAFT" << 'EOF'
#!/usr/bin/env bash
case "$1" in
  get) echo '{"result":{"keywords":["kw1"]}}' ;;
  delete) exit 0 ;;
  insert) for a in "$@"; do echo "$a" >> /tmp/c2-inserted.log; done; exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$GRAFT"
export GRAFT
export HOME="$TMP"

# Old file was notes/report.md; body mentions a unique marker.
BODYF="$TMP/body.txt"
printf 'quarterly numbers for zzprojx marker\nsecond line detail\n' > "$BODYF"
DEAD="$HOME/work/notes/report.md"

# Two same-basename candidates: one content-near, one unrelated.
mkdir -p "$HOME/Desktop/a" "$HOME/Desktop/b"
printf 'quarterly numbers for zzprojx marker\nsecond line detail\n' > "$HOME/Desktop/a/report.md"
printf 'grocery list apples bananas\nnothing in common here\n' > "$HOME/Desktop/b/report.md"
HITS=$(printf '%s\n%s' "$HOME/Desktop/a/report.md" "$HOME/Desktop/b/report.md")

OUT=""
SCRIPT_DIR=$(cd "$(dirname "$0")/../../bin" && pwd)
VERDICT=$("$SCRIPT_DIR/kb-rehome.sh" deadbeef "$DEAD" "notes/report.md" "$BODYF" <(printf '%s\n' "$HITS"))
echo "multi-hit verdict: $VERDICT"
case "$VERDICT" in
  REBUILT\ *"Desktop/a/report.md"*) echo "PASS-REHOME-NEAR";;
  *) echo "FAIL: expected rehome of near-match, got: $VERDICT"; exit 1;;
esac
# Reviewer condition 2: rehome must carry a provenance note.
sleep 0.2
grep -q "rehomed by content match" /tmp/c2-inserted.log 2>/dev/null || { echo "FAIL: no provenance note in rebuilt body"; exit 1; }
echo "PASS-PROVENANCE-NOTE"

# Both candidates unrelated → NOTFOUND (remove).
printf 'totally different alpha\nbeta gamma delta\n' > "$HOME/Desktop/a/report.md"
printf 'grocery list apples bananas\nnothing in common here\n' > "$HOME/Desktop/b/report.md"
VERDICT2=$("$SCRIPT_DIR/kb-rehome.sh" deadbeef "$DEAD" "notes/report.md" "$BODYF" <(printf '%s\n%s' "$HOME/Desktop/a/report.md" "$HOME/Desktop/b/report.md"))
echo "unrelated verdict: $VERDICT2"
[ "$VERDICT2" = "NOTFOUND" ] || { echo "FAIL: expected NOTFOUND"; exit 1; }

# Single hit unchanged behavior still works (regression guard).
mkdir -p "$HOME/Desktop/solo"
printf 'anything at all\n' > "$HOME/Desktop/solo/report.md"
VERDICT3=$("$SCRIPT_DIR/kb-rehome.sh" deadbeef "$DEAD" "notes/report.md" "$BODYF" <(printf '%s\n' "$HOME/Desktop/solo/report.md"))
echo "single-hit verdict: $VERDICT3"
case "$VERDICT3" in REBUILT\ *) ;; *) echo "FAIL: single-hit should rebuild"; exit 1;; esac

echo "ALL-C2-PASS"
