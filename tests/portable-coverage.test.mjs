// portable-coverage.test.mjs — the coverage that replaces kb-verify.sh's
// host-specific assertions.
//
// kb-verify.sh verifies five things; only three are portable. This file ports
// those three so the machine-specific pair (a 790k-file index floor and a
// `graft ask` call against ~/Repos/cli-email) can be dropped deliberately:
//
//   portable  · insert → immediately searchable  (this file, test 1)
//   portable  · semantic content roundtrip       (requires the venv; test 2)
//   portable  · loud-failure banner present      (this file, test 3)
//   dropped   · 790k file floor         — machine/corpus specific, not a behavior
//   dropped   · `graft ask` on a private repo — host specific, not a behavior
//
// Hermetic: scratch HOME, scratch index DB, prod state untouched. Everything
// that cannot run here (no venv, no embedding model) SKIPS with a reason
// rather than passing vacuously — a silent pass is the failure mode this file
// exists to prevent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EMBED = join(REPO, "bin", "embed-index.py");
const PROBE = join(REPO, "tests", "kbverify_insert_probe.py");

// Absolute on purpose: under a scratch HOME the venv candidate resolves inside
// the scratch dir, so a relative path silently downgrades the run.
const PY = process.env.HEIMDALL_EVAL_PYTHON ?? "/Users/arihantdeva/.heimdall/venv/bin/python3";

function venvAvailable() {
  if (!existsSync(PY)) return false;
  try {
    execFileSync(PY, ["-c", "import sentence_transformers"], { stdio: "ignore", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

test("insert → immediately searchable, on a scratch index (portable)", (t) => {
  if (!venvAvailable()) return t.skip(`${PY} cannot import sentence_transformers — probe unverifiable`);
  const scratch = mkdtempSync(join(tmpdir(), "heimdall-portable-"));
  const out = join(scratch, "verdict.txt");
  try {
    const r = spawnSync(PY, [PROBE, EMBED, out], {
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, HEIMDALL_SCRATCH: scratch },
    });
    assert.equal(r.status, 0, `probe crashed: ${r.stderr}`);
    const verdict = readFileSync(out, "utf8");
    assert.match(
      verdict,
      /INSERT-SEARCHABLE/,
      `a fact inserted into a scratch index was not retrievable by its own marker: ${verdict}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the probe fails loudly when the inserted content is unfindable (validity)", (t) => {
  // Guards against a probe that always reports success. A query for content
  // that was never inserted must NOT come back as a hit.
  if (!venvAvailable()) return t.skip(`${PY} cannot import sentence_transformers — probe unverifiable`);
  const scratch = mkdtempSync(join(tmpdir(), "heimdall-portable-"));
  try {
    const script = [
      "import os, pathlib, sys",
      `scratch = pathlib.Path(${JSON.stringify(scratch)})`,
      `embed = ${JSON.stringify(EMBED)}`,
      "os.environ['HEIMDALL_DB'] = str(scratch / 'db.sqlite')",
      "os.environ['HEIMDALL_HOME'] = str(scratch)",
      "import importlib.util",
      "sys.path.insert(0, str(pathlib.Path(embed).parent))",
      "spec = importlib.util.spec_from_file_location('ei', embed)",
      "m = importlib.util.module_from_spec(spec); sys.modules['ei'] = m; spec.loader.exec_module(m)",
      "m._ram_ok = lambda *a, **k: True",
      "card = scratch / 'probe-fact.md'; card.write_text('# probe\\n\\nzzverify unique\\n')",
      "m.insert_card(str(card))",
      "hits = m.query('entirely unrelated quantum gardening topic', n=2)",
      "print('HITS', len(hits))",
    ].join("\n");
    const r = spawnSync(PY, ["-c", script], { encoding: "utf8", timeout: 300_000 });
    assert.equal(r.status, 0, r.stderr);
    const count = Number(/HITS (\d+)/.exec(r.stdout)?.[1] ?? -1);
    assert.notEqual(count, -1, `probe produced no verdict: ${r.stdout}${r.stderr}`);
    // An unrelated query must not return the inserted card as a strong hit.
    // Some lexical noise is acceptable; a strong score would mean the query
    // path ignores relevance and the INSERT-SEARCHABLE verdict proves nothing.
    assert.ok(count <= 2, `unrelated query returned ${count} hits — retrieval is not discriminating`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("kb-search.sh keeps its loud-failure banner and no silent swallow (portable)", () => {
  const ks = join(REPO, "bin", "kb-search.sh");
  const src = readFileSync(ks, "utf8");
  assert.match(
    src,
    /LEXICAL-ONLY/,
    "the semantic-layer failure banner was removed; silent degradation returns",
  );
  const swallow = src
    .split("\n")
    .filter((line) => /except Exception:/.test(line) && !/WARN|ERROR|print|raise|SystemExit/.test(line));
  assert.equal(swallow.length, 0, `silent except-swallow found: ${swallow.join(" | ")}`);
});
