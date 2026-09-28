// backfill-sessions.mjs — bounded fact backfill from pi session logs.
//
// Phase 3, spec P3. The bound is the whole design: a machine with 14,519
// session logs cannot reconcile all of them, and an unbounded run would hold
// the journal lock for hours. The cap is a hard CLI maximum, not a default
// that can be raised by accident — this command has exactly one job.
//
// Facts are extracted, deduplicated per session file (the same rule the
// reconciler applies), and written to the journal through the RECONCILER's
// own path. It never writes journal.db directly: the journal has a live
// single-writer, and the pre-existing rule in this repo is that the
// reconciler is the only writer.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractFacts } from "./facts.mjs";

// ponytail: hard ceiling. The spec authorises 200 sessions; the cap exists so
// `--limit 20000` cannot turn a bounded backfill into an hours-long lock
// hold. Raise only alongside an explicit reason.
export const MAX_BACKFILL = 200;

const DEFAULT_LIMIT = 200;

/** Every *.jsonl under the sessions tree, newest first. */
export function listSessionLogs(root = join(homedir(), ".pi", "agent", "sessions")) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        try { out.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* raced */ }
      }
    }
  };
  walk(root);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Extract facts from the N most-recent session logs. Read-only: it touches no
 * store, so the measurement can be taken before anything is written.
 */
export function measureBackfill({ limit = DEFAULT_LIMIT, root } = {}) {
  const capped = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT), MAX_BACKFILL);
  const files = listSessionLogs(root).slice(0, capped);
  const perFile = [];
  let facts = 0, secrets = 0, dupes = 0;
  for (const f of files) {
    let buf;
    try { buf = readFileSync(f.path); } catch { continue; }
    const meta = { path: f.path };
    const got = extractFacts(buf, meta);
    facts += got.length;
    secrets += meta.skippedSecrets ?? 0;
    dupes += meta.skippedDuplicates ?? 0;
    if (got.length) perFile.push({ path: f.path, facts: got.length });
  }
  return {
    limit: capped, files: files.length, filesWithFacts: perFile.length,
    facts, skippedSecrets: secrets, skippedDuplicates: dupes, perFile,
  };
}
