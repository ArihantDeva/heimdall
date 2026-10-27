// doctor-truthfulness.test.mjs — regression for the defect that let the index rot
// silently: `heimdall doctor` printed HEALTHY and exited 0 while
// `heimdall score` banded critical with 152 errors.
//
// Measured before the fix (2026-10-15):
//   heimdall score --count-only  -> band "critical", errors 152, exit 1
//   heimdall doctor              -> "HEALTHY",                   exit 0
//
// `heimdall doctor` is bin/kb-health.sh, whose eight checks never read drift or
// score and which ends in an unconditional `echo "HEALTHY"`. A health check that
// cannot fail on the very signal that is red is not a health check.
//
// Strategy: drive the REAL bin/kb-health.sh end-to-end, but point it at a
// sandboxed HOME and a stub bin dir so it never touches the live 4.2 GB index.
// The stubs are the seam; the assertions are about the real script's behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEALTH = join(ROOT, "bin", "kb-health.sh");

const SCORE_CRITICAL = JSON.stringify({
  score: 0,
  band: "critical",
  issues: { errors: 152, warnings: 0, infos: 155, staleNodesPending: 0, staleNodesTotal: 0, staleScanFailed: false },
});
const SCORE_HEALTHY = JSON.stringify({
  score: 100,
  band: "healthy",
  issues: { errors: 0, warnings: 0, infos: 0, staleNodesPending: 0, staleNodesTotal: 0, staleScanFailed: false },
});
const VERIFY_DRIFT = JSON.stringify({
  ok: false,
  drift: [{ path: "/Users/x/gone.md", why: "missing" }],
  stats: { paths: 10, absent: 1, nodes: 5, edges: 4, pending: 0, queued: 0 },
});
const VERIFY_OK = JSON.stringify({
  ok: true, drift: [], stats: { paths: 10, absent: 1, nodes: 5, edges: 4, pending: 0, queued: 0 },
});

/** Build a sandboxed HOME + stub bin dir that satisfies every pre-existing check. */
function sandbox({ scoreJson, scoreExit = 0, verifyJson, verifyExit = 0 }) {
  const home = mkdtempSync(join(tmpdir(), "heimdall-doctor-home-"));
  const bin = mkdtempSync(join(tmpdir(), "heimdall-doctor-bin-"));

  // --- HOME contents the script insists on ---
  mkdirSync(join(home, ".heimdall"), { recursive: true });
  writeFileSync(join(home, ".heimdall", "semantic-state.json"),
    JSON.stringify([{ t: Math.floor(Date.now() / 1000) - 30, state: "ok" }]));

  mkdirSync(join(home, ".graft"), { recursive: true });
  writeFileSync(join(home, ".graft", "config.yaml"), "daemon:\n  socket_path: /tmp/x.sock\n");

  // A repo graph so check 3 (repo graphs under ~/Repos) passes.
  mkdirSync(join(home, "Repos", "fakerepo", "graft"), { recursive: true });

  // Fake embedding model, >10MB so check 7 does not reject it.
  const model = join(home, "fake-bge-m3.gguf");
  const fd = openSync(model, "w");
  writeSync(fd, Buffer.alloc(12 * 1024 * 1024, 1));
  closeSync(fd);

  // graftd: the script looks in three fixed locations, first wins.
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const graftd = join(home, ".local", "bin", "graftd");
  writeFileSync(graftd, `#!/bin/bash\nif [ "$1" = "--check-config" ]; then echo "model_path: ${model}"; fi\nexit 0\n`);
  chmodSync(graftd, 0o755);

  // launchd plist so check 8 passes on the file test.
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.graft.daemon.plist"), "<plist/>\n");

  // --- stub bin dir (prepended to PATH) ---
  const stub = (name, body) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/bash\n${body}\n`);
    chmodSync(p, 0o755);
  };
  stub("graft", `if [ "$1" = "version" ]; then echo "graft 0.0.0-stub"; fi\nexit 0`);
  stub("graftd", `if [ "$1" = "--check-config" ]; then echo "model_path: ${model}"; fi\nexit 0`);
  stub("plutil", `exit 0`);
  stub("launchctl", `echo "state = running"\nexit 0`);
  // The health check under test: configurable score/verify output.
  stub("heimdall", `case "$1 $2" in
  "score --count-only") printf '%s\\n' '${scoreJson}'; exit ${scoreExit};;
  "verify --json") printf '%s\\n' '${verifyJson}'; exit ${verifyExit};;
  "verify --deep") printf '%s\\n' '${verifyJson}'; exit ${verifyExit};;
  *) exit 0;;
esac`);

  return { home, bin, model };
}

function runHealth(sb, extraEnv = {}) {
  return spawnSync("bash", [HEALTH], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: sb.home,
      PATH: `${sb.bin}:${process.env.PATH}`,
      GRAFT: join(sb.bin, "graft"),
      GRAFTD_BIN: join(sb.home, ".local", "bin", "graftd"),
      ...extraEnv,
    },
  });
}

function cleanup(sb) {
  rmSync(sb.home, { recursive: true, force: true });
  rmSync(sb.bin, { recursive: true, force: true });
}

test("doctor must NOT report HEALTHY when score is critical with errors", () => {
  const sb = sandbox({ scoreJson: SCORE_CRITICAL, scoreExit: 1, verifyJson: VERIFY_DRIFT, verifyExit: 1 });
  try {
    const r = runHealth(sb);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.doesNotMatch(out, /^\s*HEALTHY\s*$/m,
      `doctor printed HEALTHY while score banded critical.\n--- output ---\n${out}`);
    assert.notEqual(r.status, 0, `doctor must exit non-zero when the index is critical.\n--- output ---\n${out}`);
  } finally { cleanup(sb); }
});

test("doctor must exit non-zero when verify reports drift", () => {
  // SCORE_HEALTHY (not SCORE_CRITICAL) on purpose. With a critical score the
  // script exits at the score gate and the drift gate below never runs, so this
  // test used to pass without ever exercising the code it claims to cover. A
  // healthy score forces control down to the verify payload — which is exactly
  // where a valid {ok:false,drift:[...]} verdict was being mislabeled
  // "malformed (ok-not-true)" and handed a schema-repair hint instead of the
  // drift count, reasons and reconcile remedy.
  const sb = sandbox({ scoreJson: SCORE_HEALTHY, verifyJson: VERIFY_DRIFT, verifyExit: 1 });
  try {
    const r = runHealth(sb);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.notEqual(r.status, 0, `verify drift must fail the health check.\n--- output ---\n${out}`);
    assert.doesNotMatch(out, /^\s*HEALTHY\s*$/m, `drift must not read as healthy.\n--- output ---\n${out}`);
    // The diagnosis must name the drift (count + reason) and the remedy that
    // clears it — not hand the operator a schema-repair hint for a valid payload.
    assert.match(out, /1 drift row/, `must name the drift count.\n--- output ---\n${out}`);
    assert.match(out, /missing/, `must name the drift reason.\n--- output ---\n${out}`);
    assert.match(out, /reconcile --all/, `must name the remedy.\n--- output ---\n${out}`);
    assert.doesNotMatch(out, /malformed|Required: an object/i,
      `a valid ok:false drift payload is not malformed.\n--- output ---\n${out}`);
  } finally { cleanup(sb); }
});

test("doctor reports HEALTHY and exits 0 when score is healthy and verify is clean", () => {
  const sb = sandbox({ scoreJson: SCORE_HEALTHY, verifyJson: VERIFY_OK });
  try {
    const r = runHealth(sb);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.status, 0, `a genuinely healthy index must pass.\n--- output ---\n${out}`);
    assert.match(out, /^\s*HEALTHY\s*$/m, `expected HEALTHY.\n--- output ---\n${out}`);
  } finally { cleanup(sb); }
});

test("doctor must not treat a degraded band as healthy", () => {
  const degraded = JSON.stringify({
    score: 70, band: "degraded",
    issues: { errors: 0, warnings: 0, infos: 30, staleNodesPending: 0, staleNodesTotal: 0, staleScanFailed: false },
  });
  const sb = sandbox({ scoreJson: degraded, scoreExit: 1, verifyJson: VERIFY_OK });
  try {
    const r = runHealth(sb);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.doesNotMatch(out, /^\s*HEALTHY\s*$/m,
      `degraded is not healthy.\n--- output ---\n${out}`);
    assert.notEqual(r.status, 0, `degraded band must fail.\n--- output ---\n${out}`);
  } finally { cleanup(sb); }
});

// ---------------------------------------------------------------------------
// Fail-open regressions (adversarial review 2026-10-15).
//
// The gate above passed while the script could STILL report HEALTHY without
// measuring anything. Three holes, all reproduced against the real script with
// the CLI seam stubbed:
//
//   bad-verify    verify --json prints "oops"        -> old: HEALTHY, exit 0
//   empty-verify  verify --json prints nothing       -> old: HEALTHY, exit 0
//   false-verify  verify --json prints ok:false, no  -> old: HEALTHY, exit 0
//                 drift rows
//   hidden        no CLI resolvable at all           -> old: HEALTHY (unverified), exit 0
//
// Root cause: the drift block was wrapped in `if [ -n "$DRIFT_JSON" ]`, so every
// unusable payload skipped it entirely and fell through to `echo HEALTHY`. An
// unreadable drift payload is an UNKNOWN, and an unknown must never be reported
// as healthy — the same laundering this whole script exists to prevent.
// ---------------------------------------------------------------------------

test("doctor must fail when verify output is unparseable", () => {
  const sb = sandbox({ scoreJson: SCORE_HEALTHY, verifyJson: "oops", verifyExit: 0 });
  try {
    const r = runHealth(sb);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.doesNotMatch(out, /^\s*HEALTHY\s*$/m,
      `unparseable verify output must never read as healthy.\n--- output ---\n${out}`);
    assert.notEqual(r.status, 0, `unparseable drift payload must fail.\n--- output ---\n${out}`);
  } finally { cleanup(sb); }
});

test("doctor must fail when verify returns empty output", () => {
  const sb = sandbox({ scoreJson: SCORE_HEALTHY, verifyJson: "", verifyExit: 0 });
  try {
    const r = runHealth(sb);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.doesNotMatch(out, /^\s*HEALTHY\s*$/m,
      `empty verify output means health is UNKNOWN, not healthy.\n--- output ---\n${out}`);
    assert.notEqual(r.status, 0, `an empty drift payload must fail.\n--- output ---\n${out}`);
  } finally { cleanup(sb); }
});

test("doctor must fail when verify says ok:false with zero drift rows", () => {
  // Zero rows is necessary but not sufficient: `verify` also reports its own
  // verdict, and ok:false with no rows means the check did not complete.
  const sb = sandbox({ scoreJson: SCORE_HEALTHY, verifyJson: '{"ok":false,"drift":[]}', verifyExit: 0 });
  try {
    const r = runHealth(sb);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.doesNotMatch(out, /^\s*HEALTHY\s*$/m,
      `ok:false with 0 rows means the check did not complete.\n--- output ---\n${out}`);
    assert.notEqual(r.status, 0, `ok:false must fail even with no drift rows.\n--- output ---\n${out}`);
  } finally { cleanup(sb); }
});

test("doctor fails rather than printing HEALTHY when the CLI cannot be resolved", () => {
  // The script resolves the CLI three ways (HEIMDALL_BIN, PATH, or the
  // bin/heimdall.js sibling), so the no-CLI branch is nearly unreachable in a
  // real checkout — that is deliberate portability (issue #15). This test pins
  // the BEHAVIOUR of that branch by driving it directly with CLI resolution
  // stubbed out, instead of trying to engineer a PATH that defeats all three
  // lookups and then silently exiting early on some unrelated missing tool.
  //
  // An earlier version of this test stripped PATH wholesale. It passed for the
  // WRONG reason — the script bailed at "SETUP NEEDED: graft binary not found"
  // before ever reaching the CLI block — so it would have kept passing even if
  // the fail-open behaviour returned. The explicit guard below rejects that.
  const src = readFileSync(HEALTH, "utf8");
  const i = src.indexOf('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
  assert.ok(i > 0, "could not locate the CLI-resolution block in kb-health.sh");
  const harness = `
set -u
exit_before=()
all_ok() { :; }
fail() { echo "FAIL: $1"; exit 1; }
if [ -z "" ]; then :; fi
# Replay the real resolver with every lookup defeated.
HEIMDALL_BIN=/definitely/missing
HEIMDALL_CMD=""
if [ -n "$HEIMDALL_BIN" ] && command -v "$HEIMDALL_BIN" >/dev/null 2>&1; then
  HEIMDALL_CMD="$HEIMDALL_BIN"
elif command -v heimdall >/dev/null 2>&1; then
  HEIMDALL_CMD="heimdall"
elif [ -f "$SCRIPT_DIR/heimdall.js" ] && command -v node >/dev/null 2>&1; then
  HEIMDALL_CMD="node $SCRIPT_DIR/heimdall.js"
fi
`;
  const tail = src.slice(src.indexOf('if [ -z "$HEIMDALL_CMD" ]; then'));
  const body = tail.slice(0, tail.indexOf('HEALTH_JSON='));
  // The branch under test is "no CLI, but an index EXISTS" -> FAIL. That
  // precondition has to be CREATED, not inherited: kb-health.sh decides by
  // probing $HEIMDALL_HOME (then $HOME) for global.db or journal.db, so on a
  // machine that happens to have an index the branch reports FAIL and the test
  // passes — and on a clean machine (every CI runner) it correctly reports
  // "HEALTHY (no index)", which this test then flags as a fail-open regression.
  // The test was measuring the operator's disk, not the script. A private
  // sandbox with one index file makes the precondition explicit and identical
  // everywhere.
  const sandbox = mkdtempSync(join(tmpdir(), "heimdall-doctor-nocli-"));
  mkdirSync(join(sandbox, ".heimdall"), { recursive: true });
  writeFileSync(join(sandbox, ".heimdall", "global.db"), "");
  let r;
  try {
    r = spawnSync("bash", ["-c", `SCRIPT_DIR=/nonexistent\n${harness}\n${body}`], {
      encoding: "utf8", timeout: 60_000,
      env: {
        ...process.env, PATH: "/usr/bin:/bin",
        HEIMDALL_HOME: sandbox,
        HOME: sandbox,
        HEIMDALL_DB: "",
      },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.doesNotMatch(out, /^\s*HEALTHY\s*$/m,
    `an unverifiable index must never be reported as healthy.\n--- output ---\n${out}`);
  assert.notEqual(r.status, 0,
    `missing CLI must fail, not warn-and-pass.\n--- output ---\n${out}`);
  assert.match(out, /cannot verify index health/i,
    `the failure must name the reason.\n--- output ---\n${out}`);
});

// ---------------------------------------------------------------------------
// Adversarial review round 3 (2026-10-15): the drift gate still failed open on
// payloads that PARSE but do not carry the required schema. All four shapes below
// printed HEALTHY and exited 0 before the fix, including one where the verifier
// process had itself exited 7.
// ---------------------------------------------------------------------------

/** Drive the real script with a stubbed CLI and a chosen verify payload. */
function runGate(verifyBody, verifyRc = 0, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "heimdall-gate-"));
  const shim = mkdtempSync(join(tmpdir(), "heimdall-gate-shim-"));
  try {
    const stub = join(shim, "stub.js");
    writeFileSync(stub, `
const a = process.argv.slice(2);
if (a[0] === "score") console.log(JSON.stringify(${JSON.stringify({ score: 100, band: "healthy", issues: { errors: 0, warnings: 0, infos: 0 } })}));
else if (a[0] === "verify") { console.log(${JSON.stringify(JSON.stringify(verifyBody))}); process.exit(${verifyRc}); }
else console.log("{}");
`);
    const cli = join(shim, "heimdall");
    writeFileSync(cli, `#!/bin/sh\nexec ${process.execPath} ${stub} "$@"\n`);
    chmodSync(cli, 0o755);
    const graft = join(shim, "graft");
    writeFileSync(graft, '#!/bin/sh\ncase "$1" in version) echo graft-test;; ask) exit 0;; *) exit 0;; esac\n');
    chmodSync(graft, 0o755);
    mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true });
    const r = spawnSync("bash", [HEALTH], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${shim}:${process.env.PATH}`, GRAFT: graft, HEIMDALL_BIN: cli, ...extraEnv },
    });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
}

test("drift payload missing the drift key must fail, not read as healthy", () => {
  const r = runGate({ ok: true });
  assert.equal(r.status, 1, `exit ${r.status} — a payload with no drift list cannot prove the index is clean:\n${r.out}`);
  assert.doesNotMatch(r.out, /^HEALTHY/m);
});

test("drift as a non-list must fail", () => {
  for (const body of [{ ok: true, drift: false }, { ok: true, drift: null }]) {
    const r = runGate(body);
    assert.equal(r.status, 1, `drift=${JSON.stringify(body.drift)} passed as healthy:\n${r.out}`);
    assert.doesNotMatch(r.out, /^HEALTHY/m);
  }
});

test("ok:false with zero rows must fail", () => {
  const r = runGate({ ok: false, drift: [] });
  assert.equal(r.status, 1, `ok:false with 0 rows passed:\n${r.out}`);
});

test("a non-zero verifier exit must fail even when the payload looks clean", () => {
  // `verify` returns `drift.length ? 1 : 0` (bin/lib/cli-main.mjs), so a non-zero
  // exit is the tool's own verdict, not a crash code. Before this gate existed, a
  // verifier exiting 7 with {"ok":true,"drift":[]} printed HEALTHY.
  const r = runGate({ ok: true, drift: [] }, 7);
  assert.equal(r.status, 1, `verifier rc=7 with a clean payload passed:\n${r.out}`);
  assert.match(r.out, /exited 7/);
});

test("a well-formed healthy payload still passes (negative control)", () => {
  const r = runGate({ ok: true, drift: [] }, 0);
  assert.equal(r.status, 0, `a healthy index must still exit 0:\n${r.out}`);
  assert.match(r.out, /HEALTHY/);
});

// ---------------------------------------------------------------------------
// Valid-drift diagnosis (the fix this suite pins).
//
// runVerify legitimately emits ok:false in two shapes that are NOT malformed:
//   dirty index  -> {ok:false, drift:[{path,why}, ...]}
//   broken graph -> {ok:false, drift:[], graph:{state:'corrupt'|'unreadable', why}}
//
// The schema gate used to require ok === true, so both were mislabeled
// "malformed (ok-not-true)" and given a schema-repair hint. They must keep
// FAILING (exit non-zero) — only the diagnosis changes: name the drift count and
// reasons with the reconcile remedy, or name the graph state, and never print a
// schema error for a payload that is well-formed.
// ---------------------------------------------------------------------------

test("a valid ok:false drift payload fails with the drift diagnosis, not a schema error", () => {
  const r = runGate({ ok: false, drift: [{ path: "/gone.md", why: "missing" }], graph: { state: "present" } }, 1);
  assert.equal(r.status, 1, `valid drift must fail:\n${r.out}`);
  assert.match(r.out, /1 drift row/);
  assert.match(r.out, /missing/);
  assert.match(r.out, /reconcile --all/);
  assert.doesNotMatch(r.out, /malformed|Required: an object/i,
    `a valid drift verdict must not be called malformed:\n${r.out}`);
});

test("a corrupt graph store with no drift fails naming the graph state", () => {
  const r = runGate({ ok: false, drift: [], graph: { state: "corrupt", path: "/x/graft.db", why: "missing sqlite header" } }, 1);
  assert.equal(r.status, 1, `a corrupt graph store must fail:\n${r.out}`);
  assert.match(r.out, /graph store is corrupt/i, `must name the graph state:\n${r.out}`);
  assert.match(r.out, /missing sqlite header/, `must carry the probe's reason:\n${r.out}`);
  assert.doesNotMatch(r.out, /malformed|Required: an object/i,
    `a valid broken-graph verdict is not malformed:\n${r.out}`);
  assert.doesNotMatch(r.out, /^HEALTHY/m);
});

test("an unreadable graph store with no drift fails naming the graph state", () => {
  const r = runGate({ ok: false, drift: [], graph: { state: "unreadable", why: "EACCES" } }, 1);
  assert.equal(r.status, 1, `an unreadable graph store must fail:\n${r.out}`);
  assert.match(r.out, /graph store is unreadable/i);
  assert.doesNotMatch(r.out, /malformed|Required: an object/i);
});

test("ok:false with zero rows and no graph state fails as unverified, not malformed", () => {
  const r = runGate({ ok: false, drift: [] }, 0);
  assert.equal(r.status, 1, `ok:false with 0 rows must fail:\n${r.out}`);
  assert.match(r.out, /did not complete|UNKNOWN/i);
  assert.doesNotMatch(r.out, /malformed|Required: an object/i,
    `ok:false is a real verdict, not a schema error:\n${r.out}`);
  assert.doesNotMatch(r.out, /^HEALTHY/m);
});

// Malformed booleans / rows / contradictions stay fail-closed.

test("a non-boolean ok (missing, string, number, null) is malformed and fails closed", () => {
  for (const body of [{ drift: [] }, { ok: "true", drift: [] }, { ok: 1, drift: [] }, { ok: null, drift: [] }]) {
    const r = runGate(body, 0);
    assert.equal(r.status, 1, `ok=${JSON.stringify(body.ok)} passed as healthy:\n${r.out}`);
    assert.match(r.out, /malformed/i, `must name the schema defect:\n${r.out}`);
    assert.doesNotMatch(r.out, /^HEALTHY/m);
  }
});

test("drift rows that are not objects are malformed and fail closed", () => {
  for (const rows of [["nope"], [null], [42]]) {
    const r = runGate({ ok: false, drift: rows }, 0);
    assert.equal(r.status, 1, `drift=${JSON.stringify(rows)} passed:\n${r.out}`);
    assert.match(r.out, /malformed|drift-row/i);
    assert.doesNotMatch(r.out, /^HEALTHY/m);
  }
});

test("a contradictory ok:true with drift rows is malformed and fails closed", () => {
  const r = runGate({ ok: true, drift: [{ path: "/x", why: "missing" }] }, 0);
  assert.equal(r.status, 1, `ok:true with rows passed:\n${r.out}`);
  assert.match(r.out, /contradict|malformed/i);
  assert.doesNotMatch(r.out, /^HEALTHY/m);
});

test("a well-formed healthy payload with an absent graph still passes (control)", () => {
  const r = runGate({ ok: true, drift: [], graph: { state: "absent", path: "/x/graft.db" } }, 0);
  assert.equal(r.status, 0, `a healthy index must still exit 0:\n${r.out}`);
  assert.match(r.out, /HEALTHY/);
});

test("99/100 healthy severity does not certify an index with valid drift", () => {
  const sb = sandbox({
    scoreJson: JSON.stringify({ score: 99, band: "healthy", issues: { errors: 0, warnings: 0, infos: 1 } }),
    verifyJson: JSON.stringify({ ok: false, drift: [{ path: "/changed.py", why: "mtime/size" }] }),
    verifyExit: 1,
  });
  try {
    const r = runHealth(sb);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.status, 1);
    assert.match(out, /1 drift row/);
    assert.match(out, /mtime\/size/);
    assert.doesNotMatch(out, /malformed|^HEALTHY/m);
  } finally { cleanup(sb); }
});

test("ok:true cannot overrule an explicitly broken graph", () => {
  for (const state of ["corrupt", "unreadable"]) {
    const r = runGate({ ok: true, drift: [], graph: { state } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /contradictory/);
    assert.doesNotMatch(r.out, /^HEALTHY/m);
  }
});

test("malformed drift reasons fail as schema errors, not parser crashes", () => {
  for (const why of [[], {}, null]) {
    const r = runGate({ ok: false, drift: [{ path: "/x", why }] });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /malformed.*drift-reason-not-a-string/);
    assert.doesNotMatch(r.out, /unparseable|^HEALTHY/m);
  }
});

test("Unicode drift evidence remains a drift verdict under an ASCII locale", () => {
  const r = runGate({ ok: false, drift: [{ path: "/x", why: "depth file → symbol" }] }, 1, {
    LC_ALL: "C", PYTHONUTF8: "0", PYTHONCOERCECLOCALE: "0",
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /1 drift row/);
  assert.match(r.out, /depth file.*symbol/);
  assert.doesNotMatch(r.out, /malformed|unparseable|^HEALTHY/m);
});

test("an explicitly malformed graph shape cannot certify a healthy payload", () => {
  for (const graph of [null, [], { state: null }, { state: "unknown" }]) {
    const r = runGate({ ok: true, drift: [], graph });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /malformed.*graph-/);
    assert.doesNotMatch(r.out, /^HEALTHY/m);
  }
});
