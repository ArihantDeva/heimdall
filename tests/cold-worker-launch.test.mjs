import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { plainPython } from "./lib/python.mjs";

const SEARCH = fileURLToPath(new URL("../bin/kb-search.sh", import.meta.url));
const py = spawnSync(plainPython(), ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
const gate = { skip: process.platform === "win32" ? "requires a POSIX shell and Unix sockets" : false };

function search(t, semantic, { staleSocket = false, warmSemantic = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "heimdall-cold-launch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "Repos", "example");
  mkdirSync(join(repo, "graft"), { recursive: true });
  const path = join(repo, "source.py");
  writeFileSync(path, "fallback content");
  writeFileSync(join(repo, "lexical.py"), "lexical fallback content");
  const log = join(home, "calls.jsonl");
  const sock = join(home, "selected.sock");
  const venv = join(home, ".heimdall", "venv", "bin", "python3");
  mkdirSync(dirname(venv), { recursive: true });
  if (semantic) {
    const db = new DatabaseSync(join(home, ".heimdall", "global.db"));
    db.exec("CREATE TABLE cards(path TEXT, mtime REAL, size INTEGER)");
    db.close();
  }
  if (staleSocket) {
    const made = spawnSync(py, ["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()", sock], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
  }
  // Make Popen startup attempts observable synchronously; no real model worker
  // is started by these tests. All other subprocesses still run normally.
  writeFileSync(join(home, "sitecustomize.py"), `
import json, os, pathlib, subprocess
def record(op, args, **extra):
    line = json.dumps({"op": op, "args": args, **extra}) + "\\n"
    with open(os.environ["TEST_CALLS"], "a") as fh: fh.write(line)
_original = subprocess.Popen
def popen(args, *a, **kw):
    if isinstance(args, (list, tuple)) and len(args) > 1 and pathlib.Path(args[1]).name == "query-server.py":
        record("launch", list(args[2:]), detached=kw.get("start_new_session", False))
        return None
    return _original(args, *a, **kw)
subprocess.Popen = popen
`);
  writeFileSync(venv, `#!${py}
import os, pathlib, sys
from sitecustomize import record
name = pathlib.Path(sys.argv[1]).name
if name == "query-server.py":
    record("launch", sys.argv[2:])
elif name == "embed-index.py":
    record("cold-query", sys.argv[2:])
    print("[0.9] Semantic fallback — " + os.environ["TEST_PATH"])
elif name == "query-shim.py":
    if os.environ["TEST_WARM_SEMANTIC"] == "1" and "--fused" not in sys.argv:
        record("warm-query", sys.argv[2:])
        print("[0.9] Warm semantic fallback — " + os.environ["TEST_PATH"])
    else:
        raise SystemExit(1) # failed warm attempt, including a crash-leftover socket
else:
    raise SystemExit("unexpected venv invocation: " + name)
`);
  chmodSync(venv, 0o755);
  const graft = join(home, "graft");
  writeFileSync(graft, "#!/bin/sh\nprintf '%s\\n' '{\"hits\":[{\"pointer\":\"lexical.py:1\",\"title\":\"Lexical fallback\",\"score\":1,\"snippet\":\"fallback\"}]}'\n");
  chmodSync(graft, 0o755);
  const r = spawnSync("bash", [SEARCH, "fallback"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: home, PYTHONPATH: home, GRAFT: graft,
      HEIMDALL_BACKEND: "graft", HEIMDALL_REPOS: repo, HEIMDALL_QUERY_SOCK: sock,
      TEST_CALLS: log, TEST_PATH: path, TEST_WARM_SEMANTIC: warmSemantic ? "1" : "0" },
  });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  let calls = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (err) { if (err.code !== "ENOENT") throw err; }
  return { ...r, calls, sock };
}

test("a cold search launches one warm worker at the selected socket and still serves both fallback legs", gate, (t) => {
  const r = search(t, true);
  const launches = r.calls.filter((c) => c.op === "launch");
  assert.equal(launches.length, 1, JSON.stringify(r.calls));
  assert.deepEqual(launches[0].args, ["--socket", r.sock]);
  assert.equal(launches[0].detached, true, "preserve the detached-worker lifecycle");
  assert.deepEqual(r.calls.map((c) => c.op), ["launch", "cold-query"], "handoff precedes the current cold producer");
  assert.match(r.stdout, /Semantic fallback/);
  assert.match(r.stdout, /Lexical fallback/);
  assert.match(r.stdout, /\[WEAK\s*\]/, "cardless fallback hits must not become verified");
});

test("a stale socket still schedules one replacement worker after warm calls fail", gate, (t) => {
  const r = search(t, true, { staleSocket: true });
  const launches = r.calls.filter((c) => c.op === "launch");
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args, ["--socket", r.sock]);
  assert.equal(launches[0].detached, true);
  assert.equal(r.calls.filter((c) => c.op === "cold-query").length, 1);
  assert.match(r.stdout, /Semantic fallback/);
});

test("a successful semantic warm fallback needs no startup or cold query", gate, (t) => {
  const r = search(t, true, { staleSocket: true, warmSemantic: true });
  assert.deepEqual(r.calls.map((c) => c.op), ["warm-query"]);
  assert.match(r.stdout, /Warm semantic fallback/);
  assert.match(r.stdout, /Lexical fallback/);
});

test("no semantic DB means no warm-worker startup, while lexical fallback remains available", gate, (t) => {
  const r = search(t, false);
  assert.deepEqual(r.calls, []);
  assert.match(r.stdout, /Lexical fallback/);
  assert.match(r.stdout, /SEMANTIC_ERROR: not-configured/);
});
