// npm-pack-contents.test.mjs — issue #12 regression gate.
//
// The L2/L3 extraction bridge (bin/lib/heimdall_extract.py) imports the
// vendored Graphify extractors at runtime. Everything in this repo is
// exercised from a *source checkout*, where vendor/graphify/ is simply
// present on disk — so a `files[]` allowlist that omits it ships a package
// whose AST extraction is silently absent, and nothing in the test suite
// notices. These tests exercise the packed artifact instead.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { capability, pythonWithTreeSitter } from "../bin/lib/depth.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

let packed = null;
/** Pack the working tree once; reuse the tarball across tests. */
function packOnce() {
  if (packed) return packed;
  const dir = mkdtempSync(join(tmpdir(), "heimdall-pack-"));
  const json = execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HEIMDALL_NO_BUILD: "1" },
  });
  const { filename } = JSON.parse(json)[0];
  packed = { tarball: join(dir, filename), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  return packed;
}

test.after(() => packed?.cleanup());

test("issue #12: the published tarball ships vendor/graphify", () => {
  const { tarball } = packOnce();
  const entries = execFileSync("tar", ["tzf", tarball], { encoding: "utf8" }).split("\n");
  const graphify = entries.filter((e) => e.includes("vendor/graphify/") && e.endsWith(".py"));
  assert.ok(
    graphify.length > 0,
    "vendor/graphify/ is absent from the npm package — heimdall_extract.py imports it at runtime, so AST extraction (L2/L3) silently degrades to file depth for every installed user",
  );
  assert.ok(
    entries.some((e) => e.includes("vendor/graphify/extract.py")),
    "vendor/graphify/extract.py (the module the bridge imports) is missing from the package",
  );
});

test("issue #12: the packed artifact performs a real L2 extraction", (t) => {
  const py = pythonWithTreeSitter();
  if (!py) return t.skip("no tree-sitter python on this machine — L2 unverifiable here");

  const { tarball } = packOnce();
  const extractDir = mkdtempSync(join(tmpdir(), "heimdall-unpack-"));
  try {
    execFileSync("tar", ["xzf", tarball, "-C", extractDir]);
    const pkg = join(extractDir, "package");
    const bridge = join(pkg, "bin", "lib", "heimdall_extract.py");
    assert.ok(existsSync(bridge), `extraction bridge missing from the package: ${bridge}`);

    const probe = join(extractDir, "probe_l2.py");
    writeFileSync(probe, "def alpha(x):\n    return x + 1\n\nclass Beta:\n    pass\n");

    const out = execFileSync(py, [bridge, probe], { encoding: "utf8", env: { ...process.env, HEIMDALL_NO_BUILD: "1" } });
    const result = JSON.parse(out).results[probe];
    assert.ok(!result.error, `extraction from the packed artifact errored: ${result.error}`);
    assert.ok(
      result.nodes.length >= 2,
      `expected the file node plus symbol nodes (alpha, Beta); got ${JSON.stringify(result.nodes.map((n) => n.label))}`,
    );
    assert.ok(
      result.nodes.some((n) => n.label === "alpha()"),
      "symbol-level (L2) nodes are absent — the bridge degraded to file depth",
    );
  } finally { rmSync(extractDir, { recursive: true, force: true }); }
});

// Second half of issue #12: capability() asked only "can python import
// tree_sitter?", so a machine with tree-sitter but no graphify was told it
// could reach graph depth while every file settled at file depth — and because
// cap_max is stamped into the journal, the upgrade stopped being re-reported.
test("issue #12: capability() does not claim graph depth without the graphify bridge", (t) => {
  const py = pythonWithTreeSitter();
  if (!py) return t.skip("no tree-sitter python here — the probe cannot be exercised");

  const emptyRoot = mkdtempSync(join(tmpdir(), "heimdall-vendorless-"));
  try {
    // Same python, same tree-sitter, no vendor/ directory to import graphify from.
    const degraded = capability({ ...process.env, HEIMDALL_PYTHON: py }, { fresh: true, root: emptyRoot });
    assert.equal(degraded.max, "file", "claimed AST depth with no extraction bridge present");
    assert.match(degraded.reason, /bridge|graphify|grammar/i, "the reason must name what is missing");

    const real = capability({ ...process.env, HEIMDALL_PYTHON: py }, { fresh: true });
    assert.equal(real.max, "graph", "this checkout vendors graphify — graph depth must be reported");
    assert.match(real.reason, /graphify/i);
  } finally { rmSync(emptyRoot, { recursive: true, force: true }); }
});

// The probe must prove a grammar actually works, not merely that a stdlib module
// imports. Grammars are imported lazily inside the extractors, and the bridge
// turns those failures into error rows the caller degrades to file depth — so an
// import-only probe answered "graph" on a machine where every non-Python file
// silently fell back. This runs the probe against a python that can import
// tree_sitter but has no language binding, the exact machine that was lied to.
test("issue #12: capability() refuses graph depth when a grammar is missing", (t) => {
  const py = pythonWithTreeSitter();
  if (!py) return t.skip("no tree-sitter python here — the probe cannot be exercised");

  const dir = mkdtempSync(join(tmpdir(), "heimdall-tsonly-"));
  try {
    const venv = join(dir, "venv");
    execFileSync(py, ["-m", "venv", venv], { stdio: "ignore" });
    const bare = join(venv, "bin", "python3");
    try {
      execFileSync(bare, ["-m", "pip", "install", "--quiet", "tree-sitter"], { stdio: "ignore", timeout: 180_000 });
    } catch {
      // Offline: the grammar-missing branch is unverifiable, not broken.
      return t.skip("cannot install tree-sitter offline — grammar-missing branch unverifiable");
    }
    execFileSync(bare, ["-c", "import tree_sitter"], { stdio: "ignore" }); // the old probe's bar

    const cap = capability({ ...process.env, HEIMDALL_PYTHON: bare }, { fresh: true });

    assert.equal(
      cap.max,
      "file",
      `a python that cannot produce symbol nodes was reported graph-capable (reason: ${cap.reason})`,
    );
    assert.match(cap.reason, /grammar|binding|symbol|bridge/i, "the reason should name what is missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
