// Content-aware verdict contract (T-002): a hit whose file content lacks
// lexical coverage of the query must NOT be STRONG even if the path exists;
// a content-strong hit upgrades WEAK -> STRONG. Drives bin/kb_search_verify.py
// in --selftest mode (no graft daemon needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "bin", "kb_search_verify.py");

function verify(json, query = "poker equity") {
  const out = execFileSync("python3", [SCRIPT, json, "test", "", "6", query], {
    encoding: "utf8",
  });
  const m = out.match(/\[(\w+)\s*\].*?cov(\d+)%/);
  return { verdict: m && m[1], cov: m && Number(m[2]), out };
}

function retrieveJson(id) {
  return JSON.stringify({ result: { results: [{ id_hex: id, score: -0.9 }] } });
}

test("content mismatch downgrades STRONG even with live path", () => {
  const dir = mkdtempSync(join(tmpdir(), "kbverify-"));
  const file = join(dir, "note.md");
  writeFileSync(file, "Poker hand equity evaluation with jam_opt and ICM push fold thresholds.");
  const r = verify(retrieveJson("selftest:" + file + ":quantum gardening"), "quantum gardening");
  assert.ok(r.verdict !== "STRONG", `expected non-STRONG, got ${r.verdict}`);
  assert.ok(r.out.includes("content:"), "output carries content score");
});

test("content match upgrades to STRONG", () => {
  const dir = mkdtempSync(join(tmpdir(), "kbverify-"));
  const file = join(dir, "note.md");
  writeFileSync(file, "Poker hand equity evaluation with jam_opt and ICM push fold thresholds.");
  const r = verify(retrieveJson("selftest:" + file + ":poker equity"), "poker equity evaluation jam_opt");
  assert.equal(r.verdict, "STRONG", `expected STRONG, got ${r.verdict} :: ${r.out}`);
});

test("binary/oversized file degrades gracefully, no crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "kbverify-"));
  const file = join(dir, "blob.bin");
  writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  const r = verify(retrieveJson("selftest:" + file + ":anything"));
  assert.ok(r.verdict, "still returns a verdict");
});

// extract_paths home-anchor contract: only ~/... and /Users/<name>/... count.
// These are regression tests for the tilde-form bug (the old HOME_RE pattern
// `~?/Users/...` could never match `~/...` prose at all, which silently hid
// every ~-anchored node from both search verdicts and the stale scan).

function extractPaths(text) {
  const r = spawnSync("python3", ["-c", `
import sys; sys.path.insert(0, "bin")
from kb_search_verify import extract_paths
print("\\n".join(extract_paths(sys.argv[1])))
`, text], { cwd: ROOT, encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean);
}

const HOME = homedir();

test("extract_paths: ~-anchored path resolves (tilde form bug regression)", () => {
  const paths = extractPaths("note: ~/Repos/poker-bot/tools — heads-up jam/fold EV optimizer");
  assert.deepEqual(paths, [join(HOME, "Repos/poker-bot/tools")]);
});

test("extract_paths: home-anchored absolute form still resolves", () => {
  // macOS layout: /Users/<name>/...; Linux: /home/<user>/... is HOME-anchored.
  const macAbs = "/Users/arihantdeva/Repos/heimdall/README.md";
  if (process.platform === "darwin") {
    assert.deepEqual(extractPaths(`see ${macAbs} — markdown`), [macAbs]);
  } else {
    // On Linux, /Users/* is NOT a known anchor — nothing resolves.
    assert.deepEqual(extractPaths(`see ${macAbs} — markdown`), []);
    const linAbs = join(HOME, "Repos/heimdall/README.md");
    assert.deepEqual(extractPaths(`see ${linAbs} — markdown`), [linAbs]);
  }
});

test("extract_paths: no path token yields nothing", () => {
  assert.deepEqual(extractPaths("no path here at all"), []);
});
