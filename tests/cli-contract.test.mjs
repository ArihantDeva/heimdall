// CLI contract tests for the UX audit findings (F2, F3) and the facts shim
// (spec D3). F2: unknown flags must be rejected, not silently ignored.
// F3: hint on a nonexistent path must tell the user what will happen.
// facts-cli: stdout carries ONE parseable JSON array and nothing else;
// any failure goes to stderr with a nonzero exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "heimdall.js");
const FACTS_CLI = join(ROOT, "bin", "lib", "facts-cli.mjs");

function runFactsCli(args) {
  // No sandboxed HOME needed: facts-cli reads exactly the path it is given
  // and writes nothing anywhere — pure bytes → stdout.
  return spawnSync(process.execPath, [FACTS_CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

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

test("insert persists exact content and normalizes comma/repeated keywords", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-cli-insert-"));
  const cwd = mkdtempSync(join(tmpdir(), "heimdall-cli-cwd-"));
  try {
    const body = "Exact first line.\nExact second line: café λ.\n";
    const r = spawnSync(process.execPath, [
      CLI, "insert", "--title", "CLI durable memory", "--body", body,
      "--keywords", "zircon,precedence", "--keywords", "Precedence", "--keywords", "durable",
    ], {
      cwd, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.searchable, true);
    assert.ok(result.id.startsWith("mem-"));
    assert.equal(existsSync(result.path), true);
    const record = JSON.parse(readFileSync(result.path, "utf8"));
    assert.equal(record.body, body);
    assert.deepEqual(record.keywords, ["zircon", "precedence", "durable"]);
    assert.equal(record.cwd, cwd);
    assert.equal(existsSync(join(home, ".heimdall", "hints.jsonl")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── facts-cli.mjs: bench ingest contract (spec D3/D6) ────────────────────────
test("facts-cli: happy path prints ONE parseable JSON fact array on stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-facts-cli-"));
  try {
    const log = join(dir, "prompts.jsonl");
    const recs = [
      JSON.stringify({ at: "2026-08-23T00:00:01Z", cwd: dir, text: "I prefer SQLite over Postgres." }),
      JSON.stringify({ at: "2026-08-23T00:00:02Z", cwd: dir, text: "Heimdall is a local-first memory layer." }),
    ];
    writeFileSync(log, recs.join("\n") + "\n");
    const r = runFactsCli(["--file", log]);
    assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
    const facts = JSON.parse(r.stdout); // throws unless the WHOLE stdout parses
    assert.ok(Array.isArray(facts), "stdout must decode to an array");
    assert.ok(facts.length >= 2, `want >=2 facts, got ${facts.length}`);
    for (const f of facts) {
      assert.deepEqual(Object.keys(f).sort(), ["body", "id", "keywords", "line", "title"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("facts-cli: empty file exits 0 with an empty array on stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-facts-cli-"));
  try {
    const log = join(dir, "empty.jsonl");
    writeFileSync(log, "");
    const r = runFactsCli(["--file", log]);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("facts-cli: missing file errors on stderr with nonzero exit, stdout clean", () => {
  const r = runFactsCli(["--file", "/nonexistent/facts-input-xyz.jsonl"]);
  assert.notEqual(r.status, 0, "unreadable input must fail, not print []");
  assert.equal((r.stdout ?? "").trim(), "", "no partial output may reach stdout");
  assert.match(r.stderr, /cannot read/i, "stderr must say what went wrong");
});

test("facts-cli: rejects unknown flags (F2 doctrine applies to this shim too)", () => {
  const r = runFactsCli(["--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown argument.*--bogus/);
  assert.equal((r.stdout ?? "").trim(), "");
});
