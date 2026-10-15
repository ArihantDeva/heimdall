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

/**
 * Paths we never index. Mirrors the old autosync skip(), kept as the one place.
 *
 * EPHEMERAL_ROOTS exists because the original rule spelled scratch space as
 * "/tmp/", and on macOS that is not where scratch space lives: $TMPDIR is
 * /var/folders/<2 chars>/<hash>/T/. Measured 2026-10-15, the live journal held
 * 128 rows under /var/folders. Their files are cleaned by the OS, so every one
 * became a permanent `missing` anchor — 10 points each on the health score, and
 * a search could still return a path that no longer exists. A rule written to
 * exclude scratch space has to name the scratch space the platform actually
 * uses.
 */
const EPHEMERAL_PREFIXES = [
  "/tmp/", "/private/tmp/",
  // macOS per-user temp: /var/folders/xx/xxxxxxxxxxxxxxxx/T/...
  "/var/folders/",
  // The RESOLVED form of the two lines above. macOS ships /tmp as a symlink to
  // /private/tmp and /var to /private/var, so a rule on the symlink form alone
  // leaves the real path uncaught — exactly how /private/etc slipped through
  // until 2026-10-15. `/private/var/folders/` is listed separately from
  // `/private/var/`: the latter would also swallow /private/var/db and other
  // genuinely readable state, and only the per-user T/ scratch is ephemeral.
  "/private/var/folders/",
  // Application bundles are not user content and change on every app update.
  "/Applications/",
  // System configuration is not memory. /etc/cups/printers.conf is rewritten by
  // cupsd on every print/queue change, so it can never be a stable anchor: it
  // produced permanent, unfixable `mtime/size` + `depth` drift on 2026-10-15 and
  // was the last thing keeping `verify` from reporting ok. Ordinary readable
  // state is what /etc holds, and none of it is something the user authored.
  "/etc/",
  // The SAME system config reached by its resolved path. macOS ships /etc as a
  // symlink to /private/etc, and /tmp to /private/tmp, so a rule on the symlink
  // form alone leaves the real path uncaught. Measured 2026-10-15: after the
  // /etc rule was added, `/private/etc/cups/printers.conf` STILL produced two
  // drift rows (it is rewritten by cupsd on every print/queue change, so it can
  // never be a stable anchor); the `/` + `etc` form never matched. /private/tmp
  // and /private/var were already listed for the same reason — the /etc entry
  // was simply the one that had no resolved-path twin.
  "/private/etc/",
  // Harness scratch space. `.pi/tmp/` is named tmp and holds throwaway
  // simulation copies — measured 2026-10-15: `~/.pi/tmp/sim1` was a stale
  // Sep-16 SNAPSHOT OF THE HEIMDALL REPO itself (289 cards), so retrieval for
  // "reconciler single writer" ranked `.pi/tmp/sim1/bin/heimdall-reconciler.mjs`
  // ABOVE the live source it was copied from (hash 397f7010cd58 vs the real
  // e067de392797). A stale duplicate of a repo is worse than no hit: it returns
  // a plausible path whose content is not what the user is editing.
  // Only `tmp/` is listed, NOT `.pi/` — `.pi/agent/` is excluded at the walker
  // for tool internals while `~/.pi/agent/sessions/` is kept as the P3 fact
  // source, and a bare `.pi/` here would silently drop that.
  "/.pi/tmp/",
  // Extraction of a stale published tarball, not the user's working copy.
  // Measured 2026-10-15: `~/heim-build-check/package/` is an unpacked
  // arihantdeva-heimdall-0.12.2.tgz whose mtimes npm stamped 1985-10-26, so it
  // reports `as_of=14963.9d` and ranked ABOVE the live source for "reconciler
  // single writer". Its content is byte-identical to the ~/.pi/tmp/sim1 copy
  // (both sha 397f7010cd58) while the working tree is e067de392797.
];

/**
 * Prefixes matched against the HOME-RELATIVE path, i.e. `${home}/` + entry.
 *
 * Separate from EPHEMERAL_PREFIXES because these are not absolute filesystem
 * locations — they are the user's own scratch directories under $HOME, so a
 * leading-slash entry can never match them. Adversarial review 2026-10-15
 * caught exactly that mistake: `/heim-build-check/package/` was listed in
 * EPHEMERAL_PREFIXES, which meant the real ~/heim-build-check/package/ path
 * stayed ADMISSIBLE (admission, hints and evictExcluded all share skipPath)
 * while a nonexistent root-level path would have been excluded.
 */
const HOME_SCRATCH_PREFIXES = [
  "heim-build-check/package/",
];

export function skipPath(path, home) {
  if (!path.startsWith("/")) return true;
  // Collapse runs of leading slashes BEFORE matching: shell globbing and unquoted
  // "$var/$file" produce "///tmp/x" when a variable is empty, and "///tmp/x" does
  // not startsWith("/tmp/"). Observed live as 3 drift rows ("///tmp/g.html").
  const norm = path.replace(/^\/+/, "/");
  if (EPHEMERAL_PREFIXES.some((p) => norm.startsWith(p))) return true;

  if (home) {
    // Every check below uses `norm`, not `path`. Using the raw string only for
    // the absolute-prefix rule above let a normalized alias bypass the rest:
    // reproduced by adversarial review 2026-10-15 —
    // "///Users/.../heim-build-check/package/bin/heimdall.js" reported skip=false
    // while the single-slash form reported skip=true. Hint ingestion accepts
    // leading-slash paths unchanged, so the bypass is reachable, not theoretical.
    const promptsPrefix = `${home}/.heimdall/prompts/`;
    if (norm.startsWith(promptsPrefix)) return false;
    // Session logs (spec P3, 2026-09-28) are the second fact source. Same
    // reasoning as the prompt carve-out: they live in a dotdir, so the
    // dotdir rule below would skip them, but the facts they carry are the
    // point. Only .jsonl under the sessions tree, so nothing else in ~/.pi
    // (secrets, config, git mirrors) becomes an ingest target.
    const sessionsPrefix = `${home}/.pi/agent/sessions/`;
    if (norm.startsWith(sessionsPrefix) && norm.endsWith(".jsonl")) return false;
    if (HOME_SCRATCH_PREFIXES.some((p) => norm.startsWith(`${home}/${p}`))) return true;
    if (norm.startsWith(`${home}/.`)) return true;
    if (norm.startsWith(`${home}/Library/`)) return true;
  }
  return /\/(node_modules|\.git|__pycache__|\.venv|venv|dist|build|DerivedData|Pods|\.build)\//.test(norm);
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
    desired = desiredState(path, effective, { bridged: ctx.bridged, cap: ctx.cap, facts: ctx.config?.facts === true });
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
    // Hot path still re-stamps when the RECORD is stale even though the
    // CONTENT is unchanged: cap_max on a capability bounce, or mtime/size
    // after a touch (utimes). Without the stat refresh, audit's cheap screen
    // re-flags the same file every cycle — verify stays permanently red.
    // The commit is ownership-exact, so it must be handed back everything the
    // path currently owns; passing empty arrays here would wipe the file's
    // nodes while claiming present/depth.
    const statStale =
      prior.size !== desired.size || prior.mtime_ms !== desired.mtimeMs;
    if (prior.cap_max !== (ctx.cap?.max ?? null) || statStale) {
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

/**
 * Sweep already-journaled rows whose paths policy now excludes.
 *
 * `skipPath` gates admission; this repairs history. Clearing a policy bug is not
 * retroactive on its own: after the 2026-10-15 exclusion fix the journal still
 * held 134 /var/folders, ///tmp and /Applications rows in state=present, each one
 * scoring as a `missing` ERROR, so the index stayed critical while the code was
 * already correct. Returns the count actually evicted (already-absent rows are
 * not violations and are not counted), so the caller can tell "nothing to do"
 * apart from "policy is working".
 *
 * @returns {{evicted: number, paths: string[]}}
 */
export function evictExcluded(ctx, home) {
  const { journal, sink } = ctx;
  const h = home ?? ctx.home;
  const paths = [];
  for (const row of journal.allPaths()) {
    if (!skipPath(row.path, h)) continue;
    // Delete, do not mark absent: absent means "gone from disk, keep the memory",
    // and the file is very much there. An absent row whose file exists is
    // reported as `reappeared` forever — the non-converging loop this fixes.
    const owned = journal.ownedNodes(row.path);
    for (const n of owned) if (n.sink_id) sink.delete(n.sink_id);
    const removed = journal.forget(row.path);
    if (removed) paths.push(row.path);
  }
  return { evicted: paths.length, paths };
}
