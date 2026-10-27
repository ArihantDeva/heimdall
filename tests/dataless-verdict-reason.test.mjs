// A dataless (iCloud-evicted) file must not be reported as
// "file changed since it was indexed".
//
// embed-index.py writes a deliberate name-only card for a dataless file: body
// `[dataless placeholder — filename only, content in iCloud]`, sha1
// `dataless:...`, and size 0 / mtime 0.0 — because there is no content to
// describe and reading the file would trigger a download.
//
// At query time the metadata check compares that placeholder against the live
// stat. size 0 != real size, so `identity` is False and the verdict fell through
// to the generic branch:
//
//     why = "file changed since it was indexed"
//
// That is factually wrong. Nothing changed; the index deliberately never read
// the file. A caller reading the reason chases an edit that never happened, or
// concludes the index is corrupt.
//
// The verdict must stay WEAK — a dataless card genuinely cannot be verified —
// but the reason must name the offload and its remedy.
//
// tests/warm-search-identity.test.mjs covers the DIFFERENT dataless case where
// the preview yields 0% query coverage. That path is unaffected: these cards
// also fail identity, and this test pins the reason that wins when it does.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

const DATALESS = "[dataless placeholder — filename only, content in iCloud]";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "heimdall-dataless-"));
  const repo = join(home, "Repos", "example");
  mkdirSync(join(repo, "graft"), { recursive: true });
  const hit = join(repo, "offloaded_notes.md");
  // The real bytes: the placeholder claimed size 0 and never read them.
  writeFileSync(hit, "offloaded notes about the deploy policy switch\n");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const graft = join(bin, "graft");
  writeFileSync(graft, '#!/bin/sh\necho called >> "$HOME/graft-calls"\nexit 1\n');
  chmodSync(graft, 0o755);
  mkdirSync(join(home, ".heimdall", "venv", "bin"), { recursive: true });
  symlinkSync(PYTHON, join(home, ".heimdall", "venv", "bin", "python3"));
  const scratch = join(home, "scratch");
  mkdirSync(scratch);
  return { home, hit, graft, scratch, db: join(home, ".heimdall", "global.db") };
}

/** Exactly the row embed-index.py writes for a dataless file: 0/0.0/NULL. */
function datalessCard(sb) {
  const db = new DatabaseSync(sb.db);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, ctime_ns INTEGER)");
    db.prepare("INSERT INTO cards (id,path,title,body,sha1,root,mtime,size,ctime_ns) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("f:" + sb.hit, sb.hit, "offloaded_notes.md",
           `${DATALESS}\noffloaded_notes.md`, "dataless:abc123", sb.home, 0.0, 0, null);
  } finally { db.close(); }
}

async function search(sb, query = "deploy policy switch") {
  const sock = join(sb.home, "query.sock");
  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      conn.end(JSON.stringify({ ok: true, hits: [{ title: "offloaded_notes.md", path: sb.hit, score: 999, leg: "lexical" }], sem_coverage: "ok" }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(sock, resolve); });
  try {
    const child = spawn("bash", [SEARCH, query], {
      env: { ...process.env, HOME: sb.home, GRAFT: sb.graft, HEIMDALL_BACKEND: "graft", HEIMDALL_REPOS: "", HEIMDALL_QUERY_SOCK: sock, TMPDIR: sb.scratch },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 15_000);
    const status = await new Promise((resolve) => child.once("close", resolve)).finally(() => clearTimeout(timer));
    return { out, err, status };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a dataless card names the iCloud offload instead of accusing the file of changing", async () => {
  const sb = fixture();
  try {
    datalessCard(sb);
    const { out, err } = await search(sb);
    assert.match(out, /offloaded_notes\.md/, `the hit must still be returned:\n${out}\n${err}`);

    // Never STRONG: no content was ever verified for this card.
    assert.doesNotMatch(out, /\[STRONG\]/, `a dataless card must never be STRONG:\n${out}`);

    // The placeholder's 0/0.0 differs from the real stat, so the generic
    // "changed" branch used to fire here and still would without the fix.
    assert.doesNotMatch(
      out,
      /file changed since it was indexed/,
      `nothing changed — the index never read this file. Wrong reason:\n${out}`,
    );
    assert.match(
      out,
      /iCloud|dataless|offload|not downloaded/i,
      `the reason must name the offload so the remedy (materialise the file) is obvious:\n${out}`,
    );
  } finally {
    rmSync(sb.home, { recursive: true, force: true });
  }
});

test("a normal (materialised) card still verifies STRONG — the dataless branch must not capture it", async () => {
  const sb = fixture();
  try {
    const st = statSync(sb.hit);
    const bst = statSync(sb.hit, { bigint: true });
    const db = new DatabaseSync(sb.db);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, ctime_ns INTEGER)");
      db.prepare("INSERT INTO cards (id,path,title,body,sha1,root,mtime,size,ctime_ns) VALUES (?,?,?,?,?,?,?,?,?)")
        .run("f:" + sb.hit, sb.hit, "offloaded_notes.md",
             "offloaded notes about the deploy policy switch", "sha-real", sb.home,
             st.mtimeMs / 1000, st.size, bst.ctimeNs);
    } finally { db.close(); }
    const { out, err } = await search(sb);
    assert.match(out, /\[STRONG\]/, `an intact materialised card must still reach STRONG:\n${out}\n${err}`);
  } finally {
    rmSync(sb.home, { recursive: true, force: true });
  }
});
