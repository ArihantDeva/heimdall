// journal.mjs — Heimdall's authoritative index. The graph is a projection of
// this; if they disagree, this wins and the graph gets rebuilt.
//
// Single-writer by construction: only the process holding the reconciler lock
// writes here (see lock.mjs). Concurrency is therefore not "locked against" —
// concurrent writers do not exist, so the delete+insert races that plagued the
// old direct-to-graft path are unrepresentable.
//
// All access uses bound parameters. The predecessor's hand-rolled LIKE escaping
// (kb-autosync.ts likeEsc, sync-edits.sh python escape) was a recurring source
// of correctness bugs; in a project whose whole claim is accuracy, string-built
// SQL is not acceptable.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS paths (
  path          TEXT PRIMARY KEY,
  hash          TEXT,
  size          INTEGER,
  mtime_ms      INTEGER,
  depth         TEXT,
  generation    INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'present',
  reconciled_at INTEGER
);
CREATE TABLE IF NOT EXISTS owned_nodes (
  node_id TEXT PRIMARY KEY,
  path    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  symbol  TEXT,
  line    INTEGER,
  label   TEXT,
  -- id assigned by the backend (graft). Nullable: the journal entry is written
  -- first and is authoritative, the projection catches up.
  sink_id TEXT
);
CREATE INDEX IF NOT EXISTS owned_nodes_path ON owned_nodes(path);
CREATE INDEX IF NOT EXISTS owned_nodes_symbol ON owned_nodes(symbol);
CREATE TABLE IF NOT EXISTS owned_edges (
  path     TEXT NOT NULL,
  src      TEXT NOT NULL,
  dst      TEXT NOT NULL,
  relation TEXT NOT NULL,
  line     INTEGER,
  PRIMARY KEY (path, src, dst, relation)
);
CREATE INDEX IF NOT EXISTS owned_edges_path ON owned_edges(path);
-- Edges whose target symbol has not been indexed yet. Owned by the SOURCE
-- file, resolved when the target's file is later reconciled. Without this,
-- reconcile order would change the final graph.
CREATE TABLE IF NOT EXISTS pending_edges (
  path       TEXT NOT NULL,
  src        TEXT NOT NULL,
  dst_symbol TEXT NOT NULL,
  relation   TEXT NOT NULL,
  line       INTEGER,
  PRIMARY KEY (path, src, dst_symbol, relation)
);
CREATE INDEX IF NOT EXISTS pending_edges_dst ON pending_edges(dst_symbol);
CREATE TABLE IF NOT EXISTS queue (
  path        TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  reason      TEXT
);
`;

export class Journal {
  /** @param {string} file path to journal.db */
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL so a reader (verify, search) never blocks the writer.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // Durability over speed: this file is the source of truth.
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ── queue ────────────────────────────────────────────────────────────────

  /**
   * Mark a path dirty. Idempotent by primary key: N agents hammering one file
   * produce ONE row, which is what collapses the high-contention case.
   * Bumps the generation so any reconcile already in flight for this path is
   * invalidated (see commit()).
   */
  enqueue(path, reason = "hint") {
    this.db
      .prepare(
        `INSERT INTO queue (path, enqueued_at, reason) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET enqueued_at = excluded.enqueued_at`,
      )
      .run(path, Date.now(), reason);
    this.db
      .prepare(
        `INSERT INTO paths (path, generation) VALUES (?, 1)
         ON CONFLICT(path) DO UPDATE SET generation = generation + 1`,
      )
      .run(path);
  }

  /** @returns {{path: string, reason: string}[]} */
  takeQueue(limit = 256) {
    return this.db
      .prepare(`SELECT path, reason FROM queue ORDER BY enqueued_at LIMIT ?`)
      .all(limit);
  }

  queueDepth() {
    return this.db.prepare(`SELECT COUNT(*) n FROM queue`).get().n;
  }

  dequeue(path) {
    this.db.prepare(`DELETE FROM queue WHERE path = ?`).run(path);
  }

  // ── path state ───────────────────────────────────────────────────────────

  getPath(path) {
    return this.db.prepare(`SELECT * FROM paths WHERE path = ?`).get(path) ?? null;
  }

  generation(path) {
    const r = this.db.prepare(`SELECT generation FROM paths WHERE path = ?`).get(path);
    return r ? r.generation : 0;
  }

  allPaths() {
    return this.db.prepare(`SELECT * FROM paths ORDER BY path`).all();
  }

  ownedNodes(path) {
    return this.db
      .prepare(`SELECT node_id, kind, symbol, line, label, sink_id FROM owned_nodes WHERE path = ?`)
      .all(path);
  }

  ownedEdges(path) {
    return this.db
      .prepare(`SELECT src, dst, relation, line FROM owned_edges WHERE path = ?`)
      .all(path);
  }

  /** Symbol -> node_id lookup, for resolving pending edges. */
  findSymbol(symbol) {
    return this.db
      .prepare(`SELECT node_id, path FROM owned_nodes WHERE symbol = ? LIMIT 1`)
      .get(symbol) ?? null;
  }

  /** Pending edges owned by this path, whatever they point at. */
  pendingFrom(path) {
    return this.db
      .prepare(
        `SELECT path, src, dst_symbol, relation, line FROM pending_edges WHERE path = ?`,
      )
      .all(path);
  }

  /** Pending edges anywhere in the graph that point at these symbols. */
  pendingFor(symbols) {
    if (!symbols.length) return [];
    const marks = symbols.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT path, src, dst_symbol, relation, line FROM pending_edges
         WHERE dst_symbol IN (${marks})`,
      )
      .all(...symbols);
  }

  // ── the one write path ───────────────────────────────────────────────────

  /**
   * Atomically replace everything owned by `path`.
   *
   * Returns false without writing if the path's generation moved since the
   * reconcile started — meaning a newer change landed and this result is
   * already stale. That check is what prevents the ABA race where a late
   * reconcile resurrects a node that a newer one deleted.
   *
   * @param {object} o
   * @param {string} o.path
   * @param {number} o.startGeneration generation observed when reconcile began
   * @param {string|null} o.hash        null when the file is absent
   * @param {number|null} o.size
   * @param {number|null} o.mtimeMs
   * @param {string} o.depth            depth actually achieved
   * @param {'present'|'absent'} o.state
   * @param {{node_id:string,kind:string,symbol?:string,line?:number}[]} o.nodes
   * @param {{src:string,dst:string,relation:string,line?:number}[]} o.edges
   * @param {{src:string,dst_symbol:string,relation:string,line?:number}[]} o.pending
   * @returns {boolean} true if committed
   */
  commit(o) {
    const db = this.db;
    let committed = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      const cur = db.prepare(`SELECT generation FROM paths WHERE path = ?`).get(o.path);
      const now = cur ? cur.generation : 0;
      if (now !== o.startGeneration) {
        db.exec("ROLLBACK");
        return false; // stale result — caller re-queues
      }

      // Ownership is exact: drop everything this path owned, then re-add.
      // A symbol node therefore cannot outlive the version of the file that
      // declared it.
      db.prepare(`DELETE FROM owned_nodes WHERE path = ?`).run(o.path);
      db.prepare(`DELETE FROM owned_edges WHERE path = ?`).run(o.path);
      db.prepare(`DELETE FROM pending_edges WHERE path = ?`).run(o.path);

      const insNode = db.prepare(
        `INSERT INTO owned_nodes (node_id, path, kind, symbol, line, label, sink_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const n of o.nodes) {
        insNode.run(
          n.node_id, o.path, n.kind, n.symbol ?? null,
          n.line ?? null, n.label ?? null, n.sink_id ?? null,
        );
      }
      const insEdge = db.prepare(
        `INSERT OR REPLACE INTO owned_edges (path, src, dst, relation, line) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const e of o.edges) {
        insEdge.run(o.path, e.src, e.dst, e.relation, e.line ?? null);
      }
      const insPending = db.prepare(
        `INSERT OR REPLACE INTO pending_edges (path, src, dst_symbol, relation, line) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const p of o.pending ?? []) {
        insPending.run(o.path, p.src, p.dst_symbol, p.relation, p.line ?? null);
      }

      db.prepare(
        `INSERT INTO paths (path, hash, size, mtime_ms, depth, generation, state, reconciled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash, size = excluded.size, mtime_ms = excluded.mtime_ms,
           depth = excluded.depth, state = excluded.state,
           reconciled_at = excluded.reconciled_at`,
      ).run(
        o.path, o.hash, o.size, o.mtimeMs, o.depth,
        o.startGeneration, o.state, Date.now(),
      );

      db.prepare(`DELETE FROM queue WHERE path = ?`).run(o.path);
      db.exec("COMMIT");
      committed = true;
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
    return committed;
  }

  /**
   * Promote pending edges into real edges once their target symbol exists.
   *
   * Called after a commit, in BOTH directions, which is what makes the final
   * graph independent of reconcile order:
   *   - `symbols`: edges other files parked waiting for what we just declared.
   *   - `path`:    edges WE just parked whose targets were already indexed.
   * Resolving only the first direction would silently drop every edge from a
   * newly-added file to an already-known one.
   *
   * Runs in its own transaction; safe to re-run (INSERT OR REPLACE + DELETE of
   * what resolved).
   *
   * @param {string[]} symbols symbols this commit introduced
   * @param {string}   [path]  path whose own pending edges should be retried
   */
  resolvePending(symbols, path = null) {
    const byKey = new Map();
    for (const r of [...this.pendingFor(symbols), ...(path ? this.pendingFrom(path) : [])]) {
      byKey.set(`${r.path}\0${r.src}\0${r.dst_symbol}\0${r.relation}`, r);
    }
    const rows = [...byKey.values()];
    if (!rows.length) return 0;
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    let n = 0;
    try {
      const ins = db.prepare(
        `INSERT OR REPLACE INTO owned_edges (path, src, dst, relation, line) VALUES (?, ?, ?, ?, ?)`,
      );
      const del = db.prepare(
        `DELETE FROM pending_edges WHERE path = ? AND src = ? AND dst_symbol = ? AND relation = ?`,
      );
      for (const r of rows) {
        const target = this.findSymbol(r.dst_symbol);
        if (!target) continue;
        ins.run(r.path, r.src, target.node_id, r.relation, r.line);
        del.run(r.path, r.src, r.dst_symbol, r.relation);
        n++;
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
    return n;
  }

  stats() {
    const one = (q) => this.db.prepare(q).get();
    return {
      paths: one(`SELECT COUNT(*) n FROM paths WHERE state = 'present'`).n,
      absent: one(`SELECT COUNT(*) n FROM paths WHERE state = 'absent'`).n,
      nodes: one(`SELECT COUNT(*) n FROM owned_nodes`).n,
      edges: one(`SELECT COUNT(*) n FROM owned_edges`).n,
      pending: one(`SELECT COUNT(*) n FROM pending_edges`).n,
      queued: one(`SELECT COUNT(*) n FROM queue`).n,
    };
  }
}
