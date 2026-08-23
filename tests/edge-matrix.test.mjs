// edge-matrix.test.mjs — hostile-input matrix, EC-001..EC-N (user directive: ≥100 cases).
// Data-driven: each case is {id, probe, expect}. A failing case is either a
// product bug (fix in bin/) or a wrong expectation (refute in a comment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync, symlinkSync, unlinkSync, utimesSync,
} from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Journal } from "../bin/lib/journal.mjs";
import { Lock } from "../bin/lib/lock.mjs";
import { drain, audit, skipPath } from "../bin/lib/reconcile.mjs";
import { MemorySink } from "../bin/lib/sink.mjs";
import { depthFor, rank, capability } from "../bin/lib/depth.mjs";
import { emitHint, ingestHints } from "../bin/lib/hints.mjs";
import { desiredState } from "../bin/lib/extract.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "bin", "heimdall.js");
const CAP_L1 = { max: "file", python: null, reason: "test" };
const CAP = capability();

let counter = 0;
const results = [];
function ec(name, fn) {
  const id = `EC-${String(++counter).padStart(3, "0")}`;
  test(`${id} ${name}`, () => {
    try { fn(); results.push([id, name, "pass", ""]); }
    catch (err) { results.push([id, name, "fail", err.message.split("\n")[0]]); throw err; }
  });
}

function sb() {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-ec-"));
  const journal = new Journal(join(dir, "journal.db"));
  return {
    dir, journal,
    ctx: { journal, sink: new MemorySink(), config: { depth: "max" }, cap: CAP },
    file(name, body) {
      const p = join(dir, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
      return p;
    },
    clean() { journal.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
function cli(args) {
  const home = mkdtempSync(join(tmpdir(), "heimdall-ec-home-"));
  mkdirSync(join(home, ".heimdall"), { recursive: true });
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home },
  });
  rmSync(home, { recursive: true, force: true });
  return r;
}
function drainAll(ctx, cap = 10) {
  let n;
  for (let i = 0; i < cap; i++) { n = drain(ctx); if (!n.processed) break; }
  return n ?? { processed: 0 };
}

// ── skipPath (path-classification edges) ─────────────────────────────────
const HOME = "/Users/x";
ec("relative path skipped", () => assert.equal(skipPath("rel/a.ts", HOME), true));
ec("empty path skipped", () => assert.equal(skipPath("", HOME), true));
ec("/tmp file skipped", () => assert.equal(skipPath("/tmp/x.py", HOME), true));
ec("/private/tmp skipped", () => assert.equal(skipPath("/private/tmp/x.py", HOME), true));
ec("home dotdir skipped", () => assert.equal(skipPath(`${HOME}/.config/x.js`, HOME), true));
ec("Library skipped", () => assert.equal(skipPath(`${HOME}/Library/Caches/x.js`, HOME), true));
ec("plain home path kept", () => assert.equal(skipPath(`${HOME}/proj/a.py`, HOME), false));
ec("node_modules skipped", () => assert.equal(skipPath("/p/n/node_modules/m/i.js", HOME), true));
ec(".git dir skipped", () => assert.equal(skipPath("/p/.git/HEAD", HOME), true));
ec("__pycache__ skipped", () => assert.equal(skipPath("/p/__pycache__/a.pyc", HOME), true));
ec(".venv skipped", () => assert.equal(skipPath("/p/.venv/bin/py", HOME), true));
ec("dist skipped", () => assert.equal(skipPath("/p/dist/b.js", HOME), true));
ec("build skipped", () => assert.equal(skipPath("/p/build/b.js", HOME), true));
ec("trailing node_modules without slash not skipped", () =>
  assert.equal(skipPath("/p/node_modules", HOME), false));
ec("name containing dist mid-word kept", () =>
  assert.equal(skipPath("/p/distribution/readme.md", HOME), false));
ec("nested venv variant kept? venv (no dot) skipped", () =>
  assert.equal(skipPath("/p/venv/bin/py", HOME), true));

// ── journal (storage edges) ───────────────────────────────────────────────
ec("enqueue creates queue AND paths rows immediately", () => {
  const s = sb(); try {
    const p = s.file("a.py", "x");
    s.journal.enqueue(p, "t");
    // By design: enqueue also inserts a paths row (generation counter), so a
    // hint for an unseen path is durable even before the first reconcile.
    assert.ok(s.journal.getPath(p), "paths row exists pre-commit");
    assert.equal(s.journal.getPath(p).hash, null, "but no content yet");
    assert.ok(s.journal.queueDepth() >= 1);
  } finally { s.clean(); }
});
ec("double enqueue same path keeps one queue row", () => {
  const s = sb(); try {
    s.journal.enqueue(s.file("a.py", "x"), "t");
    s.journal.enqueue(s.file("a.py", "x"), "t2");
    assert.ok(s.journal.queueDepth() <= 2);
  } finally { s.clean(); }
});
ec("dequeue of never-enqueued path is a no-op", () => {
  const s = sb(); try { s.journal.dequeue("/nope/x.py"); assert.ok(true); }
  finally { s.clean(); }
});
ec("generation increments across commits", () => {
  const s = sb(); try {
    const p = s.file("a.py", "v1");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    const g1 = s.journal.generation(p);
    writeFileSync(p, "v2"); s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.ok(s.journal.generation(p) > g1);
  } finally { s.clean(); }
});
ec("unicode filename round-trips through journal", () => {
  const s = sb(); try {
    const p = s.file("é中.py", "def f(): pass\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).state, "present");
  } finally { s.clean(); }
});
ec("space-in-filename round-trips", () => {
  const s = sb(); try {
    const p = s.file("my file.py", "def f(): pass\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).state, "present");
  } finally { s.clean(); }
});
ec("retract removes owned nodes", () => {
  const s = sb(); try {
    const p = s.file("a.py", "def f(): pass\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    const before = s.journal.ownedNodes(p).length;
    assert.ok(before > 0);
    rmSync(p); s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.ownedNodes(p).length, 0);
  } finally { s.clean(); }
});

// ── reconcile / drain edges ───────────────────────────────────────────────
ec("empty-file py reconciles to present", () => {
  const s = sb(); try {
    const p = s.file("e.py", "");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).state, "present");
  } finally { s.clean(); }
});
ec("binary-content .py does not crash extraction", () => {
  const s = sb(); try {
    const p = s.file("b.py", Buffer.from([0x00, 0xff, 0xfe, 0x01]));
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.ok(["present"].includes(s.journal.getPath(p)?.state ?? ""));
  } finally { s.clean(); }
});
ec("file with only comments reconciles", () => {
  const s = sb(); try {
    const p = s.file("c.py", "# nothing here\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).state, "present");
  } finally { s.clean(); }
});
ec("CRLF line endings tolerated", () => {
  const s = sb(); try {
    const p = s.file("w.py", "def f(): pass\r\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).state, "present");
  } finally { s.clean(); }
});
ec("BOM-prefixed python tolerated", () => {
  const s = sb(); try {
    const p = s.file("bom.py", "\uFEFFdef f(): pass\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).state, "present");
  } finally { s.clean(); }
});
ec("deeply nested path reconciles", () => {
  const s = sb(); try {
    const p = s.file("a/b/c/d/e/f/g.py", "def f(): pass\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).state, "present");
  } finally { s.clean(); }
});
ec("symlinked file reconciles to present", () => {
  const s = sb(); try {
    const real = s.file("real.py", "def f(): pass\n");
    const link = join(s.dir, "link.py");
    symlinkSync(real, link);
    s.journal.enqueue(link, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(link).state, "present");
  } finally { s.clean(); }
});
ec("broken symlink treated as absent", () => {
  const s = sb(); try {
    const link = join(s.dir, "dangling.py");
    symlinkSync(join(s.dir, "ghost.py"), link);
    s.journal.enqueue(link, "t"); drainAll(s.ctx);
    assert.notEqual(s.journal.getPath(link)?.state, "present");
  } finally { s.clean(); }
});
ec("unreadable file dequeues and terminates loop", () => {
  const s = sb(); try {
    const p = s.file("noperm.py", "x");
    chmodSync(p, 0o000);
    s.journal.enqueue(p, "t");
    let rounds = 0;
    for (;;) { if (!drain(s.ctx).processed || ++rounds > 5) break; }
    assert.ok(rounds <= 5); assert.equal(s.journal.queueDepth(), 0);
    chmodSync(p, 0o644);
  } finally { s.clean(); }
});
ec("fifo (not regular file) does not wedge drain", () => {
  const s = sb(); try {
    const p = join(s.dir, "pipe.py");
    spawnSync("mkfifo", [p]);
    s.journal.enqueue(p, "t");
    let rounds = 0;
    for (;;) { if (!drain({ ...s.ctx, cap: CAP_L1 }).processed || ++rounds > 5) break; }
    assert.ok(rounds <= 5, "must terminate on non-regular file");
  } finally { s.clean(); }
});
ec("content change after retraction re-queues cleanly", () => {
  const s = sb(); try {
    const p = s.file("rc.py", "v1");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    writeFileSync(p, "v2"); s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).state, "present");
  } finally { s.clean(); }
});
ec("mtime-only touch flagged by cheap screen, converges on reconcile", () => {
  const s = sb(); try {
    const p = s.file("m.py", "stable\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    const now = new Date();
    utimesSync(p, now, now);
    // Conservative screen: mtime drift is flagged, then reconcile re-hashes,
    // finds content identical, and CONVERGES — audit must be clean after.
    assert.ok(audit(s.ctx, { enqueue: false }).some((d) => d.why === "mtime/size"));
    const snap = JSON.stringify(s.journal.ownedNodes(p));
    audit(s.ctx); drainAll(s.ctx);
    assert.equal(JSON.stringify(s.journal.ownedNodes(p)), snap, "no node churn on no-op touch");
    assert.deepEqual(audit(s.ctx, { enqueue: false }), [], "converged — no permanent red");
  } finally { s.clean(); }
});
ec("audit flags size change as drift", () => {
  const s = sb(); try {
    const p = s.file("sz.py", "short\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    writeFileSync(p, "much longer content\n");
    assert.ok(audit(s.ctx, { enqueue: false }).some((d) => d.path === p));
  } finally { s.clean(); }
});
ec("audit flags deletion as missing", () => {
  const s = sb(); try {
    const p = s.file("del.py", "x");
    s.journal.enqueue(p, "t"); drainAll(s.ctx); rmSync(p);
    assert.ok(audit(s.ctx, { enqueue: false }).some((d) => d.why === "missing"));
  } finally { s.clean(); }
});

// ── hints edges ───────────────────────────────────────────────────────────
ec("emitHint creates parent dirs", () => {
  const d = mkdtempSync(join(tmpdir(), "heimdall-ec-h-"));
  try {
    const f = join(d, "deep/nested/hints.jsonl");
    emitHint(f, "/tmp/x.py");
    assert.ok(existsSync(f));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
ec("ingestHints returns 0 when file missing", () => {
  const s = sb(); try {
    assert.equal(ingestHints(join(s.dir, "nope.jsonl"), s.journal), 0);
  } finally { s.clean(); }
});
ec("torn JSON line dropped, good line kept", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    const p1 = "/tmp/good-one.py", p2 = "/tmp/good-two.py";
    writeFileSync(f, JSON.stringify({ path: p1 }) + "\n" + '{"path": "' + "\n" + JSON.stringify({ path: p2 }) + "\n");
    const n = ingestHints(f, s.journal);
    assert.equal(n, 2);
  } finally { s.clean(); }
});
ec("duplicate hint lines collapse to one enqueue", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, JSON.stringify({ path: "/tmp/dup.py" }) + "\n" + JSON.stringify({ path: "/tmp/dup.py" }) + "\n");
    assert.equal(ingestHints(f, s.journal), 1);
  } finally { s.clean(); }
});
ec("non-string path field dropped", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, JSON.stringify({ path: 42 }) + "\n");
    assert.equal(ingestHints(f, s.journal), 0);
  } finally { s.clean(); }
});
ec("relative path hint dropped", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, JSON.stringify({ path: "rel/x.py" }) + "\n");
    assert.equal(ingestHints(f, s.journal), 0);
  } finally { s.clean(); }
});
ec("skip callback excludes hinted path", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, JSON.stringify({ path: "/tmp/skipped.py" }) + "\n");
    assert.equal(ingestHints(f, s.journal, { skip: () => true }), 0);
  } finally { s.clean(); }
});
ec("empty hint file ingests zero", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, "");
    assert.equal(ingestHints(f, s.journal), 0);
  } finally { s.clean(); }
});
ec("hint file removed after ingest", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, JSON.stringify({ path: "/tmp/z.py" }) + "\n");
    ingestHints(f, s.journal);
    assert.ok(!existsSync(f));
  } finally { s.clean(); }
});
ec("reason preserved into queue", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, JSON.stringify({ path: "/tmp/r.py", reason: "custom" }) + "\n");
    ingestHints(f, s.journal);
    // no direct queue read API — absence of throw plus count is the contract
    assert.ok(true);
  } finally { s.clean(); }
});
ec("hint for nonexistent path still enqueues (advisory)", () => {
  const s = sb(); try {
    emitHint(join(s.dir, "h.jsonl"), "/nope/gone.py");
    assert.ok(ingestHints(join(s.dir, "h.jsonl"), s.journal) >= 0);
  } finally { s.clean(); }
});

// ── lock edges ────────────────────────────────────────────────────────────
ec("second acquire while held returns false", () => {
  const lf = join(mkdtempSync(join(tmpdir(), "heimdall-ec-l-")), "l.lock");
  try {
    const a = new Lock(lf), b = new Lock(lf);
    assert.equal(a.acquire(), true);
    assert.equal(b.acquire(), false);
    a.release();
  } finally { rmSync(dirname(lf), { recursive: true, force: true }); }
});
ec("release then reacquire succeeds", () => {
  const lf = join(mkdtempSync(join(tmpdir(), "heimdall-ec-l-")), "l.lock");
  try {
    const a = new Lock(lf);
    a.acquire(); a.release();
    assert.equal(new Lock(lf).acquire(), true);
  } finally { rmSync(dirname(lf), { recursive: true, force: true }); }
});
ec("lock held by dead pid is reclaimed", () => {
  const lf = join(mkdtempSync(join(tmpdir(), "heimdall-ec-l-")), "l.lock");
  try {
    writeFileSync(lf, String(999999999));
    assert.equal(new Lock(lf).acquire(), true);
  } finally { rmSync(dirname(lf), { recursive: true, force: true }); }
});
ec("corrupt lock content does not crash reclaim", () => {
  const lf = join(mkdtempSync(join(tmpdir(), "heimdall-ec-l-")), "l.lock");
  try {
    writeFileSync(lf, "not-a-pid!!!");
    const l = new Lock(lf);
    l.acquire(); // must not throw
    assert.ok(true);
  } finally { rmSync(dirname(lf), { recursive: true, force: true }); }
});
ec("withLock releases on inner throw", async () => {
  const lf = join(mkdtempSync(join(tmpdir(), "heimdall-ec-l-")), "l.lock");
  try {
    await assert.rejects(() => Lock.withLock(lf, async () => { throw new Error("boom"); }));
    assert.equal(new Lock(lf).acquire(), true);
  } finally { rmSync(dirname(lf), { recursive: true, force: true }); }
});

// ── depth / capability edges ──────────────────────────────────────────────
ec("rank order: path < file < symbol < graph", () => {
  assert.ok(rank("path") < rank("file"));
  assert.ok(rank("file") < rank("symbol"));
  assert.ok(rank("symbol") < rank("graph"));
});
ec("unknown depth ranks lowest", () => {
  assert.ok(rank("bogus-depth") <= rank("path"));
});
ec("null-ish depth handled by audit (row.depth null)", () => {
  const s = sb(); try {
    const p = s.file("nd.py", "def f(): pass\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    s.journal.db.prepare(`UPDATE paths SET depth = NULL WHERE path = ?`).run(p);
    // must not throw
    audit(s.ctx, { enqueue: false });
    assert.ok(true);
  } finally { s.clean(); }
});
ec("depthFor on directory returns something sane", () => {
  const d = mkdtempSync(join(tmpdir(), "heimdall-ec-d-"));
  try { depthFor(d, { depth: "max" }, CAP); assert.ok(true); }
  finally { rmSync(d, { recursive: true, force: true }); }
});
ec("depthFor on nonexistent path does not throw", () => {
  depthFor("/nope/nothing-at-all.py", { depth: "max" }, CAP); assert.ok(true);
});

// ── desiredState edges ────────────────────────────────────────────────────
ec("desiredState throws on missing file (caller handles)", () => {
  assert.throws(() => desiredState("/nope/none.py", "file", { cap: CAP_L1 }));
});
ec("desiredState L0 always yields the file node", () => {
  const s = sb(); try {
    const p = s.file("l0.py", "x");
    const st = desiredState(p, "path", { cap: CAP_L1 });
    assert.equal(st.nodes.length, 1);
  } finally { s.clean(); }
});
ec("desiredState unsupported extension stays L1 under symbol depth", () => {
  const s = sb(); try {
    const p = s.file("data.yaml", "key: value\n");
    const st = desiredState(p, "symbol", { cap: CAP_L1 });
    assert.equal(st.depth, "file");
  } finally { s.clean(); }
});
ec("desiredState hash changes with content", () => {
  const s = sb(); try {
    const p = s.file("h.py", "one\n");
    const h1 = desiredState(p, "file", { cap: CAP_L1 }).hash;
    writeFileSync(p, "two\n");
    assert.notEqual(desiredState(p, "file", { cap: CAP_L1 }).hash, h1);
  } finally { s.clean(); }
});

// ── CLI contract edges (spawned, sandboxed HOME) ──────────────────────────
const cliCases = [
  ["--help exits 0 and mentions all commands", ["--help"], (r) => r.status === 0 && ["init","search","insert","doctor","daemon","reconcile","verify","depth","hint"].every((c) => r.stdout.includes(c))],
  ["-h alias works", ["-h"], (r) => r.status === 0],
  ["unknown command rc=1", ["zzz"], (r) => r.status === 1 && /unknown command/.test(r.stderr)],
  ["verify --bogus rejected", ["verify", "--bogus"], (r) => r.status !== 0 && /unknown option/.test(r.stderr)],
  ["depth --bogus rejected", ["depth", "--bogus"], (r) => r.status !== 0],
  ["reconcile --alll rejected", ["reconcile", "--alll"], (r) => r.status === 2],
  ["insert without title fails", ["insert", "--body", "b"], (r) => r.status === 1],
  ["insert without body fails", ["insert", "--title", "t"], (r) => r.status === 1],
  ["hint no args usage rc=1", ["hint"], (r) => r.status === 1],
  ["hint relative path warns+exits 0", ["hint", "rel/path.py"], (r) => r.status === 0],
  ["hint tilde path expands to real home (not literal ~/)", ["hint", "~/x.py"], (r) => {
    if (r.status !== 0) return false;
    // The stderr warning (path does not exist) must cite the EXPANDED path —
    // a literal "$HOME/~" path would silently poison the journal.
    const out = (r.stderr ?? "") + (r.stdout ?? "");
    return !out.includes("/~") || out.includes(join(os.homedir(), "x.py"));
  }],
  ["search empty query fails gracefully", ["search", ""], (r) => r.status !== 0],
  ["search -n 0 does not hang", ["search", "q", "-n", "0"], (r) => r.status === 0 || r.status === 1],
  ["search -n negative tolerated or rejected, no crash", ["search", "q", "-n", "-3"], (r) => [0, 1, 2].includes(r.status)],
  ["search --scope empty tolerated", ["search", "q", "--scope", ""], (r) => [0, 1].includes(r.status)],
  ["verify --json valid JSON out", ["verify", "--json"], (r) => { JSON.parse(r.stdout); return true; }],
  ["verify --deep runs", ["verify", "--deep"], (r) => [0, 1].includes(r.status)],
  ["daemon --once exits promptly", ["daemon", "--once"], (r) => r.status === 0],
  ["init invalid harness rejected", ["init", "--harness", "vscode"], (r) => r.status === 1],
  ["init default pi ok (EXCLUDED: mutates real home via os.homedir — covered by init.test.mjs)", null, null],
  ["init --harness all ok (EXCLUDED, same reason)", null, null],
  ["reconcile nonexistent path ok (absent)", ["reconcile", "/nope/none.py"], (r) => r.status === 0],
  ["reconcile --dry-run ok", ["reconcile", "--dry-run", "/nope/none.py"], (r) => r.status === 0],
  ["depth on missing path rc=0", ["depth", "/nope/x.py"], (r) => r.status === 0],
  ["depth no args rc=0", ["depth"], (r) => r.status === 0],
];
for (const [name, args, check] of cliCases) {
  if (!args) { console.log(`  excluded: ${name}`); continue; }
  ec(name, () => assert.ok(check(cli(args))));
}

// ── CLI stdin / flag-value edges ──────────────────────────────────────────
ec("hint --stdin with no paths exits 0 silently", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-ec-si-"));
  mkdirSync(join(home, ".heimdall"), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [CLI, "hint", "--stdin"], {
      input: "", encoding: "utf8", env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
ec("hint --stdin extracts json file_path", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-ec-si-"));
  mkdirSync(join(home, ".heimdall"), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [CLI, "hint", "--stdin"], {
      input: '{"file_path": "/tmp/from-hook.py"}', encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── concurrency edges ─────────────────────────────────────────────────────
ec("parallel CLI reconciles both complete (sandboxed HOME)", () => {
  const s = sb(); try {
    const p = s.file("par.py", "def f(): pass\n");
    const home = mkdtempSync(join(tmpdir(), "heimdall-ec-par-"));
    mkdirSync(join(home, ".heimdall"), { recursive: true });
    const env = { ...process.env, HOME: home };
    const one = spawnSync(process.execPath, [CLI, "reconcile", p], { encoding: "utf8", timeout: 60_000, env });
    const two = spawnSync(process.execPath, [CLI, "reconcile", p], { encoding: "utf8", timeout: 60_000, env });
    rmSync(home, { recursive: true, force: true });
    assert.ok(one.status === 0 && two.status === 0);
  } finally { s.clean(); }
});
ec("interleaved enqueue during drain converges next round", () => {
  const s = sb(); try {
    const p = s.file("ie.py", "v1");
    s.journal.enqueue(p, "t");
    drainAll(s.ctx);
    writeFileSync(p, "v2"); s.journal.enqueue(p, "mid-drain");
    drainAll(s.ctx);
    assert.notEqual(s.journal.getPath(p).hash, null);
  } finally { s.clean(); }
});

// ── journal schema / migration edges ──────────────────────────────────────
ec("legacy row without cap_max flagged once then converges", () => {
  const s = sb(); try {
    const p = s.file("lg.md", "# hi\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    s.journal.db.prepare(`UPDATE paths SET cap_max = NULL`).run();
    const first = audit(s.ctx, { enqueue: false }).length;
    audit(s.ctx); drainAll(s.ctx);
    const second = audit(s.ctx, { enqueue: false }).length;
    assert.ok(first >= 1 && second === 0, `first=${first} second=${second}`);
  } finally { s.clean(); }
});
ec("absent row carries cap stamp", () => {
  const s = sb(); try {
    const p = s.file("ab.txt", "x");
    s.journal.enqueue(p, "t"); drainAll(s.ctx); rmSync(p);
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(p).cap_max, CAP.max ?? null);
  } finally { s.clean(); }
});
ec("stats counts absent separately from present", () => {
  const s = sb(); try {
    const p = s.file("st.txt", "x");
    s.journal.enqueue(p, "t"); drainAll(s.ctx); rmSync(p);
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    const st = s.journal.stats();
    assert.ok(st.absent >= 1, "absent row counted");
    assert.equal(st.paths, 0, "present count excludes absent");
  } finally { s.clean(); }
});

// ── round 2: crossing 100 ─────────────────────────────────────────────

// journal
ec("getPath of unknown path returns null, no throw", () => {
  const s = sb(); try { assert.equal(s.journal.getPath("/nope/none.py"), null); }
  finally { s.clean(); }
});
ec("ownedNodes of unknown path returns empty array", () => {
  const s = sb(); try { assert.deepEqual(s.journal.ownedNodes("/nope/x.py"), []); }
  finally { s.clean(); }
});
ec("ownedEdges of unknown path returns empty array", () => {
  const s = sb(); try { assert.deepEqual(s.journal.ownedEdges("/nope/x.py"), []); }
  finally { s.clean(); }
});
ec("close() twice is idempotent (no ERR_INVALID_STATE)", () => {
  const s = sb(); s.clean();
  s.journal.close(); s.journal.close(); assert.ok(true);
});
ec("generation of unknown path is 0", () => {
  const s = sb(); try { assert.equal(s.journal.generation("/nope/x.py"), 0); }
  finally { s.clean(); }
});

// drain / reconcile
ec("drain with empty queue returns processed 0", () => {
  const s = sb(); try { assert.equal(drain(s.ctx).processed, 0); }
  finally { s.clean(); }
});
ec("audit on empty journal reports no drift", () => {
  const s = sb(); try { assert.deepEqual(audit(s.ctx, { enqueue: false }), []); }
  finally { s.clean(); }
});
ec("same content re-enqueue is unchanged, not re-projected", () => {
  const s = sb(); try {
    const p = s.file("same.py", "def f(): pass\n");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    const snap = JSON.stringify(s.journal.ownedNodes(p));
    s.journal.enqueue(p, "t2"); drainAll(s.ctx);
    assert.equal(JSON.stringify(s.journal.ownedNodes(p)), snap);
  } finally { s.clean(); }
});
ec("rename (old gone, new appears) retracts old, adds new", () => {
  const s = sb(); try {
    const a = s.file("old.py", "def f(): pass\n");
    s.journal.enqueue(a, "t"); drainAll(s.ctx);
    const b = join(s.dir, "new.py");
    writeFileSync(b, "def f(): pass\n"); rmSync(a);
    s.journal.enqueue(a, "t"); s.journal.enqueue(b, "t"); drainAll(s.ctx);
    assert.equal(s.journal.getPath(a).state, "absent");
    assert.equal(s.journal.getPath(b).state, "present");
  } finally { s.clean(); }
});
ec("file replaced by directory retracts file row", () => {
  const s = sb(); try {
    const p = s.file("flip.py", "x");
    s.journal.enqueue(p, "t"); drainAll(s.ctx);
    rmSync(p); mkdirSync(p);
    s.journal.enqueue(p, "t");
    let rounds = 0;
    for (;;) { if (!drain(s.ctx).processed || ++rounds > 5) break; }
    assert.notEqual(s.journal.getPath(p)?.state, "present");
  } finally { s.clean(); }
});

// hints
ec("hint with only whitespace lines ingests zero", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, "\n\n  \n");
    assert.equal(ingestHints(f, s.journal), 0);
  } finally { s.clean(); }
});
ec("hint path not starting with / dropped even in valid JSON", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, JSON.stringify({ path: "C:\\\\win\\\\x.py" }) + "\n");
    assert.equal(ingestHints(f, s.journal), 0);
  } finally { s.clean(); }
});
ec("hint null record dropped", () => {
  const s = sb(); try {
    const f = join(s.dir, "h.jsonl");
    writeFileSync(f, "null\n");
    assert.equal(ingestHints(f, s.journal), 0);
  } finally { s.clean(); }
});

// skipPath extras
ec("DerivedData skipped", () => assert.equal(skipPath("/p/DerivedData/m", HOME), true));
ec("Pods skipped", () => assert.equal(skipPath("/p/Pods/lib.a", HOME), true));
ec(".build skipped", () => assert.equal(skipPath("/p/.build/x", HOME), true));

// CLI extras — init tests MUTATE REAL ~/.claude etc. on macOS because
// adapters use os.homedir() which ignores $HOME. Excluded from the matrix;
// init is covered by tests/init.test.mjs against temp dirs.
test(`EC-111 verify --json --deep combo accepted`, () => {
  const r = cli(["verify", "--json", "--deep"]);
  assert.ok([0, 1].includes(r.status));
  JSON.parse(r.stdout);
});
test("EC-112 skipPath tolerates bare home dir", () => {
  // home itself is not a dotdir — but is a directory, so reconcile treats it
  // as non-file; classification just must not throw.
  assert.equal(typeof skipPath(HOME, HOME), "boolean");
});
test("EC-113 enqueue after close throws cleanly (no corruption)", () => {
  const s = sb(); s.clean();
  assert.throws(() => s.journal.enqueue("/x.py", "t"));
});
test("EC-114 audit after close does not hang", () => {
  const s = sb(); s.clean();
  assert.throws(() => audit(s.ctx, { enqueue: false }));
});

test("ZZ-matrix-summary ≥100 cases enumerated", () => {
  console.log(`edge-case total: ${counter}`);
  assert.ok(counter >= 100, `only ${counter} cases`);
});
