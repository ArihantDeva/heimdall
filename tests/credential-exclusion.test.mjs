// RED-first: credential material must not be admitted to, or served from, the
// semantic index.
//
// Why this test exists (measured 2026-10-15, read-only audit):
//   `kb_search "ssh private key ed25519 openssh"` returned ~/.ssh/id_ed25519,
//   ~/.ssh/jadupc_ed25519, ~/.ssh/prosesh_arihantdeva and ~/.ssh/leviathan_deploy
//   as STRONG hits. The stored card body is 411 chars and contains the OpenSSH
//   private-key PEM header plus 5 key-material lines, i.e. the COMPLETE key.
//   Search output is sent to third-party model providers, so a served card is an
//   exfiltration path, not just a local-hygiene issue.
//
// Scope measured on the live index (114,967 cards at the time of writing):
//   252 cards carried a credential-shaped string; 11 were already-excluded rows
//   awaiting a purge, 241 were a genuine policy gap (8 *.key in ~/Downloads and
//   ~/Desktop, 5 ~/.ssh|.aws, 40 real .env files, plus test fixtures holding
//   synthetic material).
//
// This is a PRE-EXISTING defect, not a regression: at git HEAD the walker has no
// HOME_PRUNE_PREFIXES and no should_exclude_path at all, so every one of these
// paths was admissible before this work started.
//
// The test asserts on path CLASSES and on the SHAPE of material, never on a real
// value - no secret may appear in a fixture, an assertion message, or a commit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import test from "node:test";
import { plainPython } from "./lib/python.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// This suite only imports embed_walker, which is stdlib-only — a plain python3
// is sufficient, so it must NOT be gated on sqlite_vec.
const PY = plainPython();

/** Ask the real policy predicate about a list of paths. */
function excluded(paths) {
  const script = `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(join(repoRoot, "bin"))})
import embed_walker as w
h = str(pathlib.Path.home())
print(json.dumps({p: bool(w.should_exclude_path(h + p)) for p in sys.argv[1:]}))
`;
  return JSON.parse(execFileSync(PY, ["-c", script, ...paths], { encoding: "utf8" }));
}

test("private key material is never admitted to the index", () => {
  // Each of these was measured SERVING as a kb_search hit before the fix.
  const r = excluded([
    "/.ssh/id_ed25519",           // measured: served as a STRONG hit
    "/.ssh/jadupc_ed25519",
    "/.ssh/prosesh_arihantdeva",
    "/.ssh/leviathan_deploy",
    "/.ssh/id_rsa",
    "/.ssh/config",
    "/Downloads/ssh-key-2026-04-10.key",
    "/Desktop/Documents/ssh-key-2026-06-08.key",
    "/Repos/app/server.key",
    "/.zvec-grep/mcp-request-state.key",
    "/.gnupg/secring.gpg",
    "/Repos/app/keystore.p12",
    "/Repos/app/cert.pem",
  ]);
  const admitted = Object.entries(r).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(admitted, [],
    `private key material is admissible (it will be indexed and served):\n  ${admitted.join("\n  ")}`);
});

test("dotfile credential stores are never admitted", () => {
  const r = excluded([
    "/.netrc",
    "/.npmrc",
    "/.pypirc",
    "/.git-credentials",
    "/.aws/credentials",
    "/.aws/config",
    "/.kube/config",
    "/.docker/config.json",
    "/.config/gh/hosts.yml",
    "/.config/gcloud/credentials.db",
    "/.terraform.d/credentials.tfrc.json",
    "/.pi/agent/auth.json",
    "/.pi/agent/auth.json.bak",
    "/.pi/agent/auth.json.bak.20261012-1400",
  ]);
  const admitted = Object.entries(r).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(admitted, [],
    `credential stores are admissible:\n  ${admitted.join("\n  ")}`);
});

test("real env files are excluded but templates are kept", () => {
  // The distinction matters in both directions: a template leaks nothing and is
  // the documented way to configure a project, so excluding it would remove real
  // source from the index - the failure mode this whole goal exists to fix.
  const real = excluded([
    "/Repos/app/.env",
    "/Repos/app/.env.local",
    "/equitylens/.vercel/.env.production.local",
    "/Repos/app/.env.production",
  ]);
  const templates = excluded([
    "/Repos/app/.env.example",
    "/Repos/app/.env.sample",
    "/Repos/app/.env.template",
  ]);
  const leaked = Object.entries(real).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(leaked, [], `real env files are admissible:\n  ${leaked.join("\n  ")}`);
  const over = Object.entries(templates).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(over, [],
    `TEMPLATES must stay indexed - over-excluding removes real source:\n  ${over.join("\n  ")}`);
});

test("public keys and ordinary source stay indexed (negative control)", () => {
  // Over-exclusion is the mirror defect. A public key is not a secret, and if the
  // rule turns into a blanket `*.key`/`.ssh/` match it would also swallow
  // legitimate repo content.
  const r = excluded([
    "/.ssh/id_ed25519.pub",
    "/.ssh/prosesh_arihantdeva.pub",
    "/Repos/app/src/main.ts",
    "/Repos/heimdall/bin/lib/reconcile.mjs",
    "/Repos/app/docs/key-rotation.md",
    "/Desktop/Automation/job-automation/evidence/a.json",
  ]);
  const wrong = Object.entries(r).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(wrong, [],
    `over-exclusion: these are legitimate and must stay indexed:\n  ${wrong.join("\n  ")}`);
});
