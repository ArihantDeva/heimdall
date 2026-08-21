#!/usr/bin/env node
// heimdall-reconciler — the single writer.
//
// Holds the lock for its lifetime, so while it runs there is exactly one
// process mutating the journal and the graph. Its inputs are only ever HINTS:
// filesystem watch events, hook-emitted paths, and a periodic audit. It reads
// the actual file to decide what the graph should contain, so a wrong hint, a
// missed hint, or ten thousand duplicate hints all converge to the same graph.
import { watch } from "node:fs";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Journal } from "./lib/journal.mjs";
import { Lock } from "./lib/lock.mjs";
import { ingestHints } from "./lib/hints.mjs";
import { drain, audit, skipPath } from "./lib/reconcile.mjs";
import { GraftSink, MemorySink } from "./lib/sink.mjs";
import {
  capability, journalPath, loadConfig, lockPath, queueHintPath, watchRoots,
} from "./lib/depth.mjs";

const HOME = homedir();

/** Recursive walk that honours the same skip rules as reconcile. */
export function* walk(root, depth = 0) {
  if (depth > 24) return; // pathological symlink loops
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (skipPath(`${p}/x`, HOME)) continue;
      yield* walk(p, depth + 1);
    } else if (e.isFile() && !skipPath(p, HOME)) {
      yield p;
    }
  }
}

function parseArgs(argv) {
  const o = { interval: 2000, auditEvery: 15 * 60_000, once: false, dryRun: false, scan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") o.once = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--scan") o.scan = true;
    else if (a === "--interval") o.interval = Number(argv[++i]);
    else if (a === "--audit-every") o.auditEvery = Number(argv[++i]) * 1000;
  }
  return o;
}

export async function runDaemon(argv = [], { log = console.error } = {}) {
  const opts = parseArgs(argv);
  const cfg = loadConfig();
  const cap = capability();
  const roots = watchRoots(cfg);

  const lock = new Lock(lockPath());
  if (!lock.acquire()) {
    log("heimdall-reconciler: another writer holds the lock — exiting");
    return 0;
  }

  const journal = new Journal(journalPath());
  const sink = opts.dryRun ? new MemorySink() : new GraftSink();
  const ctx = { journal, sink, config: cfg, cap };

  if (!sink.available) {
    log("heimdall-reconciler: graft not found — journal will be maintained, projection deferred");
  }
  log(`heimdall-reconciler: depth cap ${cap.max} (${cap.reason})`);
  log(`heimdall-reconciler: watching ${roots.length} root(s): ${roots.join(", ") || "(none configured)"}`);

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const watchers = [];
  for (const root of roots) {
    if (!existsSync(root)) { log(`  skip missing root ${root}`); continue; }
    try {
      // Recursive watching is the ground truth. It sees IDE saves, git
      // checkouts, other harnesses, and `make` output — every write the old
      // command-regex approach was structurally blind to.
      watchers.push(watch(root, { recursive: true, persistent: false }, (_ev, name) => {
        if (!name) return;
        const p = join(root, name.toString());
        if (skipPath(p, HOME)) return;
        journal.enqueue(p, "watch");
      }));
    } catch (err) {
      log(`  watch failed for ${root}: ${err.message} — audit sweeps will cover it`);
    }
  }

  // Bootstrap: a first run (or --scan) enqueues everything under the roots so
  // the journal starts complete rather than only learning about files that
  // happen to change.
  if (opts.scan || journal.stats().paths === 0) {
    let n = 0;
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const p of walk(root)) { journal.enqueue(p, "scan"); n++; }
    }
    log(`heimdall-reconciler: bootstrap scan enqueued ${n} path(s)`);
  }

  let lastAudit = Date.now();
  try {
    do {
      ingestHints(queueHintPath(), journal, { skip: (p) => skipPath(p, HOME) });
      const { processed, results } = drain(ctx);
      if (processed) {
        const tally = {};
        for (const r of results) tally[r.action] = (tally[r.action] ?? 0) + 1;
        log(`reconciled ${processed}: ${JSON.stringify(tally)}`);
        for (const r of results) {
          if (r.action === "error" || r.action === "deferred") log(`  ${r.action} ${r.path}: ${r.reason}`);
          // A stale result means a newer change landed mid-reconcile. Re-queue
          // and converge on the next pass rather than committing old data.
          if (r.action === "stale") journal.enqueue(r.path, "stale-retry");
        }
      }
      if (opts.once && journal.queueDepth() === 0) break;

      if (Date.now() - lastAudit >= opts.auditEvery) {
        const drift = audit(ctx);
        lastAudit = Date.now();
        if (drift.length) log(`audit: re-queued ${drift.length} drifted path(s)`);
      }
      if (!opts.once) await sleep(processed ? 50 : opts.interval);
    } while (!stopping);
  } finally {
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
    journal.close();
    lock.release();
  }
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (import.meta.url === `file://${process.argv[1]}`) {
  runDaemon(process.argv.slice(2)).then((c) => process.exit(c));
}
