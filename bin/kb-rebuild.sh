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
print(f"   backed up DB via sqlite backup API -> {sys.argv[1]}")
EOF
sqlite3 "$DB" "SELECT hex(id), title, body FROM nodes;" > "$BK/nodes.$TS.tsv" 2>/dev/null
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
print(f"   dumped {len(kw)} nodes to {sys.argv[1]}")
con.close()
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
EOF

echo "== 4/6 re-seed inventory + full-history edit sync"
bash "$HERE/seed-graft.sh" 2>&1 | tail -1
bash "$HERE/sync-edits.sh" --full 2>&1 | tail -1

echo "== 5/6 stale prune"
python3 "$HERE/kb-stale-scan.py" 2>&1 | tail -1

echo "== 6/6 verify"
~/.local/bin/graft stats 2>/dev/null | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; print('   nodes:', r['n_nodes'], '| edges:', r['n_edges'], '| keywords:', r['n_keywords'])"
