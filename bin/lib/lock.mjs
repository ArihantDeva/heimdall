// lock.mjs — the single-writer guarantee.
//
// Everything that writes the journal or calls graft must hold this lock. It is
// what turns "we hope two processes don't collide" into "two writers cannot
// exist". The daemon holds it for its lifetime; one-shot `heimdall reconcile`
// acquires it too, so a manual run serializes against the daemon rather than
// fighting it.
//
// Implemented with O_EXCL create + liveness check rather than flock: Node has
// no portable flock, and an exclusive create is atomic on every filesystem we
// target. A lock whose owner PID is gone is stale and gets reclaimed.
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

export class Lock {
  constructor(file) {
    this.file = file;
    this.fd = null;
  }

  /** @returns {boolean} true if acquired */
  acquire() {
    mkdirSync(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 'wx' — fails if the file exists. Atomic, so exactly one winner.
        this.fd = openSync(this.file, "wx");
        writeSync(this.fd, String(process.pid));
        return true;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Held — but by a live process, or by a crashed one?
        let owner = 0;
        try { owner = Number.parseInt(readFileSync(this.file, "utf8").trim(), 10); } catch { /* unreadable */ }
        // A live owner holds it — including ourselves. Treating our own PID as
        // reclaimable would let one process acquire the same lock twice, which
        // is exactly the single-writer guarantee this file exists to provide.
        if (owner && alive(owner)) return false;
        // Stale: owner is dead (or the file is garbage). Reclaim and retry once.
        try { unlinkSync(this.file); } catch { /* raced with another reclaimer */ }
      }
    }
    return false;
  }

  release() {
    if (this.fd === null) return;
    try { closeSync(this.fd); } catch { /* already closed */ }
    try { unlinkSync(this.file); } catch { /* already gone */ }
    this.fd = null;
  }

  /** Run fn while holding the lock; returns null if the lock is unavailable. */
  static async withLock(file, fn) {
    const l = new Lock(file);
    if (!l.acquire()) return null;
    try {
      return await fn();
    } finally {
      l.release();
    }
  }
}
