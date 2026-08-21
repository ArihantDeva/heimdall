// hints.mjs — the one channel a non-writer may use to say "look at this path".
//
// Only the lock holder writes the journal. Everything else (harness hooks, the
// legacy shell scripts, a user's own script) appends a line here. Appends of
// less than PIPE_BUF under O_APPEND are atomic on the platforms we target, so
// concurrent hook processes cannot interleave a line — and a torn line is
// tolerated anyway, since a bad line is dropped and the audit pass would have
// caught the path regardless.
//
// A hint is never trusted as a description of WHAT changed. It is only a
// prompt to go look. That is what keeps a missed, duplicated, or wrong hint
// from being able to corrupt the graph.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Append a path hint. Safe from any process, no lock required. */
export function emitHint(file, path, reason = "hook") {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ path, reason, at: Date.now() }) + "\n");
}

/**
 * Consume every hint written so far and push them into the journal queue.
 * Called by the lock holder only.
 *
 * Rotates the file aside before reading, so hints written during ingestion land
 * in a fresh file rather than being dropped.
 *
 * @returns {number} paths enqueued
 */
export function ingestHints(file, journal, { skip = () => false } = {}) {
  if (!existsSync(file)) return 0;
  const tmp = `${file}.ingest`;
  try {
    renameSync(file, tmp);
  } catch {
    return 0; // another ingest is mid-flight, or the file vanished
  }
  let n = 0;
  const seen = new Set();
  for (const line of readFileSync(tmp, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // torn write; audit covers it
    const p = rec?.path;
    if (typeof p !== "string" || !p.startsWith("/") || seen.has(p)) continue;
    seen.add(p);
    if (skip(p)) continue;
    journal.enqueue(p, rec.reason ?? "hint");
    n++;
  }
  try { unlinkSync(tmp); } catch { /* already gone */ }
  return n;
}
