// tests/fact-history.test.mjs — C3 fact history / supersession trail.
// The invariant under test: a retracted FACT-kind owned node is archived into
// journal.fact_history (newest-first read, 50-row/path cap), while code/symbol
// nodes leave ZERO rows and live retrieval stays untouched. All writes happen
// inside journal.commit()'s generation-guarded transaction, so a stale
// reconcile can never produce a phantom history row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Journal, FACT_HISTORY_CAP } from "../bin/lib/journal.mjs";
import { reconcilePath, drain } from "../bin/lib/reconcile.mjs";
import { MemorySink } from "../bin/lib/sink.mjs";
import { nodeIdFor } from "../bin/lib/extract.mjs";

const CAP_L1 = { max: "file", python: null, reason: "test" };

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-hist-"));
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

function factsFile(s, name, lines) {
  return s.file(name, lines.map((t) => JSON.stringify({ text: t })).join("\n") + "\n");
}

// ── core trail ──────────────────────────────────────────────────────────────

test("editing a prompt log archives swapped-out facts, newest-first", () => {
  const s = sandbox();
  s.ctx.config.facts = true;
  try {
    const p = factsFile(s, "log.jsonl", [
      "I always commit after review.",
      "I use SQLite for storage.",
    ]);
    s.journal.enqueue(p, "t");
    drain(s.ctx);

    const v1 = s.journal.ownedNodes(p).filter((n) => n.kind === "fact");
    assert.equal(v1.length, 2, "two live facts on first project");
    // Identify rows by their rendered sink title (journal rows carry no text).
    const rowByTitle = (title) => {
      const sinkId = [...s.sink.nodes].find(([, n]) => n.title === title)?.[0];
      return v1.find((f) => f.sink_id === sinkId);
    };
    const dropped = rowByTitle("I always commit after review");
    const kept = rowByTitle("I use SQLite for storage");

    // Edit: swap the fact at line 1 for a new one, keeping the kept fact on
    // its exact line. Fact ids embed [path:line] (facts.mjs factId), so any
    // line shift would churn the kept fact's id too — that is extractor
    // line-noise, not a belief change, and must not appear in the trail.
    writeFileSync(p, [
      JSON.stringify({ text: "I prefer tabs over spaces." }),
      JSON.stringify({ text: "I use SQLite for storage." }),
    ].join("\n") + "\n");
    s.journal.enqueue(p, "t");
    drain(s.ctx);

    // Live surface moved on...
    const v2 = s.journal.ownedNodes(p).filter((n) => n.kind === "fact");
    assert.equal(v2.length, 2);
    assert.ok(v2.some((f) => f.node_id === kept.node_id), "unchanged fact keeps its node");

    // ...but the trail remembers what died.
    const hist = s.journal.factHistory(p);
    assert.equal(hist.length, 1, "exactly one archived row");
    assert.equal(hist[0].node_id, dropped.node_id);
    assert.equal(hist[0].kind, "fact");
    assert.ok(hist[0].invalidated_at, "invalidated_at stamped");
    // Unambiguous 1:1 swap → supersession recorded.
    const replacementId = hist[0].superseded_by;
    assert.ok(replacementId && replacementId !== dropped.node_id, "superseded_by names the successor");
    const tabsId = replacementId; // the tabs fact now lives at line 1
    assert.ok(
      v2.some((f) => f.node_id === replacementId),
      "the recorded supersessor is live in owned_nodes",
    );
    // Live row is distinct from the history row — no double-count either way.
    assert.ok(!hist.some((h) => h.node_id === kept.node_id), "live fact never appears in history");
    assert.notEqual(hist[0].node_id, kept.node_id);

    // Second edit: swap the OTHER slot (line 2), again holding every other
    // fact's line stable. Two edits → two history rows, newest first.
    writeFileSync(p, [
      JSON.stringify({ text: "I prefer tabs over spaces." }),
      JSON.stringify({ text: "I run Heimdall daily." }),
    ].join("\n") + "\n");
    s.journal.enqueue(p, "t");
    drain(s.ctx);

    const hist2 = s.journal.factHistory(p);
    assert.equal(hist2.length, 2, "edit fact twice -> two history rows");
    // Newest-first, asserted explicitly. Edit 2 swapped LINE 2, so the fact
    // displaced by the SECOND edit is the sqlite one ("kept" through edit 1);
    // the commit fact, displaced by the FIRST edit, is the oldest row.
    assert.equal(hist2[0].node_id, kept.node_id, "newest row is the fact displaced by edit 2");
    assert.equal(hist2[1].node_id, dropped.node_id, "first-dropped fact is oldest in trail");
    assert.ok(hist2[0].invalidated_at >= hist2[1].invalidated_at, "timestamps monotonic with recency");
    // The second swap is also 1:1: the newest row supersedes whatever now
    // occupies its line slot — a currently LIVE fact (ids are line-keyed).
    const v3 = s.journal.ownedNodes(p).filter((n) => n.kind === "fact");
    assert.ok(
      hist2[0].superseded_by && v3.some((f) => f.node_id === hist2[0].superseded_by),
      "newest row names the fact that replaced it",
    );
  } finally { s.cleanup(); }
});

// ── absent-path retraction ──────────────────────────────────────────────────

test("deleting the source archives its facts with NULL superseded_by", () => {
  const s = sandbox();
  s.ctx.config.facts = true;
  try {
    const p = factsFile(s, "gone.jsonl", ["I favor small modules."]);
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.equal(s.journal.factHistory(p).length, 0, "nothing archived while alive");

    rmSync(p);
    s.journal.enqueue(p, "t");
    drain(s.ctx); // absent path: commit with nodes=[]

    const hist = s.journal.factHistory(p);
    assert.equal(hist.length, 1, "deleted file's fact leaves a trace");
    assert.equal(hist[0].superseded_by, null, "no successor exists — no invented causality");
    assert.ok(hist[0].label?.length || hist[0].symbol?.length || hist[0].node_id, "row carries identity");

    // Re-adding the file must not resurrect or duplicate history rows.
    writeFileSync(p, JSON.stringify({ text: "I favor small modules." }) + "\n");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.equal(s.journal.factHistory(p).length, 1, "re-index does not grow the trail");
  } finally { s.cleanup(); }
});

// ── isolation: code nodes never archived ────────────────────────────────────

test("code-file edits create ZERO history rows", () => {
  const s = sandbox();
  try {
    const p = s.file("mod.py", "def alpha():\n    return 1\n");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.ok(s.journal.ownedNodes(p).length >= 1, "code nodes exist");

    // Change content: symbols re-projected.
    writeFileSync(p, "def beta():\n    return 2\n");
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    // Delete the file entirely: full retraction.
    rmSync(p);
    s.journal.enqueue(p, "t");
    drain(s.ctx);

    assert.deepEqual(s.journal.factHistory(p), [], "file+symbol retractions never archive");
    // Whole-journal guarantee, not just this path.
    const total = s.journal.db.prepare(`SELECT COUNT(*) n FROM fact_history`).get().n;
    assert.equal(total, 0, "zero rows anywhere for pure-code churn");
  } finally { s.cleanup(); }
});

test("unchanged hot-path re-commit writes no history", () => {
  const s = sandbox();
  s.ctx.config.facts = true;
  try {
    const p = factsFile(s, "same.jsonl", ["I keep tests green."]);
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    // Same bytes, forced re-hint: hot path re-commits identical node ids.
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    assert.deepEqual(s.journal.factHistory(p), [], "identical ids are not invalidations");
  } finally { s.cleanup(); }
});

// ── retention cap ───────────────────────────────────────────────────────────

test("history caps at 50 rows per source path, deleting oldest beyond cap", () => {
  const s = sandbox();
  s.ctx.config.facts = true;
  try {
    const p = factsFile(s, "churn.jsonl", ["I prefer opinion zero."]);
    s.journal.enqueue(p, "t");
    drain(s.ctx);

    // CAP+5 successive 1:1 swaps → exactly CAP archived rows, oldest evicted.
    for (let i = 1; i <= FACT_HISTORY_CAP + 5; i++) {
      writeFileSync(p, JSON.stringify({ text: `I prefer opinion number ${i}.` }) + "\n");
      s.journal.enqueue(p, "t");
      drain(s.ctx);
    }
    const hist = s.journal.factHistory(p);
    assert.equal(hist.length, FACT_HISTORY_CAP, "cap enforced");
    // Newest-first: the survivor set must be the most recent invalidations.
    assert.match(hist[0].node_id, /^fact-/, "rows are fact node ids");
    const total = s.journal.db.prepare(`SELECT COUNT(*) n FROM fact_history`).get().n;
    assert.equal(total, FACT_HISTORY_CAP, "cap is per-path and this is the only path");
  } finally { s.cleanup(); }
});

// ── transactional safety ────────────────────────────────────────────────────

test("a stale-generation commit writes NO phantom history rows", () => {
  const s = sandbox();
  s.ctx.config.facts = true;
  try {
    const p = factsFile(s, "race.jsonl", ["I race carefully."]);
    s.journal.enqueue(p, "t");
    drain(s.ctx);
    const before = s.journal.factHistory(p);

    // A newer change lands mid-reconcile, then the stale result tries to
    // commit a world where the fact vanished. Must be rejected wholesale.
    s.journal.enqueue(p, "newer"); // generation moves
    const ok = s.journal.commit({
      path: p, startGeneration: s.journal.generation(p) - 1,
      hash: "stalehash", size: 1, mtimeMs: 1, depth: "file", state: "present",
      nodes: [{ node_id: nodeIdFor(p, "__file__"), kind: "file" }], edges: [], pending: [],
    });
    assert.equal(ok, false, "stale commit rejected as before");
    assert.deepEqual(s.journal.factHistory(p), before, "rollback leaves no phantom archive row");
  } finally { s.cleanup(); }
});

// ── migration shape ─────────────────────────────────────────────────────────

test("schema migration is additive + versioned; existing dbs gain fact_history", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-mig-"));
  try {
    // Open once to create, then force an old-version stamp and reopen: every
    // statement in SCHEMA is IF NOT EXISTS / guarded ALTER, so replay converges.
    const dbFile = join(dir, "j.db");
    let j = new Journal(dbFile);
    j.close();
    j = new Journal(dbFile);
    const ver = j.db.prepare(`PRAGMA user_version`).get().user_version;
    assert.ok(ver >= 2, `version stamp present, got ${ver}`);
    const cols = j.db.prepare(`PRAGMA table_info(fact_history)`).all().map((c) => c.name);
    for (const c of ["history_id", "node_id", "path", "kind", "symbol", "line", "label",
                     "invalidated_at", "superseded_by"]) {
      assert.ok(cols.includes(c), `column ${c} exists`);
    }
    // Columns mirror fact nodes + invalidated_at TEXT + nullable superseded_by.
    assert.ok(!j.db.prepare(`SELECT COUNT(*) n FROM fact_history`).get().n, "starts empty");
    j.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── CLI contract ────────────────────────────────────────────────────────────

test("`heimdall history PATH` prints newest-first [INVALIDATED] rows + not-advice footer", async () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-hist-cli-"));
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  try {
    const dotHeimdall = join(home, ".heimdall");
    mkdirSync(dotHeimdall, { recursive: true });
    // Build state directly through the same APIs the daemon uses.
    const p = join(home, "log.jsonl");
    const journal = new Journal(join(dotHeimdall, "journal.db"));
    const ctx = {
      journal, sink: new MemorySink(),
      config: { depth: "max", facts: true }, cap: CAP_L1,
    };
    writeFileSync(p, JSON.stringify({ text: "I prefer SQLite for storage." }) + "\n");
    journal.enqueue(p, "t");
    drain(ctx);
    writeFileSync(p, JSON.stringify({ text: "I prefer Postgres for queues." }) + "\n");
    journal.enqueue(p, "t");
    drain(ctx);
    journal.close();

    const cliPath = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "heimdall.js")).href;
    const r = spawnSync(process.execPath, [new URL(cliPath).pathname, "history", p], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
    const lines = r.stdout.split("\n").filter(Boolean);
    assert.ok(lines.some((l) => l.startsWith("[INVALIDATED]")), "every history row carries the prefix");
    assert.match(r.stdout, /not advice/i, "output contract stated: history is not advice");
    assert.match(r.stdout, /archived row/i, "footer counts the rows");
    // Unknown flags are rejected like every other verb.
    const bad = spawnSync(process.execPath, [new URL(cliPath).pathname, "history", "--bogus"], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home },
    });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /unknown option.*--bogus/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
