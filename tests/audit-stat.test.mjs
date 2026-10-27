import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "../bin/lib/reconcile.mjs";
import { sha256 } from "../bin/lib/extract.mjs";

const CAP = { max: "file", python: null, reason: "test" };
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "heimdall-audit-stat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function row(path, state = "present") {
  let st;
  try { st = fs.statSync(path); } catch { /* absent fixture */ }
  return { path, state, depth: "file", cap_max: "file",
    size: st?.size ?? null, mtime_ms: st ? Math.floor(st.mtimeMs) : null };
}
function context(rows) {
  const enqueued = [];
  return { cap: CAP, config: { depth: "file" }, enqueued,
    journal: { allPaths: () => rows, enqueue: (...args) => enqueued.push(args) } };
}
function patchStat(t, fn) {
  t.mock.method(fs, "statSync", fn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("shallow audit observes each path once without losing any drift classification", (t) => {
  const dir = fixture(t);
  const present = join(dir, "present");
  const changed = join(dir, "changed");
  const reappeared = join(dir, "reappeared");
  const missing = join(dir, "missing");
  const absent = join(dir, "absent");
  const directory = join(dir, "directory");
  for (const p of [present, changed, reappeared]) fs.writeFileSync(p, "v1");
  fs.mkdirSync(directory);
  const rows = [row(present), row(changed), row(reappeared, "absent"),
    row(missing), row(absent, "absent"), row(directory)];
  fs.writeFileSync(changed, "longer v2");
  const counts = new Map();
  const stat = fs.statSync;
  patchStat(t, (p, ...args) => {
    counts.set(p, (counts.get(p) ?? 0) + 1);
    return stat(p, ...args);
  });
  const ctx = context(rows);
  const drift = audit(ctx);
  assert.deepEqual(drift, [
    { path: changed, why: "mtime/size" },
    { path: reappeared, why: "reappeared" },
    { path: missing, why: "missing" },
    { path: directory, why: "missing" },
  ]);
  for (const { path } of rows) assert.equal(counts.get(path), 1, path);
  assert.deepEqual(ctx.enqueued, drift.map(({ path, why }) => [path, `audit:${why}`]));
});

test("a path vanishing after the metadata observation cannot crash the audit", (t) => {
  const dir = fixture(t);
  const path = join(dir, "vanishing");
  fs.writeFileSync(path, "content");
  const ctx = context([row(path)]);
  const stat = fs.statSync;
  patchStat(t, (p, ...args) => {
    const st = stat(p, ...args);
    if (p === path) fs.unlinkSync(path);
    return st;
  });
  // This pass describes the observation it made; the next pass sees deletion.
  assert.deepEqual(audit(ctx, { enqueue: false }), []);
  assert.deepEqual(audit(ctx, { enqueue: false }), [{ path, why: "missing" }]);
  assert.deepEqual(ctx.enqueued, [], "read-only verification stays read-only");
});

test("deep audit still hashes a same-size, same-mtime rewrite", (t) => {
  const dir = fixture(t);
  const path = join(dir, "same-stats");
  fs.writeFileSync(path, "before");
  fs.utimesSync(path, 1_700_000_000, 1_700_000_000);
  const prior = { ...row(path), hash: sha256("before") };
  fs.writeFileSync(path, "after!");
  fs.utimesSync(path, 1_700_000_000, 1_700_000_000);
  const ctx = context([prior]);
  assert.deepEqual(audit(ctx, { enqueue: false }), []);
  assert.deepEqual(audit(ctx, { deep: true, enqueue: false }), [{ path, why: "hash" }]);
  assert.deepEqual(ctx.enqueued, []);
});
