// mcp-kind-misuse.test.mjs — the kind param is exposed and misuse is an error.
//
// RED for Phase 1. The MCP layer collapses every nonzero exit to
// `isError: true` (mcp-server.mjs: `isError: code !== 0`), so an invalid
// --kind cannot surface as a distinct code to an MCP caller. That collapse is
// documented behaviour, not a bug to fix here — the test pins it so it stays a
// known limitation rather than becoming a surprise.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(join(repoRoot, "bin", "lib", "mcp-server.mjs"), "utf8");

test("kb_search advertises the kind enum in its input schema", () => {
  const block = SRC.slice(SRC.indexOf('name: "kb_search"'));
  const schema = block.slice(0, block.indexOf("run:"));
  for (const k of ["person", "decision", "fact", "code", "all"]) {
    assert.match(schema, new RegExp(`"${k}"`), `kind enum is missing ${k}`);
  }
  assert.match(schema, /enum:/, "kind must be an enum, not a free string");
});

test("the kind param is forwarded to the CLI as --kind", () => {
  const block = SRC.slice(SRC.indexOf('name: "kb_search"'));
  const run = block.slice(block.indexOf("run:"), block.indexOf("name: \"kb_insert\""));
  assert.match(run, /--kind/, "kb_search does not forward kind to the CLI");
});

test("the isError collapse is documented at the call site", () => {
  const block = SRC.slice(SRC.indexOf('name: "kb_search"'));
  assert.match(
    block,
    /isError|collapses every nonzero/i,
    "the exit-code collapse must be documented where kind is handled",
  );
});
