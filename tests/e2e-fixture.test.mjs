// e2e-fixture.test.mjs — the one end-to-end trust fixture: edit → reconcile →
// query. Proves the converged-graph claim a reviewer can reproduce: a file
// edit lands as exactly the right nodes in both journal and sink, a rename
// leaves no ghosts, a delete retracts cleanly, and the read side labels a
// live anchor STRONG only when the content corroborates it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Journal } from "../bin/lib/journal.mjs";
import { MemorySink } from "../bin/lib/sink.mjs";
import { drain } from "../bin/lib/reconcile.mjs";
import { emitHint, ingestHints } from "../bin/lib/hints.mjs";
import { sha256 } from "../bin/lib/extract.mjs";
import { capability, rank } from "../bin/lib/depth.mjs";

// Real capability probe, but the one that matters for THIS fixture: symbol
// indexing of util.py needs tree_sitter_python specifically — capability()
// only proves the core `tree_sitter` library imports (F4: a machine with the
// library but missing this grammar would false-red the SYM branch).
const CAP = capability({}, { fresh: true });
let GRAMMAR_OK = false;
try {
  await import("node:child_process").then(({ execFileSync }) => {
    execFileSync(CAP.python ?? "python3",
      ["-c", "import tree_sitter_python"], { timeout: 15_000 });
    GRAMMAR_OK = true;
  });
} catch { /* degrade branch */ }
const SYM = rank(CAP.max) >= rank("symbol") && GRAMMAR_OK;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-e2e-"));
  const journal = new Journal(join(dir, "journal.db"));
  const sink = new MemorySink();
  return {
    dir, journal, sink,
    ctx: { journal, sink, config: { depth: "max" }, cap: CAP },
    cleanup: () => { journal.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// Read-side verdict pass — APPROXIMATION of bin/kb-search.sh's contract
// (NOPATH when path gone; STRONG iff exists AND ≥half of query tokens
// corroborated by title/body; else WEAK). Deliberately simplified: no path-
// token matching, no semantic concept. Do NOT copy-paste as production code.
function verdict(hit, qTokens) {
  if (!hit.exists) return "NOPATH";
  const cov = qTokens.filter((t) =>
    hit.title.toLowerCase().includes(t) || hit.body.toLowerCase().includes(t)
  ).length / qTokens.length;
  return cov >= 0.5 ? "STRONG" : "WEAK";
}

test("end-to-end: edit → reconcile → query converges without ghosts", async () => {
  const s = sandbox();
  try {
    const srcDir = join(s.dir, "src");
    mkdirSync(srcDir, { recursive: true });
    // .py: the one grammar guaranteed in the probe venv (tree-sitter-python).
    const utilPath = join(srcDir, "util.py");

    // 1 ── first edit: create a module with one exported symbol
    writeFileSync(utilPath, "def alphaCompute():\n    return 1\n");
    const hints = join(s.dir, "hints.jsonl");
    emitHint(hints, utilPath, "agent-a");
    ingestHints(hints, s.journal);
    drain(s.ctx);

    let pathRow = s.journal.getPath(utilPath);
    assert.ok(pathRow, "journal records the path after reconcile");
    assert.equal(pathRow.hash, sha256(readFileSync(utilPath)), "journal hash matches disk");
    let nodes = s.journal.ownedNodes(utilPath);
    if (SYM) {
      assert.equal(nodes.length, 2, "file node + symbol node (exact ownership)");
      assert.ok(nodes.some((n) => n.kind === "symbol"), "symbol indexed at L2");
      assert.equal(s.sink.nodes.size, 2, "both nodes projected to sink");
    } else {
      // Degradation branch: without tree-sitter the path still indexes at L1
      // — it never silently disappears (depth-ladder guarantee).
      assert.equal(nodes.length, 1, "no-bridge degrade keeps exactly the file node");
      assert.equal(nodes[0].kind, "file", "L1 file node present");
      assert.equal(s.sink.nodes.size, 1);
    }

    // Query side: rendered anchor resolves and verifies against content.
    const anchor = SYM
      ? (() => { const n = nodes.find((x) => x.kind === "symbol");
          return `${n.label ?? n.symbol} — ${utilPath}:${n.line}`; })()
      : utilPath;
    const hit = { title: anchor, body: `defined at ${utilPath}`, exists: true };
    const qTok = SYM ? "alphacompute" : "util";
    assert.ok(verdict(hit, [qTok]) === "STRONG", "live anchor verifies STRONG");
    assert.equal(verdict({ ...hit, exists: false }, [qTok]), "NOPATH",
      "dead anchor never verifies STRONG");

    // 2 ── rename the symbol: old node must not survive
    writeFileSync(utilPath, "def betaCompute():\n    return 2\n");
    emitHint(hints, utilPath, "agent-b");
    ingestHints(hints, s.journal);
    drain(s.ctx);

    nodes = s.journal.ownedNodes(utilPath);
    if (SYM) {
      const symStr = (n) => `${n.symbol ?? ""} ${n.label ?? ""}`;
      assert.ok(nodes.some((n) => n.kind === "symbol" && /betaCompute/i.test(symStr(n))),
        "renamed symbol indexed");
      assert.ok(!nodes.some((n) => /alphaCompute/i.test(symStr(n))),
        "no ghost of the old symbol");
      assert.equal(s.sink.nodes.size, 2, "sink projection stays exact after rewrite");
    } else {
      assert.equal(nodes.length, 1, "degraded branch still exact after rewrite");
      assert.equal(s.sink.nodes.size, 1);
    }

    // 3 ── delete the file: everything retracts, nothing dangles
    rmSync(utilPath);
    emitHint(hints, utilPath, "agent-c");
    ingestHints(hints, s.journal);
    drain(s.ctx);

    assert.equal(s.journal.ownedNodes(utilPath).length, 0, "delete retracts all owned nodes");
    assert.equal(s.sink.nodes.size, 0, "no orphaned projections after delete");
    assert.equal(s.journal.queueDepth(), 0, "queue fully drained");
  } finally { s.cleanup(); }
});
