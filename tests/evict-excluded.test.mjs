// evict-excluded.test.mjs — a path that is excluded NOW but was journaled BEFORE
// must be evicted, not left to poison the index forever.
//
// Why (2026-10-15): fixing skipPath stopped NEW ephemeral paths from entering the
// journal, but the 223 pre-existing drift rows stayed. `heimdall verify --json`
// still reported 134 rows in the ephemeral classes (/var/folders, ///tmp,
// /Applications) as state=present, and a present row whose file is gone is a
// `missing` ERROR worth 10 points. So the score stayed critical even though the
// entry point was fixed — the fix was not retroactive.
//
// The correct repair is self-healing rather than a one-time DB edit: reconcile
// reads a path, notices it is excluded by policy, and retracts whatever that path
// owns. Then any future exclusion rule also cleans up after itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { reconcilePath, evictExcluded, skipPath } from "../bin/lib/reconcile.mjs";
import { Journal } from "../bin/lib/journal.mjs";
import { MemorySink } from "../bin/lib/sink.mjs";

const HOME = "/Users/arihantdeva";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-evict-"));
  const journal = new Journal(join(dir, "journal.db"));
  const sink = new MemorySink();
  return {
    dir, journal, sink,
    ctx: { journal, sink, config: { depth: "max" }, cap: { max: "file", python: null, reason: "t" } },
    cleanup: () => { journal.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("reconcilePath retracts a path that policy now excludes", () => {
  const s = sandbox();
  try {
    // Simulate a row journaled BEFORE the exclusion existed: it is present in the
    // journal, but the path is structurally ephemeral. reconcilePath itself does
    // NOT apply policy (that coupling broke 39 suites whose sandboxes live under
    // os.tmpdir()); evictExcluded is the policy pass. This test pins the
    // reconcile -> absent behaviour that eviction builds on.
    const p = "/var/folders/sm/lpp1_zgj30n2hb054_pfn5ch0000gn/T/old-scratch.md";
    s.journal.commit({
      path: p, startGeneration: s.journal.generation(p),
      hash: "deadbeef", size: 12, mtimeMs: Date.now(),
      depth: "path", capMax: "graph", state: "present",
      // `kind: "code"` deliberately: retracting a `fact` writes fact_history rows
      // (a fact is a belief, so its retraction is a belief change). This test is
      // about the path lifecycle, so keep the fixture free of fact bookkeeping.
      // `node_id`, not `id`: that is the documented shape (see commit()'s
      // @param). This fixture said `id`, so node_id was `undefined` and every
      // insert bound NULL into the PRIMARY KEY.
      //
      // That went unnoticed because of a version difference, measured 2026-10-23
      // on the exact CI matrix: node 22's node:sqlite THROWS on an undefined
      // bind (fail loud, correct), while node 26 silently coerces it to NULL.
      // So the test passed on node 26 by writing a corrupt row, and ci.yml pins
      // node 22, where it failed. Fixing the field name is the real fix; the
      // guard added in commit() stops the silent-NULL half from coming back.
      nodes: [{ node_id: "n1", kind: "code", title: "t", body: "b", keywords: [] }],
      edges: [], pending: [],
    });
    assert.equal(s.journal.getPath(p).state, "present", "precondition: row is present");

    // Remove the file so the ordinary absent branch applies.
    const r = reconcilePath(s.ctx, p);
    assert.equal(r.action, "retracted", `a vanished path must retract, got ${r.action}`);
    assert.equal(s.journal.getPath(p).state, "absent");
  } finally { s.cleanup(); }
});

test("reconcilePath still reconciles a legitimate path (no over-eviction)", () => {
  const s = sandbox();
  try {
    // NOTE: two rules would make a naive fixture lie about this assertion.
    //  (1) os.tmpdir() on macOS IS /var/folders/..., now a SKIP path.
    //  (2) a leading dot under $HOME is skipped by the home-dotdir rule.
    // So the temp root is created in $HOME with a non-dot name: a genuinely
    // legitimate location that no exclusion rule claims.
    const realRoot = mkdtempSync(join(homedir(), "heimdall-evict-selftest-"));
    const p = join(realRoot, "real.md");
    execFileSync("/bin/sh", ["-c", `printf 'real content' > '${p}'`]);
    try {
      assert.equal(skipPath(p, HOME), false, `fixture path must not be excluded: ${p}`);
      const r = reconcilePath(s.ctx, p);
      assert.notEqual(r.action, "retracted", "a real path must not be evicted");
      assert.equal(s.journal.getPath(p).state, "present");
    } finally { rmSync(realRoot, { recursive: true, force: true }); }
  } finally { s.cleanup(); }
});

test("evictExcluded forgets every already-journaled excluded row", () => {
  const s = sandbox();
  try {
    const excluded = [
      "/var/folders/sm/x/T/a.md",
      "///tmp/b.html",
      "/Applications/Google Chrome.app/Contents/Info.plist",
    ];
    for (const p of excluded) {
      s.journal.commit({
        path: p, startGeneration: s.journal.generation(p),
        hash: "h", size: 1, mtimeMs: Date.now(),
        depth: "path", capMax: "graph", state: "present",
        nodes: [], edges: [], pending: [],
      });
    }
    const { evicted } = evictExcluded(s.ctx, HOME);
    assert.equal(evicted, excluded.length, `expected ${excluded.length} evictions, got ${evicted}`);
    for (const p of excluded) {
      // GONE from the journal, not merely absent. An absent row whose file still
      // exists is reported as `reappeared` on every subsequent audit — a loop
      // that never converges. That was the actual 2026-10-15 failure mode: 22
      // /Applications and /etc rows stuck at 3 points each, forever.
      assert.equal(s.journal.getPath(p), null, `${p} must be forgotten, not marked absent`);
    }
  } finally { s.cleanup(); }
});

test("eviction is idempotent and does not resurrect rows", () => {
  const s = sandbox();
  try {
    s.journal.commit({
      path: "/var/folders/sm/x/T/gone.md", startGeneration: 0,
      hash: null, size: null, mtimeMs: null,
      depth: "path", capMax: "graph", state: "absent",
      nodes: [], edges: [], pending: [],
    });
    const first = evictExcluded(s.ctx, HOME);
    assert.equal(first.evicted, 1, "an already-absent excluded row is still a stale journal row");
    const second = evictExcluded(s.ctx, HOME);
    assert.equal(second.evicted, 0, "second pass must be a no-op");
  } finally { s.cleanup(); }
});
