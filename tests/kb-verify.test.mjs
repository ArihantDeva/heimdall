// Content-aware verdict contract (T-002): a hit whose file content lacks
// lexical coverage of the query must NOT be STRONG even if the path exists;
// a content-strong hit upgrades WEAK -> STRONG. Drives bin/kb_search_verify.py
// in --selftest mode (no graft daemon needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
