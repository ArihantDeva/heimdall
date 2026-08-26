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
  -- machine capability (depth.mjs LEVELS max) at the last reconcile; audit
  -- uses it to tell "seen this capability" from "capability is new"
  cap_max       TEXT,
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
-- Fact history (C3): append-only supersession trail for FACT-kind nodes.
-- When a fact node is retracted (source edited past it, or source deleted),
-- its owned_nodes row would otherwise vanish. This table archives the row so
-- "what did we believe before" stays answerable. Code/symbol/file nodes are
-- NEVER archived: their retraction is not a belief change, just a file edit.
-- Columns mirror owned_nodes plus invalidated_at (ISO text, when it died) and
-- superseded_by (nullable node_id of the fact that replaced it — set only on
-- an unambiguous 1:1 swap; churn gets NULL rather than invented causality).
-- Deliberately OUT of the live retrieval surface: nothing projects this table.
CREATE TABLE IF NOT EXISTS fact_history (
  history_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id        TEXT NOT NULL,
  path           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  symbol         TEXT,
  line           INTEGER,
  label          TEXT,
  invalidated_at TEXT NOT NULL,
  superseded_by  TEXT
);
CREATE INDEX IF NOT EXISTS fact_history_path ON fact_history(path, invalidated_at);
`;

// Schema revision of this build. Bump whenever SCHEMA changes additively
// (v1: base tables + cap_max ALTER; v2: fact_history, C3). Every statement in
// SCHEMA is CREATE .*IF NOT EXISTS / guarded ALTER, so replaying is a no-op on
// an up-to-date database and brings an old one up to date; the version stamp
// only records how far the file has been migrated.
const SCHEMA_VERSION = 3;

// Retention: keep at most this many history rows per source path (newest
// win). Fact trails are dominated by line-shift noise on actively-edited
// logs; without a cap the table grows forever while answering less and less.
export const FACT_HISTORY_CAP = 50;

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
    // Migration: rows written before cap_max existed. Nullable column, so the
    // fix is one ALTER; NULL means "capability unknown" — audit flags such a
    // row ONCE so the next reconcile stamps it, then it converges.
    try {
      this.db.exec("ALTER TABLE paths ADD COLUMN cap_max TEXT");
    } catch (err) {
      // Only "already there" is fine to swallow; anything else (disk, schema
      // corruption) must surface — audit would crash later with a worse error.
      if (!/duplicate column/i.test(String(err?.message))) throw err;
    }
    // Versioned additive migration stamp: only ever moves forward. A NEWER
    // database opened by an OLDER binary keeps its higher version stamp
    // untouched (additive migrations replay as no-ops); this binary simply
    // doesn't know about newer columns. (C3 review M2: comment previously
    // overclaimed a downgrade guard that was never implemented.)
    const ver = Number(this.db.prepare(`PRAGMA user_version`).get()?.user_version ?? 0);
    if (ver < SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    // v3 migration (C3 review B1): fact text must live in the journal so the
    // history trail can answer "what did we believe". Additive, nullable;
    // pre-v3 rows backfill nothing — that text is unrecoverable.
    try {
      this.db.exec("ALTER TABLE owned_nodes ADD COLUMN fact_title TEXT");
      this.db.exec("ALTER TABLE owned_nodes ADD COLUMN fact_body TEXT");
      this.db.exec("ALTER TABLE fact_history ADD COLUMN fact_title TEXT");
      this.db.exec("ALTER TABLE fact_history ADD COLUMN fact_body TEXT");
    } catch (err) {
      if (!/duplicate column/i.test(String(err?.message))) throw err;
    }
  }

  close() {
    // Idempotent: cleanup paths (and tests) may close twice. node:sqlite
    // exposes isOpen, not an .open boolean.
    if (!this.db?.isOpen) return;
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

  /**
   * Archived (retracted) fact rows for one path, newest invalidation first.
   * Read-only audit surface — see the `heimdall history` verb. Timestamp ties
   * break on history_id (insertion order), because two retractions can land
   * inside the same millisecond.
   */
  factHistory(path) {
    return this.db
      .prepare(
        `SELECT * FROM fact_history WHERE path = ?
         ORDER BY invalidated_at DESC, history_id DESC`,
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
   * @param {string} [o.capMax]         machine capability at reconcile time
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

      // ── fact-history snapshot (C3) ──
      // Runs AFTER the generation guard and BEFORE the delete, inside this
      // BEGIN IMMEDIATE transaction — so a stale reconcile that is about to
      // roll back can never write a phantom history row, and BOTH retraction
      // shapes are covered by this one choke point: the update path
      // (reconcilePath's delete-and-reproject lands here) and the absent path
      // (file vanished → commit with nodes=[]).
      // Set arithmetic, not presence: outgoing = prior facts \ incoming.
      // A pure swap (one out, one genuinely NEW in) is a supersession; a
      // hot-path re-commit (same ids re-added) produces an empty diff and
      // stays silent. Facts that merely survive are neither in nor out.
      const incomingFactIds = new Set(
        o.nodes.filter((n) => n.kind === "fact").map((n) => n.node_id),
      );
      const priorFactIds = new Set(
        db.prepare(`SELECT node_id FROM owned_nodes WHERE path = ? AND kind = 'fact'`)
          .all(o.path).map((r) => r.node_id),
      );
      const addedIds = [...incomingFactIds].filter((id) => !priorFactIds.has(id));
      const outgoingFacts = db
        .prepare(`SELECT node_id, kind, symbol, line, label, fact_title, fact_body FROM owned_nodes WHERE path = ? AND kind = 'fact'`)
        .all(o.path)
        .filter((r) => !incomingFactIds.has(r.node_id));
      // H1 (C3 review): a fact whose node_id REAPPEARS in incoming after being
      // archived (delete → re-add same content) is live again — its archived
      // row is stale and must be purged so the "not advice" footer stays
      // truthful. Runs unconditionally: on a pure resurrection outgoing is
      // empty, which is exactly when the stale row would otherwise survive.
      db.prepare(`DELETE FROM fact_history WHERE path = ? AND node_id IN (
        SELECT json_each.value FROM json_each(?))`).run(o.path, JSON.stringify([...incomingFactIds]));
      if (outgoingFacts.length) {
        // superseded_by is recorded ONLY when exactly one fact left and
        // exactly one GENUINELY NEW fact took its place on the same path.
        // Any noisier churn gets NULL: linking line-shifted duplicates would
        // manufacture causality the extractor cannot prove (adversarial C3).
        const replacement =
          outgoingFacts.length === 1 && addedIds.length === 1
            ? addedIds[0]
            : null;
        const insHistory = db.prepare(
          `INSERT INTO fact_history (node_id, path, kind, symbol, line, label, invalidated_at, superseded_by, fact_title, fact_body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const nowIso = new Date().toISOString();
        for (const r of outgoingFacts) {
          insHistory.run(
            r.node_id, o.path, r.kind, r.symbol ?? null,
            r.line ?? null, r.label ?? null, nowIso, replacement,
            r.fact_title ?? null, r.fact_body ?? null,
          );
        }
        // Retention: newest FACT_HISTORY_CAP rows survive per source path.
        // history_id is monotonic, so "newest" is plain descending order.
        db.prepare(
          `DELETE FROM fact_history WHERE path = ? AND history_id NOT IN
             (SELECT history_id FROM fact_history WHERE path = ?
              ORDER BY history_id DESC LIMIT ?)`,
        ).run(o.path, o.path, FACT_HISTORY_CAP);
      }

      // Ownership is exact: drop everything this path owned, then re-add.
      // A symbol node therefore cannot outlive the version of the file that
      // declared it.
      db.prepare(`DELETE FROM owned_nodes WHERE path = ?`).run(o.path);
      db.prepare(`DELETE FROM owned_edges WHERE path = ?`).run(o.path);
      db.prepare(`DELETE FROM pending_edges WHERE path = ?`).run(o.path);

      const insNode = db.prepare(
        `INSERT INTO owned_nodes (node_id, path, kind, symbol, line, label, sink_id, fact_title, fact_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const n of o.nodes) {
        insNode.run(
          n.node_id, o.path, n.kind, n.symbol ?? null,
          n.line ?? null, n.label ?? null, n.sink_id ?? null,
          n.fact_title ?? null, n.fact_body ?? null,
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
        `INSERT INTO paths (path, hash, size, mtime_ms, depth, cap_max, generation, state, reconciled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash, size = excluded.size, mtime_ms = excluded.mtime_ms,
           depth = excluded.depth, cap_max = excluded.cap_max, state = excluded.state,
           reconciled_at = excluded.reconciled_at`,
      ).run(
        o.path, o.hash, o.size, o.mtimeMs, o.depth, o.capMax ?? null,
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
