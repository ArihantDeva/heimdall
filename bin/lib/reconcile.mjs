// reconcile.mjs — level-triggered convergence.
//
// A queued path is a hint that SOMETHING changed, never a description of what.
// reconcile() reads the file's current state from disk and makes the graph
// match it. It never replays events, so it cannot be confused by a missed
// event, an out-of-order event, or forty agents editing one file.
//
// Running it twice is identical to running it once. That single property is
// what makes concurrent edits harmless.
import { existsSync, statSync } from "node:fs";
import { desiredState, runBridge } from "./extract.mjs";
import { depthFor, rank } from "./depth.mjs";
import { renderNode } from "./sink.mjs";

/** Paths we never index. Mirrors the old autosync skip(), kept as the one place. */
export function skipPath(path, home) {
  if (!path.startsWith("/")) return true;
  if (path.startsWith("/tmp/") || path.startsWith("/private/tmp/")) return true;
  if (home) {
    if (path.startsWith(`${home}/.`)) return true;
    if (path.startsWith(`${home}/Library/`)) return true;
  }
  return /\/(node_modules|\.git|__pycache__|\.venv|venv|dist|build|DerivedData|Pods|\.build)\//.test(path);
}

/**
 * Reconcile one path.
 *
 * @param {object} ctx
 * @param {import('./journal.mjs').Journal} ctx.journal
 * @param {object} ctx.sink
 * @param {object} [ctx.config]
 * @param {object} [ctx.cap]
 * @param {Map}    [ctx.bridged] pre-computed bridge output for batch runs
 * @param {string} path absolute
 * @returns {{action: string, path: string, nodes?: number, depth?: string, reason?: string}}
 */
export function reconcilePath(ctx, path) {
  const { journal, sink } = ctx;
  const startGeneration = journal.generation(path);

  // ── absent: retract everything this path owns ──────────────────────────
  if (!existsSync(path) || !safeIsFile(path)) {
    const owned = journal.ownedNodes(path);
    for (const n of owned) if (n.sink_id) sink.delete(n.sink_id);
    const ok = journal.commit({
      path, startGeneration,
      hash: null, size: null, mtimeMs: null,
      depth: "path", capMax: ctx.cap?.max ?? null, state: "absent",
      nodes: [], edges: [], pending: [],
    });
    return ok
      ? { action: "retracted", path, nodes: owned.length }
      : { action: "stale", path };
  }

  const { effective } = depthFor(path, ctx.config, ctx.cap);
  const prior = journal.getPath(path);
  const priorNodes = journal.ownedNodes(path);

  // ── unchanged: the hot path ────────────────────────────────────────────
  // Forty agents editing one file collapse to one hash comparison.
  let desired;
  try {
    desired = desiredState(path, effective, { bridged: ctx.bridged, cap: ctx.cap });
  } catch (err) {
    // Unreadable/ vanished mid-drain: dequeue so the caller's drain loop
    // terminates instead of spinning on this row forever, but leave any prior
    // journal row untouched (the file may just be temporarily locked). The
    // next hint or audit re-queues it.
    journal.dequeue(path);
    return { action: "error", path, reason: err.message };
  }
  if (
    prior && prior.state === "present" &&
    prior.hash === desired.hash && prior.depth === desired.depth
  ) {
    // Hot path still re-stamps cap_max when the capability changed since the
    // last reconcile — without this, a capability bounce (tree-sitter
    // removed/reinstalled) leaves a stale record on a file whose content
    // never changes again. The commit is ownership-exact, so it must be
    // handed back everything the path currently owns; passing empty arrays
    // here would wipe the file's nodes while claiming present/depth.
    if (prior.cap_max !== (ctx.cap?.max ?? null)) {
      journal.commit({
        path, startGeneration,
        hash: desired.hash, size: desired.size, mtimeMs: desired.mtimeMs,
        depth: desired.depth, capMax: ctx.cap?.max ?? null, state: "present",
        nodes: priorNodes.map((n) => ({ ...n })),
        edges: journal.ownedEdges(path), pending: journal.pendingFrom(path),
      });
    } else {
      journal.dequeue(path);
    }
    return { action: "unchanged", path, depth: desired.depth };
  }

  // ── changed: project, then commit ──────────────────────────────────────
  // Sink writes happen BEFORE the journal commit. A crash in between leaves the
  // path dirty, so it is redone — safe precisely because reconcile is
  // idempotent. The reverse order could mark a path clean that was never
  // projected, which is the one failure we cannot detect later.
  const priorBySymbol = new Map(priorNodes.map((n) => [n.node_id, n]));

  const nodes = [];
  for (const n of desired.nodes) {
    const existing = priorBySymbol.get(n.node_id);
    // Content changed, so every node for this path is re-projected. Reusing a
    // sink id whose content moved would leave a stale embedding behind.
    if (existing?.sink_id) sink.delete(existing.sink_id);
    let sink_id = null;
    if (sink.available) {
      try {
        sink_id = sink.insert(renderNode({ ...n, language: n.language }, path));
      } catch (err) {
        // Dequeue like the error path: the CLI/daemon drain loop would
        // otherwise spin on this row forever while the sink is down.
        journal.dequeue(path);
        return { action: "deferred", path, reason: `sink: ${err.message?.split("\n")[0]}` };
      }
    }
    nodes.push({ ...n, sink_id });
  }
  // Nodes that existed before and are gone now.
  const desiredIds = new Set(desired.nodes.map((n) => n.node_id));
  for (const n of priorNodes) {
    if (!desiredIds.has(n.node_id) && n.sink_id) sink.delete(n.sink_id);
  }

  const ok = journal.commit({
    path, startGeneration,
    hash: desired.hash, size: desired.size, mtimeMs: desired.mtimeMs,
    depth: desired.depth, capMax: ctx.cap?.max ?? null, state: "present",
    nodes, edges: desired.edges, pending: desired.pending,
  });
  if (!ok) return { action: "stale", path };

  // New symbols may satisfy edges other files parked earlier. This is what
  // makes the final graph independent of reconcile order.
  const symbols = nodes.map((n) => n.symbol).filter(Boolean);
  const resolved = journal.resolvePending(symbols, path);

  return {
    action: prior ? "updated" : "indexed",
    path, nodes: nodes.length, depth: desired.depth, resolved,
  };
}

function safeIsFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * Drain the queue. Batches tree-sitter work into one python invocation per
 * round, which is the difference between a startup sweep taking minutes and
 * taking hours.
 */
export function drain(ctx, { limit = 256 } = {}) {
  const { journal } = ctx;
  const batch = journal.takeQueue(limit);
  if (!batch.length) return { processed: 0, results: [] };

  const needsBridge = [];
  for (const { path } of batch) {
    if (!existsSync(path)) continue;
    const { effective } = depthFor(path, ctx.config, ctx.cap);
    if (rank(effective) >= rank("symbol")) needsBridge.push(path);
  }
  const bridged = needsBridge.length ? runBridge(needsBridge, ctx.cap) : new Map();

  const results = [];
  for (const { path } of batch) {
    results.push(reconcilePath({ ...ctx, bridged }, path));
  }
  return { processed: results.length, results };
}

/**
 * Audit: compare the journal against the filesystem and re-queue anything that
 * drifted. This is the backstop for daemon downtime and for writes the watcher
 * never saw — and it is what turns the accuracy claim into a command you can
 * run in CI.
 *
 * stat-only for unchanged files, so it is cheap enough to run on a timer.
 */
export function audit(ctx, { deep = false, enqueue = true } = {}) {
  const { journal } = ctx;
  const drift = [];
  for (const row of journal.allPaths()) {
    const there = existsSync(row.path) && safeIsFile(row.path);
    if (row.state === "present" && !there) {
      drift.push({ path: row.path, why: "missing" });
      continue;
    }
    if (row.state === "absent" && there) {
      drift.push({ path: row.path, why: "reappeared" });
      continue;
    }
    if (!there) continue;
    const st = statSync(row.path);
    // mtime+size is the cheap screen; --deep re-hashes everything and catches
    // a same-size same-mtime rewrite (rare, but it is exactly the case a
    // "cannot be wrong" claim has to cover).
    if (deep) {
      let h = null;
      try { h = desiredState(row.path, "path").hash; } catch { /* unreadable */ }
      if (h && h !== row.hash) drift.push({ path: row.path, why: "hash" });
    } else if (st.size !== row.size || Math.floor(st.mtimeMs) !== row.mtime_ms) {
      drift.push({ path: row.path, why: "mtime/size" });
    }
    // A depth upgrade (tree-sitter newly installed) is also drift — but a
    // capability the row has ALREADY SEEN is not. A file whose language has no
    // tree-sitter extractor (.md) or that failed to parse settles below
    // cap.max forever; re-flagging it every audit made `heimdall verify`
    // permanently red and reconcile --all could never clear it.
    // Legacy rows (cap_max NULL, pre-migration) are flagged ONCE so the next
    // reconcile stamps them; after that they converge like any other row.
    const { effective } = depthFor(row.path, ctx.config, ctx.cap);
    const seen = row.cap_max != null && row.cap_max === ctx.cap?.max;
    if (rank(effective) > rank(row.depth ?? "path") && !seen) {
      drift.push({ path: row.path, why: `depth ${row.depth} -> ${effective}` });
    }
  }
  // `heimdall verify` wants the report without mutating anything, so drift
  // detection and drift repair are separable.
  if (enqueue) for (const d of drift) journal.enqueue(d.path, `audit:${d.why}`);
  return drift;
}
