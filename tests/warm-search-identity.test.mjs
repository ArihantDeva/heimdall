// A warm transport success is not a trust verdict. Drive the REAL shell and
// shim against a fixed socket reply; only filesystem/card state varies. These
// are contract regressions, not retrieval-quality or latency measurements.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { plainPython } from "./lib/python.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARCH = join(ROOT, "bin", "kb-search.sh");
const py = spawnSync(plainPython(), ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
assert.equal(py.status, 0, py.stderr);
const PYTHON = py.stdout.trim();

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "heimdall-warm-id-"));
  const repo = join(home, "Repos", "example");
  mkdirSync(join(repo, "graft"), { recursive: true });
  const hit = join(repo, "deploy_policy.py");
  writeFileSync(hit, "deploy policy switch\n");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const graft = join(bin, "graft");
  // Any fallback invocation is observable, not silently accepted by the test.
  writeFileSync(graft, '#!/bin/sh\necho called >> "$HOME/graft-calls"\nexit 1\n');
  chmodSync(graft, 0o755);
  mkdirSync(join(home, ".heimdall", "venv", "bin"), { recursive: true });
  symlinkSync(PYTHON, join(home, ".heimdall", "venv", "bin", "python3"));
  const scratch = join(home, "scratch");
  mkdirSync(scratch);
  return { home, hit, graft, scratch, db: join(home, ".heimdall", "global.db") };
}

function card(sb, { path = sb.hit, body = "deploy policy switch", size, mtime } = {}) {
  const st = statSync(path);
  const db = new DatabaseSync(sb.db);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, ctime_ns INTEGER)");
    // BigInt preserves nanoseconds, and makes this fixture compose with the
    // independent change-time verifier without fabricating metadata evidence.
    db.prepare("INSERT INTO cards (id,path,title,body,sha1,root,mtime,size,ctime_ns) VALUES (?,?,?,?,?,?,?,?,?)").run(path, path, "deploy_policy.py", body, "test-only", sb.home, mtime ?? st.mtimeMs / 1000, size ?? st.size, statSync(path, { bigint: true }).ctimeNs);
  } finally { db.close(); }
}

async function search(sb, { hits, coverage = "ok", query = "deploy policy", args = [], env = {}, reply, expectedStatus = 0 } = {}) {
  const sock = join(sb.home, "query.sock");
  const requests = [];
  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      requests.push(JSON.parse(buf.split("\n")[0]));
      conn.end(JSON.stringify(reply ?? { ok: true, hits: hits ?? [{ title: "deploy_policy.py", path: sb.hit, score: 999, leg: "lexical" }], sem_coverage: coverage }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(sock, resolve); });
  try {
    const child = spawn("bash", [SEARCH, ...(query.startsWith("-") ? ["--", query] : [query]), ...args], {
      env: { ...process.env, HOME: sb.home, GRAFT: sb.graft, HEIMDALL_BACKEND: "graft", HEIMDALL_REPOS: "", HEIMDALL_QUERY_SOCK: sock, TMPDIR: sb.scratch, ...env },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 15_000);
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(status, expectedStatus, `unexpected search status:\n${out}\n${err}`);
    assert.equal(requests.length, 1, "a warm answer must not trigger a second request");
    assert.equal(requests[0].op, "search");
    assert.equal(existsSync(join(sb.home, "graft-calls")), false, "warm verification must not fan out to graft");
    assert.deepEqual(readdirSync(sb.scratch), [], "warm reply/error scratch must be cleaned");
    return { out, err, request: requests[0] };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const cases = [
  ["missing card", () => {}, /no index card/],
  ["changed size", (sb) => card(sb, { size: 999999 }), /changed since it was indexed/],
  ["changed mtime", (sb) => card(sb, { mtime: statSync(sb.hit).mtimeMs / 1000 - 3600 }), /changed since it was indexed/],
  ["missing path", (sb) => { card(sb); rmSync(sb.hit); }, /anchor is gone/],
  ["directory", (sb) => { rmSync(sb.hit); mkdirSync(sb.hit); card(sb); }, /no longer a regular file/],
  ["symlink", (sb) => { const other = join(sb.home, "other.py"); writeFileSync(other, "deploy policy switch\n"); rmSync(sb.hit); symlinkSync(other, sb.hit); card(sb); }, /no longer a regular file/],
  ["unrelated indexed content despite matching filename", (sb) => card(sb, { body: "unrelated opaque text" }), /query tokens cover only 0%/],
  ["minimal-file name-only preview", (sb) => { writeFileSync(sb.hit, ""); card(sb, { body: "[minimal file]\ndeploy_policy.py" }); }, /query tokens cover only 0%/],
  ["dataless name-only preview", (sb) => card(sb, { body: "[dataless placeholder — filename only, content in iCloud]\ndeploy_policy.py" }), /query tokens cover only 0%/],
];
for (const [name, prepare, reason] of cases) {
  test(`warm search does not claim STRONG on ${name}`, async () => {
    const sb = fixture();
    try {
      prepare(sb);
      const { out } = await search(sb);
      assert.match(out, /deploy_policy\.py/, "hit is still returned");
      assert.doesNotMatch(out, /\[STRONG\]/, `unverified warm hit:\n${out}`);
      assert.match(out, reason);
    } finally { rmSync(sb.home, { recursive: true, force: true }); }
  });
}

test("an unchanged, relevant warm card is STRONG and keeps scope", async () => {
  const sb = fixture();
  try {
    card(sb);
    const { out, request } = await search(sb, { args: ["--scope", "example"] });
    assert.match(out, /\[STRONG\]/);
    assert.match(out, /cov100%/);
    assert.equal(request.scope, "example");
  } finally { rmSync(sb.home, { recursive: true, force: true }); }
});

test("a warm hit from an unreadable index names the failure on stdout", async () => {
  const sb = fixture();
  try {
    writeFileSync(sb.db, "not a database");
    const { out } = await search(sb);
    assert.match(out, /INDEX_ERROR:/);
    assert.match(out, /index unreadable/);
    assert.doesNotMatch(out, /\[STRONG\]/);
  } finally { rmSync(sb.home, { recursive: true, force: true }); }
});

test("warm JSON preserves semantic provenance but does not promote related siblings", async () => {
  for (const related of [false, true]) {
    const sb = fixture();
    try {
      card(sb, { body: "deploy" }); // only 1/3 tokens: a lexical hit stays WEAK
      const { out } = await search(sb, {
        query: "deploy policy switch",
        hits: [{ path: sb.hit, title: "deploy_policy.py", score: 3.8, leg: "semantic", related }],
      });
      assert.match(out, related ? /\[WEAK\s*\]/ : /\[STRONG\]/);
      assert.match(out, /cov33%/);
    } finally { rmSync(sb.home, { recursive: true, force: true }); }
  }
});

test("warm verification preserves paths, same-title hits, and degraded coverage", async () => {
  const sb = fixture();
  try {
    const other = join(dirname(sb.hit), "file — with spaces.py");
    writeFileSync(other, "deploy policy switch\n");
    card(sb);
    card(sb, { path: other });
    const hits = [sb.hit, other].map((path) => ({ path, title: "same — title", score: 1.0, leg: "lexical" }));
    const { out } = await search(sb, { hits, coverage: "degraded" });
    assert.match(out, /warm fused: LEXICAL-ONLY — semantic leg degraded/);
    assert.equal((out.match(/\[STRONG\]/g) || []).length, 2);
    assert.ok(out.includes(other), out);
    assert.equal((out.match(/same — title/g) || []).length, 2);
  } finally { rmSync(sb.home, { recursive: true, force: true }); }
});

test("an empty warm reply stays a successful empty answer, not a fallback", async () => {
  const sb = fixture();
  try {
    const { out } = await search(sb, { hits: [] });
    assert.doesNotMatch(out, /\[(STRONG|WEAK|NOPATH)/);
  } finally { rmSync(sb.home, { recursive: true, force: true }); }
});

test("warm verification never opens the target file", async () => {
  const sb = fixture();
  try {
    card(sb);
    const hooks = join(sb.home, "hooks");
    mkdirSync(hooks);
    const log = join(sb.home, "audit.log");
    writeFileSync(join(hooks, "sitecustomize.py"), `import os, sys\nfd = os.open(os.environ['AUDIT_LOG'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\nos.write(fd, b'loaded\\n')\ndef audit(event, args):\n    if event == 'open' and args[0] == os.environ['AUDIT_TARGET']:\n        os.write(fd, b'TARGET_OPEN\\n')\nsys.addaudithook(audit)\n`);
    const { out } = await search(sb, { env: { PYTHONPATH: hooks, AUDIT_LOG: log, AUDIT_TARGET: sb.hit } });
    assert.match(out, /\[STRONG\]/, "the negative control must really verify");
    const opens = readFileSync(log, "utf8");
    assert.match(opens, /loaded/, "audit hook must run");
    assert.doesNotMatch(opens, /TARGET_OPEN/);
  } finally { rmSync(sb.home, { recursive: true, force: true }); }
});

test("a malformed successful warm payload fails closed and cleans its scratch", async () => {
  for (const reply of [
    { ok: true },
    { ok: true, hits: null },
    { ok: true, hits: [null] },
    { ok: true, hits: [{ path: 42, title: "t", score: 1 }] },
    { ok: true, hits: [{ path: "/x", title: "t", score: "999" }] },
    { ok: true, hits: [{ path: "/x", title: "t", score: true }] },
    { ok: true, hits: [{ path: "/x", title: "t", score: null }] },
    { ok: 1, hits: [] },
  ]) {
    const sb = fixture();
    try {
      const { out } = await search(sb, { reply, expectedStatus: 1 });
      assert.match(out, /SEARCH_ERROR: invalid warm reply/);
      assert.doesNotMatch(out, /\[STRONG\]/);
    } finally { rmSync(sb.home, { recursive: true, force: true }); }
  }
});

test("warm path dedupe keeps the highest score and respects ordered -n truncation", async () => {
  const sb = fixture();
  try {
    const paths = [sb.hit, join(dirname(sb.hit), "b.py"), join(dirname(sb.hit), "c.py")];
    for (const path of paths) {
      writeFileSync(path, "deploy policy switch\n");
      card(sb, { path });
    }
    const hit = (path, score) => ({ path, title: path, score, leg: "lexical" });
    const { out } = await search(sb, {
      args: ["-n", "2"],
      hits: [hit(paths[2], 1), hit(paths[0], 2), hit(paths[1], 3), hit(paths[0], 4)],
    });
    const resultLines = out.split("\n").filter((line) => /^\s*\d+\. \[/.test(line));
    assert.equal(resultLines.length, 2);
    assert.ok(resultLines[0].endsWith(paths[0]), out);
    assert.ok(resultLines[1].endsWith(paths[1]), out);
    assert.doesNotMatch(resultLines.join("\n"), /c\.py/);
  } finally { rmSync(sb.home, { recursive: true, force: true }); }
});

test("literal query flags survive the warm JSON transport", async () => {
  for (const query of ["--json", "--scope", "--fused", "--"]) {
    const sb = fixture();
    try {
      card(sb);
      const { request } = await search(sb, { query });
      assert.equal(request.q, query);
    } finally { rmSync(sb.home, { recursive: true, force: true }); }
  }
});

test("flag-shaped scope values are data, not warm transport options", async () => {
  for (const scope of ["--json", "--fused", "--scope", "--related", "--", "-n"]) {
    const sb = fixture();
    try {
      card(sb);
      const { request } = await search(sb, { args: ["--scope", scope] });
      assert.equal(request.scope, scope);
      assert.equal(request.q, "deploy policy");
      assert.equal(request.related, false);
      assert.equal(request.n, 6);
    } finally { rmSync(sb.home, { recursive: true, force: true }); }
  }
});
