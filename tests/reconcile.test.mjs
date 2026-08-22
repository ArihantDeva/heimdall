// The invariant is the test target, not the implementation. Every test here
// asserts a property of the converged graph, not the sequence of calls that
// produced it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Journal } from "../bin/lib/journal.mjs";
import { Lock } from "../bin/lib/lock.mjs";
import { reconcilePath, drain, audit, skipPath } from "../bin/lib/reconcile.mjs";
import { MemorySink } from "../bin/lib/sink.mjs";
import { depthFor, rank, LEVELS, capability } from "../bin/lib/depth.mjs";
import { emitHint, ingestHints } from "../bin/lib/hints.mjs";
import { sha256, nodeIdFor } from "../bin/lib/extract.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CAP_L1 = { max: "file", python: null, reason: "test" };

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-test-"));
  const journal = new Journal(join(dir, "journal.db"));
  const sink = new MemorySink();
  return {
    dir, journal, sink,
    ctx: { journal, sink, config: { depth: "max" }, cap: CAP_L1 },
    file: (name, body) => {
      const p = join(dir, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
      return p;
    },
    cleanup: () => { journal.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// The graph state, minus the two fields that are bookkeeping rather than
// content: `reconciled_at` is a clock reading, and `generation` is a
// monotonic change counter whose whole job is to keep increasing.
const snapshot = (journal) => JSON.stringify({
  paths: journal.allPaths().map(({ reconciled_at, generation, ...rest }) => rest),
  nodes: journal.allPaths().flatMap((p) => journal.ownedNodes(p.path)),
  edges: journal.allPaths().flatMap((p) => journal.ownedEdges(p.path)),
});

// 1 ── N racing writers
test("N concurrent writers on one path converge to exactly one node set", async () => {
  const s = sandbox();
  try {
    const p = s.file("hot.txt", "v0");
    // 40 "agents" each rewrite the file and drop a hint, interleaved with
    // reconciles. This is the case the old per-process debounce got wrong.
    const hints = join(s.dir, "hints.jsonl");
    for (let i = 0; i < 40; i++) {
      writeFileSync(p, `v${i}`);
      emitHint(hints, p, `agent${i}`);
      if (i % 7 === 0) {
        ingestHints(hints, s.journal);
        drain(s.ctx);
      }
    }
    ingestHints(hints, s.journal);
    drain(s.ctx);

    const nodes = s.journal.ownedNodes(p);
    assert.equal(nodes.length, 1, "exactly one node for one file");
    assert.equal(s.journal.getPath(p).hash, sha256(readFileSync(p)), "journal matches disk");
    assert.equal(s.journal.queueDepth(), 0, "queue drained");
    // No orphaned projections: one live sink row, everything else deleted.
    assert.equal(s.sink.nodes.size, 1);
  } finally { s.cleanup(); }
});

// 1b ── real concurrency: separate OS processes racing the same file
test("separate processes hinting the same file cannot corrupt the queue", () => {
  const s = sandbox();
  try {
    const p = s.file("shared.txt", "start");
    const hints = join(s.dir, "hints.jsonl");
    const script = `
      import { emitHint } from ${JSON.stringify(join(REPO, "bin/lib/hints.mjs"))};
      import { writeFileSync } from "node:fs";
      for (let i = 0; i < 50; i++) {
        writeFileSync(${JSON.stringify(p)}, "proc" + process.argv[2] + ":" + i);
        emitHint(${JSON.stringify(hints)}, ${JSON.stringify(p)}, "p" + process.argv[2]);
      }
    `;
    const sp = join(s.dir, "writer.mjs");
    writeFileSync(sp, script);
    const kids = [];
    for (let k = 0; k < 6; k++) {
      kids.push(spawnSync(process.execPath, [sp, String(k)], { encoding: "utf8" }));
    }
    for (const kid of kids) assert.equal(kid.status, 0, kid.stderr);

    const n = ingestHints(hints, s.journal);
    assert.equal(n, 1, "300 hints for one path collapse to one queue row");
    drain(s.ctx);
    assert.equal(s.journal.ownedNodes(p).length, 1);
    assert.equal(s.journal.getPath(p).hash, sha256(readFileSync(p)));
  } finally { s.cleanup(); }
});

// 2 ── idempotency
test("reconciling twice is byte-identical", () => {
  const s = sandbox();
  try {
    const p = s.file("a.py", "def x():\n  return 1\n");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    const first = snapshot(s.journal);
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.equal(snapshot(s.journal), first);
  } finally { s.cleanup(); }
});

// 3 ── generation / ABA guard
test("a reconcile whose generation went stale does not commit", () => {
  const s = sandbox();
  try {
    const p = s.file("race.txt", "old");
    const startGeneration = s.journal.generation(p);
    // A newer change lands while our (imaginary) extraction was in flight.
    s.journal.enqueue(p, "newer");
    const ok = s.journal.commit({
      path: p, startGeneration,
      hash: "stalehash", size: 3, mtimeMs: 1, depth: "file", state: "present",
      nodes: [{ node_id: "n1", kind: "file" }], edges: [], pending: [],
    });
    assert.equal(ok, false, "stale commit rejected");
    assert.equal(s.journal.ownedNodes(p).length, 0, "nothing written");
    assert.notEqual(s.journal.getPath(p)?.hash, "stalehash");

    // reconcilePath reports it rather than writing old data.
    const j = s.journal;
    const orig = j.generation.bind(j);
    j.generation = (x) => orig(x) - 1; // simulate the generation moving under us
    const r = reconcilePath(s.ctx, p);
    j.generation = orig;
    assert.equal(r.action, "stale");
  } finally { s.cleanup(); }
});

// 4 ── ownership retraction
test("deleting a file retracts exactly its own nodes", () => {
  const s = sandbox();
  try {
    const a = s.file("a.txt", "aaa");
    const b = s.file("b.txt", "bbb");
    s.journal.enqueue(a, "t"); s.journal.enqueue(b, "t");
    drain(s.ctx);
    assert.equal(s.sink.nodes.size, 2);

    rmSync(a);
    s.journal.enqueue(a, "t");
    drain(s.ctx);

    assert.equal(s.journal.ownedNodes(a).length, 0, "a's nodes gone");
    assert.equal(s.journal.ownedNodes(b).length, 1, "b untouched");
    assert.equal(s.journal.getPath(a).state, "absent");
    assert.equal(s.sink.nodes.size, 1, "a's projection deleted, b's kept");
  } finally { s.cleanup(); }
});

// 5 ── order independence
test("cross-file edges converge regardless of reconcile order", () => {
  // Driven at the journal layer so the property is tested even on machines
  // without tree-sitter: A declares an edge to a symbol B has not defined yet.
  const forward = (order) => {
    const s = sandbox();
    try {
      const A = "/x/a.py", B = "/x/b.py";
      const commitA = () => s.journal.commit({
        path: A, startGeneration: s.journal.generation(A),
        hash: "ha", size: 1, mtimeMs: 1, depth: "graph", state: "present",
        nodes: [{ node_id: "a:f", kind: "symbol", symbol: "a::f" }],
        edges: [],
        pending: [{ src: "a:f", dst_symbol: "b::g", relation: "calls" }],
      }) && s.journal.resolvePending(["a::f"], A);
      const commitB = () => s.journal.commit({
        path: B, startGeneration: s.journal.generation(B),
        hash: "hb", size: 1, mtimeMs: 1, depth: "graph", state: "present",
        nodes: [{ node_id: "b:g", kind: "symbol", symbol: "b::g" }],
        edges: [], pending: [],
      }) && s.journal.resolvePending(["b::g"], B);
      if (order === "AB") { commitA(); commitB(); } else { commitB(); commitA(); }
      return JSON.stringify(s.journal.ownedEdges(A));
    } finally { s.cleanup(); }
  };
  const ab = forward("AB");
  assert.equal(ab, forward("BA"), "same edge set either way");
  assert.match(ab, /b:g/, "the cross-file edge actually resolved");
});

// 6 ── depth resolution
test("depth: max clamps to capability, per-root overrides win", () => {
  const capL1 = { max: "file" };
  const capL3 = { max: "graph" };
  assert.equal(depthFor("/x/y.py", { depth: "max" }, capL3).effective, "graph");
  const clamped = depthFor("/x/y.py", { depth: "max" }, capL1);
  assert.equal(clamped.effective, "file");
  assert.equal(clamped.clamped, false, "max resolves to the cap, it does not exceed it");

  const over = depthFor("/x/y.py", { depth: "graph" }, capL1);
  assert.equal(over.effective, "file");
  assert.equal(over.clamped, true, "an explicit L3 request on an L1 box is reported as clamped");

  const cfg = { depth: "path", roots: { "/x": "file", "/x/deep": "graph" } };
  assert.equal(depthFor("/x/shallow.py", cfg, capL3).effective, "file");
  assert.equal(depthFor("/x/deep/z.py", cfg, capL3).effective, "graph", "longest pattern wins");
  assert.equal(depthFor("/elsewhere/z.py", cfg, capL3).effective, "path", "global default");
  assert.deepEqual(LEVELS.map(rank), [0, 1, 2, 3]);
});

test("depth is recorded per path and a deeper capability shows up as drift", () => {
  const s = sandbox();
  try {
    const p = s.file("d.py", "def f(): pass\n");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.equal(s.journal.getPath(p).depth, "file");
    // Same file, machine now capable of L3: audit must notice the upgrade.
    const richer = { ...s.ctx, cap: { max: "graph" } };
    const drift = audit(richer, { enqueue: false });
    assert.ok(drift.some((d) => d.path === p && d.why.startsWith("depth")));
  } finally { s.cleanup(); }
});

// 6b ── the depth ladder end to end. Skipped, loudly, where tree-sitter is
// absent: the claim is "L3 by default where possible", and a silent pass on a
// box that cannot do L3 would be the claim testing nothing.
const CAP_REAL = capability();
test("L3: symbol nodes carry file:line and edges link them", { skip: CAP_REAL.max !== "graph" && `no tree-sitter: ${CAP_REAL.reason}` }, () => {
  const s = sandbox();
  s.ctx.cap = CAP_REAL;
  try {
    const p = s.file("mod.py", [
      "def alpha(x):",
      "    return beta(x) + 1",
      "",
      "def beta(y):",
      "    return y * 2",
      "",
      "class Gamma:",
      "    def method(self):",
      "        return alpha(3)",
      "",
    ].join("\n"));
    s.journal.enqueue(p, "t");
    drain(s.ctx);

    assert.equal(s.journal.getPath(p).depth, "graph");
    const nodes = s.journal.ownedNodes(p);
    const byLabel = new Map(nodes.map((n) => [n.label, n]));
    assert.ok(byLabel.has("alpha()"), `expected an alpha() node, got ${[...byLabel.keys()]}`);
    assert.equal(byLabel.get("alpha()").line, 1, "knows WHERE the function is");
    assert.equal(byLabel.get("beta()").line, 4);
    assert.equal(byLabel.get("Gamma").line, 7);
    assert.equal(nodes.filter((n) => n.kind === "file").length, 1, "exactly one file node");

    const edges = s.journal.ownedEdges(p);
    const ids = new Set(nodes.map((n) => n.node_id));
    for (const e of edges) {
      assert.ok(ids.has(e.src), `edge src ${e.src} must be a node we own`);
      assert.ok(ids.has(e.dst), `edge dst ${e.dst} must be a node we own`);
    }
    assert.ok(edges.length > 0, "L3 produced edges");

    // Deleting the file must take every symbol with it.
    rmSync(p);
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.equal(s.journal.ownedNodes(p).length, 0);
    assert.equal(s.journal.ownedEdges(p).length, 0);
  } finally { s.cleanup(); }
});

test("a file that fails to parse degrades to L1 instead of vanishing", { skip: CAP_REAL.max !== "graph" && "no tree-sitter" }, () => {
  const s = sandbox();
  s.ctx.cap = CAP_REAL;
  try {
    const p = s.file("notes.md", "# just prose\n"); // no extractor for .md
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    const row = s.journal.getPath(p);
    assert.equal(row.state, "present", "still indexed");
    assert.equal(row.depth, "file", "degraded, not dropped");
    assert.equal(s.journal.ownedNodes(p).length, 1);
  } finally { s.cleanup(); }
});

// 7 ── drift detection and repair
test("verify detects a behind-our-back edit and reconcile repairs it", () => {
  const s = sandbox();
  try {
    const p = s.file("drift.txt", "original");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.deepEqual(audit(s.ctx, { enqueue: false }), []);

    writeFileSync(p, "changed behind the daemon's back");
    const drift = audit(s.ctx, { enqueue: false });
    assert.equal(drift.length, 1);
    assert.equal(drift[0].path, p);

    audit(s.ctx); // enqueue the repair
    drain(s.ctx);
    assert.deepEqual(audit(s.ctx, { enqueue: false }), [], "converged");
    assert.equal(s.journal.getPath(p).hash, sha256(readFileSync(p)));
  } finally { s.cleanup(); }
});

test("deep audit catches a rewrite that preserved size and mtime", () => {
  const s = sandbox();
  try {
    const p = s.file("sneaky.txt", "aaaa");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    const before = s.journal.getPath(p);
    writeFileSync(p, "bbbb"); // same length
    // Make the cheap stat screen agree with the journal, the way a same-second
    // in-place rewrite would. Only content hashing can catch this.
    s.journal.db.prepare(`UPDATE paths SET mtime_ms = ?, size = ? WHERE path = ?`)
      .run(Math.floor(statSync(p).mtimeMs), before.size, p);

    assert.deepEqual(audit(s.ctx, { enqueue: false }), [], "shallow audit is fooled");
    const deep = audit(s.ctx, { deep: true, enqueue: false });
    assert.equal(deep.length, 1);
    assert.equal(deep[0].why, "hash");
  } finally { s.cleanup(); }
});

// 8 ── blind-spot regression
test("a git checkout is picked up (the old command-regex path could not see it)", () => {
  const s = sandbox();
  try {
    const repo = join(s.dir, "repo");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    const f = join(repo, "src.txt");
    writeFileSync(f, "on main\n");
    git("add", "."); git("commit", "-qm", "one");
    git("checkout", "-qb", "other");
    writeFileSync(f, "on other\n");
    git("commit", "-qam", "two");

    s.journal.enqueue(f, "t");
    drain(s.ctx);
    assert.equal(s.journal.getPath(f).hash, sha256(readFileSync(f)));

    // The branch switch rewrites the file with no tool call and no bash path
    // token the old classifier would have understood.
    git("checkout", "-q", "main");
    const drift = audit(s.ctx, { enqueue: false });
    assert.equal(drift.length, 1, "audit sees it regardless of how it changed");
    audit(s.ctx);
    drain(s.ctx);
    assert.equal(s.journal.getPath(f).hash, sha256(readFileSync(f)));
    assert.deepEqual(audit(s.ctx, { enqueue: false }), []);
  } finally { s.cleanup(); }
});

// 7b ── drift-loop regression. A file that cannot reach L3 — no tree-sitter
// extractor for its language (.md) or a parse error in one that has one —
// settles below cap.max forever. Audit demanding L3 of it made `heimdall
// verify` permanently red on README.md/package.json: drift that
// `reconcile --all` could never clear.
test("audit does not demand a depth the file can never reach", { skip: CAP_REAL.max !== "graph" && `no tree-sitter: ${CAP_REAL.reason}` }, () => {
  const s = sandbox();
  s.ctx.cap = CAP_REAL;
  try {
    // Unsupported language: the bridge has no extractor for .md at all.
    const md = s.file("README.md", "# hello\n");
    // Supported language, garbage content: tree-sitter is error-tolerant, but
    // a binary file can still produce an unusable result — exercise the same
    // degrade path via an extension the DISPATCH map lacks.
    const bad = s.file("data.yaml", "key: [unclosed\n");
    s.journal.enqueue(md, "t");
    s.journal.enqueue(bad, "t");
    drain(s.ctx);
    assert.equal(s.journal.getPath(md).depth, "file", "no markdown extractor: stays at L1");
    assert.equal(s.journal.getPath(bad).depth, "file", "no yaml extractor: degrades to L1");
    assert.deepEqual(audit(s.ctx, { enqueue: false }), [], "below-cap rows on an L3 box are not drift");
    audit(s.ctx); // enqueue whatever audit claims is drifted
    drain(s.ctx);
    assert.deepEqual(audit(s.ctx, { enqueue: false }), [], "converged for good — no loop");
    // A genuinely new capability is still drift for a code file.
    const py = s.file("good.py", "def f(): pass\n");
    s.journal.enqueue(py, "t");
    drain(s.ctx);
    const capped = { ...s.ctx, cap: { max: "file", python: null, reason: "downgraded" } };
    assert.deepEqual(audit(capped, { enqueue: false }), [], "cap downgrade is not drift either");
    const richer = { ...s.ctx, cap: CAP_REAL };
    assert.deepEqual(audit(richer, { enqueue: false }), []);
    writeFileSync(py, "def f(): return 1\n");
    assert.ok(audit(richer, { enqueue: false }).some((d) => d.path === py), "content change still detected");
  } finally { s.cleanup(); }
});

test("legacy rows without cap_max are flagged once, stamped by reconcile, then converge", { skip: CAP_REAL.max !== "graph" && `no tree-sitter: ${CAP_REAL.reason}` }, () => {
  const s = sandbox();
  s.ctx.cap = CAP_REAL;
  try {
    const p = s.file("README.md", "# hello\n");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    const nodesBefore = s.journal.ownedNodes(p).length;
    assert.ok(nodesBefore > 0, "file node exists before re-stamp");
    // Simulate a pre-migration row: cap_max never recorded.
    s.journal.db.prepare(`UPDATE paths SET cap_max = NULL WHERE path = ?`).run(p);
    const first = audit(s.ctx, { enqueue: false });
    assert.equal(first.length, 1, "legacy row flagged exactly once");
    audit(s.ctx); // enqueue the stamping repair
    drain(s.ctx);
    assert.equal(s.journal.getPath(p).cap_max, "graph", "stamped by reconcile");
    assert.equal(s.journal.ownedNodes(p).length, nodesBefore, "re-stamp must NOT wipe owned nodes");
    assert.deepEqual(audit(s.ctx, { enqueue: false }), [], "converged after one cycle");
  } finally { s.cleanup(); }
});

test("absent rows record the capability that retracted them", () => {
  const s = sandbox();
  try {
    const p = s.file("gone.txt", "x");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    rmSync(p);
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.equal(s.journal.getPath(p).state, "absent");
    assert.equal(s.journal.getPath(p).cap_max, s.ctx.cap?.max ?? null, "cap stamped on retraction");
  } finally { s.cleanup(); }
});

// ── supporting guarantees ─────────────────────────────────────────────────

test("the lock admits exactly one writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-lock-"));
  try {
    const f = join(dir, "l.lock");
    const a = new Lock(f);
    const b = new Lock(f);
    assert.equal(a.acquire(), true);
    assert.equal(b.acquire(), false, "second writer refused");
    a.release();
    assert.equal(b.acquire(), true, "released lock is reusable");
    b.release();
    assert.equal(existsSync(f), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a lock held by a dead process is reclaimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-lock2-"));
  try {
    const f = join(dir, "l.lock");
    // A PID that cannot be running: spawn and reap a trivial child.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeFileSync(f, String(dead.pid));
    const l = new Lock(f);
    assert.equal(l.acquire(), true, "stale lock reclaimed");
    l.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("node ids are namespaced by path, so same-named files cannot collide", () => {
  // graphify derives ids from the file STEM; without namespacing every
  // index.ts in a monorepo would share a node.
  assert.notEqual(nodeIdFor("/a/index.ts", "index::f"), nodeIdFor("/b/index.ts", "index::f"));
  assert.equal(nodeIdFor("/a/index.ts", "index::f"), nodeIdFor("/a/index.ts", "index::f"));
});

test("hints are advisory: garbage lines are dropped, never trusted", () => {
  const s = sandbox();
  try {
    const hints = join(s.dir, "h.jsonl");
    const real = s.file("real.txt", "x");
    writeFileSync(hints, [
      "{not json",
      JSON.stringify({ path: "relative/path" }),
      JSON.stringify({ path: real }),
      JSON.stringify({ path: real }), // duplicate
      "",
    ].join("\n"));
    assert.equal(ingestHints(hints, s.journal), 1);
    assert.equal(existsSync(hints), false, "consumed");
    drain(s.ctx);
    assert.equal(s.journal.ownedNodes(real).length, 1);
  } finally { s.cleanup(); }
});

test("skipPath excludes the directories the graph must never index", () => {
  const home = "/Users/x";
  assert.equal(skipPath("/Users/x/proj/a.ts", home), false);
  assert.equal(skipPath("relative.ts", home), true);
  assert.equal(skipPath("/tmp/a.ts", home), true);
  assert.equal(skipPath("/Users/x/.heimdall/journal.db", home), true);
  assert.equal(skipPath("/Users/x/proj/node_modules/p/i.js", home), true);
  assert.equal(skipPath("/Users/x/proj/.git/HEAD", home), true);
});

// F1 (audit): an unreadable file made reconcilePath return {action:"error"}
// without dequeuing, so the CLI/daemon drain loop re-drained it forever.
test("a permanently-erroring path is dequeued, not re-drained forever", () => {
  const s = sandbox();
  try {
    const p = join(s.dir, "noperm", "secret.py");
    mkdirSync(dirname(p));
    writeFileSync(p, "def g(): pass\n");
    chmodSync(p, 0o000);
    s.journal.enqueue(p, "t");
    // The CLI runs `for (;;) { if (!drain(ctx).processed) break; }` — this must
    // terminate even though every round errors.
    let rounds = 0;
    for (;;) {
      const { processed } = drain({ ...s.ctx, cap: capability() });
      if (!processed) break;
      if (++rounds > 5) assert.fail(`drain loop did not terminate (round ${rounds}) — error rows stay queued`);
    }
    assert.ok(rounds >= 1, "path was attempted at least once");
    assert.equal(s.journal.queueDepth(), 0, "error row must not poison the queue");
  } finally { chmodSync(join(s.dir, "noperm", "secret.py"), 0o644); s.cleanup(); }
});

// R1 review: same hang class via a failing SINK — deferred rows also stayed
// queued and the drain loop spun forever.
test("a failing sink defers once, dequeues, does not spin", () => {
  const s = sandbox();
  try {
    const p = s.file("ok.py", "def f(): pass\n");
    s.journal.enqueue(p, "t");
    const boomSink = { available: true, delete() {}, insert() { throw new Error("sink down"); } };
    let rounds = 0;
    for (;;) {
      const { processed } = drain({ ...s.ctx, sink: boomSink });
      if (!processed) break;
      if (++rounds > 5) assert.fail(`drain loop spun on deferred row (round ${rounds})`);
    }
    assert.equal(s.journal.queueDepth(), 0, "deferred row must not poison the queue");
  } finally { s.cleanup(); }
});
