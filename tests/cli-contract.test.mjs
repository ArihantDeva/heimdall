// CLI contract tests for the UX audit findings (F2, F3).
// F2: unknown flags must be rejected, not silently ignored.
// F3: hint on a nonexistent path must tell the user what will happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "heimdall.js");

function run(args) {
  // Sandboxed HOME: hint writes must never touch the user's real ~/.heimdall.
  const home = mkdtempSync(join(tmpdir(), "heimdall-cli-home-"));
  mkdirSync(join(home, ".heimdall"), { recursive: true });
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, HOME: home },
  });
}

test("F2: verify rejects unknown flags with usage on stderr", () => {
  const r = run(["verify", "--bogus"]);
  assert.notEqual(r.status, 0, "unknown flag must fail");
  assert.match(r.stderr, /unknown option.*--bogus/i, "stderr must name the bad flag");
});

test("F2: depth rejects unknown flags", () => {
  const r = run(["depth", "--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown option.*--bogus/i);
});

test("F2: reconcile rejects typo'd flags (a typo must not trigger a deep audit)", () => {
  const r = run(["reconcile", "--alll"]);
  assert.equal(r.status, 2, "--alll is not --all; must be rejected, not ignored");
  assert.match(r.stderr, /unknown option.*--alll/i);
});

test("F3: hint on nonexistent path warns but still exits 0 (hint is advisory)", () => {
  const r = run(["hint", "/nonexistent/definitely-gone-xyz.md"]);
  assert.equal(r.status, 0, "hint stays advisory — absent is reconciled later");
  assert.match((r.stderr ?? "") + (r.stdout ?? ""), /does not exist|not found/i,
    "user must be told the path is missing");
});
