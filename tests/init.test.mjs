// heimdall CLI contract tests. The CLI wraps existing bin/ scripts —
// wrap, not rewrite. Runs against the repo checkout via HEIMDALL_HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "heimdall.js");

function run(args, opts = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    ...opts,
  });
}

test("contract: --help lists subcommands, exit 0", () => {
  const out = run(["--help"]);
  for (const cmd of ["init", "search", "insert", "doctor"]) {
    assert.ok(out.includes(cmd), `help must mention ${cmd}`);
  }
});

test("contract: unknown subcommand exits nonzero with usage", () => {
  assert.throws(
    () => run(["bogus"]),
    (e) => e.status !== 0 && /usage/i.test(e.stderr + e.stdout),
  );
});

test("contract: doctor always reports, healthy or not", () => {
  // Deliberately not asserting exit 0: that would assert a live, responsive
  // graft daemon on the machine running the tests, which is an environment
  // property, not a CLI contract — and it flakes when the concurrency tests
  // load the box. The contract is that doctor says something either way; the
  // unhealthy exit code is pinned by the SETUP NEEDED test below.
  let out;
  try { out = run(["doctor"]); } catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  assert.ok(out.length > 0, "doctor must emit a report");
});

test("contract: doctor without backend reports SETUP NEEDED, exit 1", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-doctor-"));
  assert.throws(
    () => run(["doctor"], { env: { ...process.env, HOME: home, GRAFT: "/nonexistent/graft" } }),
    (e) => e.status === 1 && /SETUP NEEDED/.test(e.stdout + e.stderr),
  );
});

test("contract: init is idempotent — twice into temp HOME, no error", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-init-"));
  const env = { ...process.env, HOME: home };
  const first = run(["init", "--harness", "pi"], { env });
  assert.ok(first.includes("pi"), "first init reports harness");
  assert.ok(existsSync(join(home, ".heimdall")), "init writes config dir");
  const second = run(["init", "--harness", "pi"], { env });
  assert.ok(second.includes("already") || second.includes("ok"), "second init idempotent");
  const cfg = JSON.parse(readFileSync(join(home, ".heimdall", "config.json"), "utf8"));
  assert.equal(cfg.harness, "pi");
});
