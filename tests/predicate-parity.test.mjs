// The index has TWO admission predicates that must agree on credential material:
//
//   bin/embed_walker.py   should_exclude_path()  -> decides what gets INDEXED
//   bin/lib/reconcile.mjs skipPath()             -> decides what the JOURNAL tracks
//
// They are written in different languages and evolved separately, so they drift.
// Measured 2026-10-15: skipPath() already rejected ~/.ssh/id_ed25519 and
// ~/.pi/agent/auth.json (via its dotdir and Library rules) but ADMITTED
// <repo>/.env — so the journal kept tracking secret-bearing files the Python
// walker had just learned to exclude. A row the journal tracks can be reconciled,
// re-embedding the secret after the walker was fixed.
//
// This test pins the invariant rather than either implementation: for a shared
// corpus, the two predicates must agree. It is the assertion whose absence let
// the credential leak survive an earlier fix to one side only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const VENV_PY = join(homedir(), ".heimdall", "venv", "bin", "python3");
const PY = existsSync(VENV_PY) ? VENV_PY : "python3";

/** Paths (HOME-relative) with the verdict BOTH predicates must reach. */
const CORPUS = [
  // credential material — both must exclude
  ["/.ssh/id_ed25519", true],
  ["/.ssh/id_rsa", true],
  ["/.ssh/id_ed25519.pub", false], // a public key is not a secret
  ["/.pi/agent/auth.json", true],
  ["/.aws/credentials", true],
  ["/.netrc", true],
  ["/.config/gcloud/legacy_credentials/x/adc.json", true],
  ["/Downloads/ssh-key-2026-04-10.key", true],
  ["/Repos/app/.env", true],
  ["/Repos/app/.env.production.local", true],
  ["/Repos/app/.env.example", false], // template, not a secret
  ["/Repos/app/cert.pem", true],
  // ordinary source — both must admit
  ["/Repos/app/src/main.ts", false],
  ["/Repos/heimdall/bin/lib/reconcile.mjs", false],
  ["/Repos/app/docs/key-rotation.md", false],
];

test("the JS and Python admission predicates agree on every corpus path", async () => {
  const { skipPath } = await import(join(repoRoot, "bin", "lib", "reconcile.mjs"));
  const home = homedir();

  const script = `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
import embed_walker as w
h = str(pathlib.Path.home())
print(json.dumps([p for p in sys.argv[1:] if w.should_exclude_path(h + p)]))
`;
  const pyExcluded = new Set(
    JSON.parse(execFileSync(PY, ["-c", script, ...CORPUS.map(([p]) => p)], { encoding: "utf8" })),
  );

  const disagreements = [];
  for (const [rel, expected] of CORPUS) {
    const js = skipPath(home + rel, home);
    const py = pyExcluded.has(rel);
    if (js !== py) {
      disagreements.push(`${rel}\n      skipPath(js)=${js}  should_exclude_path(py)=${py}  expected=${expected}`);
    }
  }
  assert.deepEqual(disagreements, [],
    `the two predicates disagree, so a path excluded by one is still admitted by the other:\n  ${disagreements.join("\n  ")}`);
});

test("both predicates reach the expected verdict (not just the same wrong one)", async () => {
  // Agreement alone is not enough — both could agree on the wrong answer. This
  // pins the verdicts the corpus declares.
  const { skipPath } = await import(join(repoRoot, "bin", "lib", "reconcile.mjs"));
  const home = homedir();
  const script = `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
import embed_walker as w
h = str(pathlib.Path.home())
print(json.dumps({p: bool(w.should_exclude_path(h + p)) for p in sys.argv[1:]}))
`;
  const py = JSON.parse(execFileSync(PY, ["-c", script, ...CORPUS.map(([p]) => p)], { encoding: "utf8" }));

  const wrong = [];
  for (const [rel, expected] of CORPUS) {
    if (py[rel] !== expected) wrong.push(`py  ${rel} got=${py[rel]} want=${expected}`);
    if (skipPath(home + rel, home) !== expected) wrong.push(`js  ${rel} got=${!expected} want=${expected}`);
  }
  assert.deepEqual(wrong, [], `wrong verdicts:\n  ${wrong.join("\n  ")}`);
});
