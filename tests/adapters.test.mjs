// Adapter smoke checks: heimdall init --harness X writes correct config files
// for each supported harness into a temp HOME. One test per harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "heimdall.js");

function initIn(harness) {
  const home = mkdtempSync(join(tmpdir(), "heimdall-adapter-"));
  execFileSync(process.execPath, [CLI, "init", "--harness", harness], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 30_000,
  });
  return home;
}

test("pi adapter: writes extension config under ~/.heimdall", () => {
  const home = initIn("pi");
  const cfg = JSON.parse(readFileSync(join(home, ".heimdall", "config.json"), "utf8"));
  assert.equal(cfg.harness, "pi");
  assert.ok(existsSync(join(home, ".heimdall", "adapters", "pi")));
});

test("claude-code adapter: writes settings hook JSON", () => {
  const home = initIn("claude-code");
  const hook = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );
  assert.ok(hook.hooks && hook.hooks.PostToolUse, "PostToolUse hook wired");
});

test("codex adapter: writes AGENTS.md snippet", () => {
  const home = initIn("codex");
  const md = readFileSync(join(home, "AGENTS.md"), "utf8");
  assert.ok(md.includes("heimdall search"), "snippet instructs search usage");
});

test("cursor/windsurf adapter: writes rules file", () => {
  const home = initIn("cursor");
  const rules = readFileSync(
    join(home, ".cursor", "rules", "heimdall.mdc"),
    "utf8",
  );
  assert.ok(rules.includes("heimdall search"));
  const home2 = initIn("windsurf");
  assert.ok(existsSync(join(home2, ".windsurf", "rules", "heimdall.md")));
});
