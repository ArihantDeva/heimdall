#!/usr/bin/env bash
# kb-rebuild.sh — full graph rebuild for maximum fidelity, parallel insert.
#   1. Safety: copy graft.db + JSON-dump every node (manual nodes have no file source).
#   2. Wipe graph tables (nodes/edges/keywords/vec/fts/similarity) — edges regenerate on insert.
#   3. Parallel restore: ThreadPoolExecutor re-inserts every dumped node (8 workers).
#   4. Re-seed inventory rows (seed-graft.sh) + full-history edit sync (sync-edits.sh --full).
#   5. Stale prune (kb-stale-scan.py) — dead anchors from old history get removed.
#   6. Verify: node/edge counts + smoke query.
# Usage: bash ~/knowledge-base/kb-rebuild.sh
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
KB="$HOME/knowledge-base"
# Sibling scripts live next to THIS file, wherever the package was installed.
# Resolving them through $KB only worked on the author's machine, and silently
# ran a different copy anywhere else.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="$HOME/.graft/profiles/default/graft.db"
TS=$(date +%Y%m%d-%H%M%S)
BK="$KB/backups"
mkdir -p "$BK"

# ── fail-fast helpers ──────────────────────────────────────────────────────
# This script DROPs every graph table. With `set -u` alone, a failed backup
# printed an error and the wipe ran anyway (measured 2026-10-23): total loss with
# exit 0. Every step that can destroy or strand data must therefore stop the run.
die() { echo "kb-rebuild: ABORT — $*" >&2; exit 1; }

echo "== 1/6 backup"
# sqlite backup API — consistent snapshot even under WAL (a plain cp of a live
# WAL db can be torn/incomplete).
python3 - "$BK/graft.db.$TS" <<'EOF'
import sqlite3, sys, os
src = os.path.expanduser("~/.graft/profiles/default/graft.db")
con = sqlite3.connect(src)
dst = sqlite3.connect(sys.argv[1])
con.backup(dst)
dst.close(); con.close()
# A backup that "succeeded" but wrote nothing is worse than a loud failure: the
# next step DROPs every table and this file is the only restore source.
if not os.path.exists(sys.argv[1]) or os.path.getsize(sys.argv[1]) == 0:
    print(f"   FATAL backup produced no data: {sys.argv[1]}", file=sys.stderr)
    sys.exit(1)
print(f"   backed up DB via sqlite backup API -> {sys.argv[1]} ({os.path.getsize(sys.argv[1])} bytes)")
EOF
BK_RC=$?
[ "$BK_RC" -eq 0 ] || die "sqlite backup failed (exit $BK_RC) — refusing to wipe the graph"
# The node list is a SECOND restore source and the only human-readable one. It
# was written with stderr to /dev/null, its exit status ignored, and no emptiness
# check — measured 2026-10-23: a valid-but-empty graft.db produced a 0-byte
# nodes.$TS.tsv and the run proceeded to the wipe. A backup that silently holds
# nothing is worse than a loud failure, because the next step DROPs the source.
if ! sqlite3 "$DB" "SELECT hex(id), title, body FROM nodes;" > "$BK/nodes.$TS.tsv" 2>"$BK/nodes.$TS.err"; then
	die "node list extraction failed (see $BK/nodes.$TS.err) — refusing to wipe the graph"
fi
if [ ! -s "$BK/nodes.$TS.tsv" ]; then
	# An empty database is legitimate, so this is not an error on its own — but
	# the node list must at least be written. Distinguish "no nodes" from
	# "the query did not run" by checking the source count.
	SRC_N=$(sqlite3 "$DB" "SELECT count(*) FROM nodes;" 2>/dev/null || echo "?")
	if [ "$SRC_N" != "0" ]; then
		die "node list is empty but the graph holds $SRC_N node(s) — extraction failed, refusing to wipe"
	fi
fi
rm -f "$BK/nodes.$TS.err" 2>/dev/null
echo "   node list saved -> $BK/nodes.$TS.tsv"

echo "== 2/6 dump all nodes (title/body/keywords) + wipe graph"
python3 - "$BK/nodes.$TS.json" <<'EOF'
import json, os, sqlite3, sys
db = os.path.expanduser("~/.graft/profiles/default/graft.db")
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
kw = {}
for row in con.execute("""SELECT hex(n.id) id, n.title, n.body, group_concat(k.text) kws
                          FROM nodes n LEFT JOIN node_keywords nk ON nk.node_id = n.id
                          LEFT JOIN keywords k ON k.id = nk.keyword_id
                          GROUP BY n.id"""):
    kw[row["id"]] = {"title": row["title"], "body": row["body"],
                     "keywords": (row["kws"] or "").split(",") if row["kws"] else []}
json.dump(list(kw.values()), open(sys.argv[1], "w"))
con.close()
if not os.path.exists(sys.argv[1]) or os.path.getsize(sys.argv[1]) == 0:
    sys.exit(1)

"""
EOF

# Stop the daemon so the wipe can't race it (launchd respawns on exit).
launchctl unload ~/Library/LaunchAgents/com.graft.daemon.plist 2>/dev/null || true
sleep 1
pkill -f "graftd --config" 2>/dev/null || true
sleep 1

echo "== 2b/6 wipe graph tables (DROP — FTS shadow tables reject DELETE)"
python3 - <<'EOF'
import sqlite3, sys, os
db = os.path.expanduser("~/.graft/profiles/default/graft.db")
con = sqlite3.connect(db)
# DROP the FTS5 PARENT first — its shadow tables (node_fts_*) cannot be
# deleted or dropped directly, but dropping the parent cascades to them.
# Drop content tables before parent nodes (FK cascade) — any order is safe
# for the graph content as long as node_fts goes before its shadows are used.
for t in ("node_fts", "node_fts_data", "node_fts_idx", "node_fts_docsize",
          "node_fts_config", "node_keywords", "keywords", "edges",
          "similarity_samples", "node_vec", "nodes"):
    try:
        con.execute(f"DROP TABLE IF EXISTS {t}")
    except Exception as e:
        print(f"   DROP {t}: {e}")
con.commit()
con.close()
print("   graph tables dropped")
EOF

# Recreate the schema (graft expects these tables; it may auto-create on start, but be explicit).
python3 - <<'EOF'
import sqlite3, os
db = os.path.expanduser("~/.graft/profiles/default/graft.db")
con = sqlite3.connect(db)
cur = con.cursor()
# nodes + FTS5 virtual table (mirror the live schema exactly)
cur.execute("CREATE TABLE nodes (id BLOB PRIMARY KEY, content_hash BLOB NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL, author TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0, last_access INTEGER NOT NULL DEFAULT 0, access_count INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0, origin INTEGER NOT NULL DEFAULT 0)")
cur.execute("CREATE VIRTUAL TABLE node_fts USING fts5(title, body, content='nodes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')")
# keyword + edge tables
cur.execute("CREATE TABLE keywords (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL UNIQUE COLLATE NOCASE, canonical_id INTEGER REFERENCES keywords(id), embedding BLOB)")
cur.execute("CREATE TABLE node_keywords (node_id BLOB NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, keyword_id INTEGER NOT NULL REFERENCES keywords(id), PRIMARY KEY (node_id, keyword_id))")
cur.execute("CREATE TABLE edges (src BLOB NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, dst BLOB NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, kind INTEGER NOT NULL, keyword_id INTEGER, weight REAL NOT NULL)")
cur.execute("CREATE TABLE node_vec(id BLOB PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, embedding BLOB NOT NULL)")
cur.execute("CREATE TABLE similarity_samples (ts INTEGER NOT NULL, kind INTEGER NOT NULL, cosine REAL NOT NULL)")
con.commit()
con.close()
print("   schema recreated")
EOF

# Relaunch the daemon (KeepAlive will also do this, but be explicit).
launchctl load ~/Library/LaunchAgents/com.graft.daemon.plist 2>/dev/null || true
sleep 2
if ! graft stats >/dev/null 2>&1; then
  nohup graftd --config ~/.graft/config.yaml > ~/.graft/graftd.log 2>&1 &
  sleep 3
fi
graft stats 2>/dev/null | grep -E 'n_nodes' | sed 's/^/   graft /' || echo "   WARN: daemon not up after wipe"

echo "== 3/6 parallel restore"
python3 - "$BK/nodes.$TS.json" <<'EOF'
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
nodes = json.load(open(sys.argv[1]))
def ins(n):
    args = ["graft", "insert", "--title", n["title"], "--body", n["body"] or ""]
    for k in (n.get("keywords") or []):
        if k: args += ["--keyword", k]
    return subprocess.run(args, capture_output=True, text=True, timeout=60).returncode
ok = fail = 0
with ThreadPoolExecutor(max_workers=8) as ex:
    futs = [ex.submit(ins, n) for n in nodes]
    for f in as_completed(futs):
        if f.result() == 0: ok += 1
        else: fail += 1
print(f"   restored {ok} nodes ({fail} failed) in parallel")
# The graph was already DROPped, so the JSON dump is now the only copy of these
# nodes. A non-zero fail count means those nodes exist nowhere else.
sys.exit(1 if fail else 0)
EOF
RS_RC=$?
[ "$RS_RC" -eq 0 ] || die "restore failed (exit $RS_RC) — nodes are ONLY in $BK/nodes.$TS.json, graph left EMPTY. Re-run the restore before anything else."

echo "== 4/6 re-seed inventory + full-history edit sync"
# Steps 1-3 are fail-closed; 4-6 discarded every exit status and piped straight
# into `tail -1`, so a rebuild whose re-seed, sync and prune ALL failed still
# printed 6/6 and exited 0 (measured 2026-10-23). A rebuild is the one command
# whose whole job is fidelity — reporting success over a partial restore is worse
# than failing loudly, because the caller stops looking.
# `set -o pipefail` is NOT set here, so capture the status explicitly.
SEED_OUT=$(bash "$HERE/seed-graft.sh" 2>&1); SEED_RC=$?
[ -n "$SEED_OUT" ] && printf '%s\n' "$SEED_OUT" | tail -1
SYNC_OUT=$(bash "$HERE/sync-edits.sh" --full 2>&1); SYNC_RC=$?
[ -n "$SYNC_OUT" ] && printf '%s\n' "$SYNC_OUT" | tail -1

echo "== 5/6 stale prune"
# The prune is best-effort by design: it refuses a mass delete on purpose (see
# the circuit breaker), and exit 1 there means "I protected you", not "I failed".
# So it is reported, never fatal.
PRUNE_OUT=$(python3 "$HERE/kb-stale-scan.py" 2>&1); PRUNE_RC=$?
[ -n "$PRUNE_OUT" ] && printf '%s\n' "$PRUNE_OUT" | tail -1

echo "== 6/6 verify"
~/.local/bin/graft stats 2>/dev/null | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; print('   nodes:', r['n_nodes'], '| edges:', r['n_edges'], '| keywords:', r['n_keywords'])"

# Only steps whose failure means the graph is INCOMPLETE are fatal.
if [ "$SEED_RC" -ne 0 ] || [ "$SYNC_RC" -ne 0 ]; then
	die "re-seed (exit $SEED_RC) or edit sync (exit $SYNC_RC) failed — the graph is complete enough to serve but missing inventory/history rows. Re-run: bash $HERE/seed-graft.sh; bash $HERE/sync-edits.sh --full"
fi
[ "$PRUNE_RC" -eq 0 ] || echo "   note: stale prune exited $PRUNE_RC (a refused mass delete is not an error)"
