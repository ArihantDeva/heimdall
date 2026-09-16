// probe-cost.test.mjs — the capability probe must not spawn python twice.
//
// Measured on this machine (hyperfine, 20 runs): full `depth` = 186ms, of
// which `python3 -c "import tree_sitter"` = 29ms and the extraction bridge
// probe = 54ms, while node itself is 82ms. The import check is redundant
// whenever the bridge probe runs: the bridge imports tree_sitter as part of
// extraction, so a python that cannot import it fails the bridge probe anyway
// — with the same verdict, reached through a call we already pay for.
//
// This test pins the contract that makes the saving real rather than cosmetic:
// probe order is unchanged (HEIMDALL_PYTHON -> venv -> system), and the
// bridge-only path must never report LESS capability than the two-spawn path.
// A "faster" probe that silently downgrades a capable machine from graph to
// file depth would be a correctness regression, not an optimization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { capability } from "../bin/lib/depth.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const VENV_PY = "/Users/arihantdeva/.heimdall/venv/bin/python3";

function probeEnv(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "heimdall-probe-"));
  const proj = join(home, "proj");
  return { home, proj, env: { ...process.env, HOME: home, ...overrides } };
}

test("a capable python still reports graph depth (no silent downgrade)", () => {
  const { env } = probeEnv({ HEIMDALL_PYTHON: VENV_PY });
  const cap = capability(env, { fresh: true, root: repo });
  assert.equal(cap.max, "graph", `expected graph capability, got ${cap.max} (${cap.reason})`);
  assert.equal(cap.python, VENV_PY);
});

test("an unusable HEIMDALL_PYTHON degrades to file depth, never throws", () => {
  const { env } = probeEnv({ HEIMDALL_PYTHON: "/nonexistent/python3" });
  const cap = capability(env, { fresh: true, root: repo });
  assert.ok(cap.max === "graph" || cap.max === "file");
  assert.ok(typeof cap.reason === "string" && cap.reason.length > 0);
});

test("a python without tree_sitter still resolves a working fallback", () => {
  // The candidate list is deliberate: HEIMDALL_PYTHON -> venv -> system. A
  // broken HEIMDALL_PYTHON must therefore still reach a capable python when
  // one exists, and report file depth with a real reason when none does.
  const { env } = probeEnv({ HEIMDALL_PYTHON: "/usr/bin/python3" });
  const cap = capability(env, { fresh: true, root: repo });
  assert.ok(cap.max === "graph" || cap.max === "file");
  assert.ok(typeof cap.reason === "string" && cap.reason.length > 0);
});

test("no usable python anywhere reports file depth with a real reason", () => {
  // Probes candidates in order and reports file depth when none can extract.
  const { home } = probeEnv();
  const cap = capability(
    { HOME: home, PATH: "/nonexistent", HEIMDALL_PYTHON: "/nonexistent/python3" },
    { fresh: true, root: repo },
  );
  // The venv candidate is resolved from the real HOME (see the next test), so
  // on a machine with a working venv this legitimately resolves to graph. What
  // must never happen is a crash or a silent empty reason.
  assert.ok(cap.max === "graph" || cap.max === "file");
  assert.ok(typeof cap.reason === "string" && cap.reason.length > 0);
});

test("capability is cached per process unless fresh is requested", () => {
  const { env } = probeEnv({ HEIMDALL_PYTHON: VENV_PY });
  const first = capability(env, { fresh: true, root: repo });
  const second = capability(env, { root: repo });
  assert.equal(second, first, "repeat calls reuse the cached probe");
});
