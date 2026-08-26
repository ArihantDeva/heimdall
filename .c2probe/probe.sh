set -u
P=$(mktemp -d)
mkdir -p "$P/bin"
printf '#!/usr/bin/env bash\ncase "$1" in\n  get) echo '"'"'{"result":{"keywords":["k"]}'"'"';\n  insert) for a in "$@"; do echo "$a" >> "$PLOG"; done;\n  *) exit 0;\nesac\n' > "$P/bin/graft";chmod +x "$P/bin/graft";export GRAFT="$P/bin/graft" PLOG="$P/ins.log" HOME="$P";SCRIPT=/Users/arihantdeva/Repos/heimdall/bin/kb-rehome.sh
NEAR='quarterly numbers for zzprojx marker
second line detail'
FAR='grocery list apples bananas
nothing in common here'
BODYF="$P/body.txt"
printf '%s\n' "$NEAR" > "$BODYF"
run() { V=$(bash -x "$SCRIPT" abc123 "$HOME/work/notes/report.md" "notes/report.md" "$BODYF" "$HITSF")
 echo "[$1] verdict: $V"
 }
echo "== A: near-match under PATH WITH SPACE ==";mkdir -p "$P/Desktop/my dir" "$P/Desktop/b";printf '%s\n' "$NEAR" > "$P/Desktop/my dir/report.md"
printf '%s\n' "$FAR" > "$P/Desktop/b/report.md"
HITSF="$P/hitsA"
 printf '%s\n%s\n' "$P/Desktop/my dir/report.md" "$P/Desktop/b/report.md" > "$HITSF"
run "A-space-multi (want REHOME)"
echo "== F: single hit WITH SPACE ==";mkdir -p "$P/Desktop/solo dir"
printf '%s\n' "$NEAR" > "$P/Desktop/solo dir/report.md"
HITSF="$P/hitsF"
 printf '%s\n' "$P/Desktop/solo dir/report.md" > "$HITSF"
run "F-single-space (want REBUILT)"
echo "== B: in-between similarity ==";BODYF=/tmp/c2_between_body.txt
mkdir -p "$P/Desktop/m1" "$P/Desktop/m2"
cp /tmp/c2_between_cand.txt "$P/Desktop/m1/report.md"
printf '%s\n' "$FAR" > "$P/Desktop/m2/report.md"
HITSF="$P/hitsB"
 printf '%s\n%s\n' "$P/Desktop/m1/report.md" "$P/Desktop/m2/report.md" > "$HITSF"
run "B-between (want AMBIGUOUS)"
echo "== C: binary candidate + text near-match ==";BODYF="$P/body.txt"
mkdir -p "$P/Desktop/bin" "$P/Desktop/txt"
head -c 8192 /dev/urandom > "$P/Desktop/bin/report.md"
printf '%s\n' "$NEAR" > "$P/Desktop/txt/report.md"
HITSF="$P/hitsC"
 printf '%s\n%s\n' "$P/Desktop/bin/report.md" "$P/Desktop/txt/report.md" > "$HITSF"
rm -f "$PLOG"
run "C-binary-mix (want REHOME txt)";rg --no-ignore -c "rehomed by content match" "$PLOG" 2>/dev/null |  sed 's/^/provenance-note-count: /'
echo "== D: pipe char in winning path =="
mkdir -p "$P/Desktop/we|ird" "$P/Desktop/far2"
printf '%s\n' "$NEAR" > "$P/Desktop/we|ird/report.md"
printf '%s\n' "$FAR" > "$P/Desktop/far2/report.md"
HITSF="$P/hitsD"
 printf '%s\n%s\n' "$P/Desktop/we|ird/report.md" "$P/Desktop/far2/report.md" > "$HITSF"
run "D-pipe-path (want REHOME, suspect parse bug)"
echo "== E: empty node body ==";: > "$P/empty.txt"
 BODYF="$P/empty.txt"
HITSF="$P/hitsE"
 printf '%s\n%s\n' "$P/Desktop/txt/report.md" "$P/Desktop/b/report.md" > "$HITSF";run "E-empty-body (predict NOTFOUND)"
