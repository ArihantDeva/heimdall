// kb-search-identity.test.mjs — issue #13 regression gate.
//
// README: STRONG means "Agents can act on STRONG without a confirmation
// round-trip." That promise is only true if STRONG rests on evidence that the
// indexed content IS the content on disk. Path existence plus query-token
// overlap is not that evidence: a semantic hit whose body is synthesized as
// `semantic hit [<path>]` scores full coverage from the path alone, and a card
// left behind by a stale index still points at a live file.
//
// The fix rests STRONG on a deterministic content-identity check against the
// index card (size), so the verdict pass never has to open — let alone read —
// the files it judges. These tests pin both halves: the verdict, and the
// absence of any content read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const shellTest = process.platform === "win32" ? test.skip : test;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const KB_SEARCH = join(repoRoot, "bin", "kb-search.sh");

const CARDS_DDL = "CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL)";

/** Sandbox HOME with a graft stub, one repo graph, and one indexed hit file. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "heimdall-identity-"));
  const graft = join(home, ".local", "bin", "graft");
  mkdirSync(dirname(graft), { recursive: true });
  copyFileSync(join(repoRoot, "tests", "fixtures", "fake-graft.sh"), graft); // hit pointer: src/file.py:1
  chmodSync(graft, 0o755);
  const repo = join(home, "Repos", "example");
  mkdirSync(join(repo, "graft"), { recursive: true });
  const hit = join(repo, "src", "file.py");
  mkdirSync(dirname(hit), { recursive: true });
  writeFileSync(hit, "print('indexed payload')\n");
  return { home, hit, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Write $HOME/.heimdall/global.db carrying one card row for `path`. */
function writeCard(home, path, { size, title = "Expected hit", body = "example", mtime = Date.now() / 1000 }) {
  const db = join(home, ".heimdall", "global.db");
  mkdirSync(dirname(db), { recursive: true });
  execFileSync("/usr/bin/python3", ["-c", [
    "import sqlite3,sys",
    `con = sqlite3.connect(${JSON.stringify(db)})`,
    `con.execute(${JSON.stringify(CARDS_DDL)})`,
    `con.execute('INSERT INTO cards VALUES ("1", ?, ?, ?, ?, "r", ?, ?)', (${JSON.stringify(path)}, ${JSON.stringify(title)}, ${JSON.stringify(body)}, "s1", ${mtime}, ${size}))`,
    "con.commit()",
  ].join("; ")]);
  return db;
}

/** The env every sandboxed kb-search run shares: isolated HOME, bare PATH. */
const runEnv = (home, extra = {}) => ({
  ...process.env,
  HOME: home,
  PATH: "/usr/bin:/bin",
  GRAFT: undefined,
  MNEMOSYNE: undefined,
  HEIMDALL_BACKEND: undefined,
  ...extra,
});

const search = (home, extra) => execFileSync("bash", [KB_SEARCH, "example"], {
  encoding: "utf8",
  env: runEnv(home, extra),
});

shellTest("issue #13: a card that disagrees with the file on disk is not STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    // The index recorded a size that no longer matches the file: the card is
    // stale, so whatever it holds is not what is on disk now.
    writeCard(home, hit, { size: 999_999 });

    const stdout = search(home);

    assert.match(stdout, /Expected hit/, "hit still returned (ranked, just not trusted)");
    assert.doesNotMatch(stdout, /STRONG/, `stale card must not be STRONG:\n${stdout}`);
    assert.match(stdout, /\[WEAK\s*\]/, "an anchored-but-unverified hit is WEAK");
  } finally { cleanup(); }
});

// A same-length rewrite is the case a size-only check cannot see: the bytes are
// the same count, the meaning is opposite. Trusting it would let the index
// vouch for content it never read.
shellTest("issue #13: a size-preserving rewrite is not STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    writeFileSync(hit, "ALLOWED=1\n");
    writeCard(home, hit, { size: 10, mtime: Date.now() / 1000 - 3600 }); // indexed an hour ago
    writeFileSync(hit, "DELETED=1\n"); // same 10 bytes, different meaning

    const stdout = search(home);

    assert.equal(readFileSync(hit).length, 10, "fixture must keep the length identical");
    assert.match(stdout, /Expected hit/, "hit still returned");
    assert.doesNotMatch(stdout, /STRONG/, `same-length rewrite must not be STRONG:\n${stdout}`);
    assert.match(stdout, /changed since it was indexed/, "the reason names the stale card");
  } finally { cleanup(); }
});

// A no-card hit (the graft/mnemosyne path returns no card) has nothing to
// verify against, and reading the file to find out is exactly what this layer
// exists to avoid. It stays WEAK and says why, rather than claiming a check it
// never performed.
shellTest("issue #13: a hit with no index card is WEAK and names the reason", () => {
  const { home, cleanup } = sandbox(); // no card written
  try {
    const stdout = search(home);

    assert.match(stdout, /Expected hit/, "hit still ranked and returned");
    assert.doesNotMatch(stdout, /STRONG/, `unverifiable hit must not be STRONG:\n${stdout}`);
    assert.match(stdout, /no index card for this path/, "the reason names the missing evidence");
    assert.doesNotMatch(stdout, /matched file content/, "must not claim a content check that never ran");
  } finally { cleanup(); }
});

// The ceiling of any stat-based check, pinned so it is a documented limit
// rather than an unknown one: a same-size rewrite that also restores mtime is
// indistinguishable without reading the file. The boundary is owned elsewhere
// by design — `heimdall verify --deep` re-hashes and reports the drift, and the
// reconciler's next pass re-indexes the file, rewriting the card and making
// search correct again. If this test ever starts failing because the verdict
// went to WEAK, query-time identity became content-based (that read is exactly
// what the layer avoids) and the ponytail comment in kb-search.sh needs
// updating with it.
shellTest("issue #13: known ceiling — same size plus restored mtime still reads STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    writeFileSync(hit, "ALLOWED=1\n");
    const mtime = statSync(hit).mtimeMs / 1000;
    writeCard(home, hit, { size: 10, mtime });
    writeFileSync(hit, "DELETED=1\n"); // same length
    utimesSync(hit, mtime, mtime); // ...and the same mtime

    const stdout = search(home);

    assert.equal(readFileSync(hit, "utf8"), "DELETED=1\n");
    assert.match(
      stdout,
      /\[STRONG\]/,
      `stat-based identity cannot see this rewrite; if it now reports WEAK the check became content-based and the ponytail comment in kb-search.sh must be updated:\n${stdout}`,
    );
  } finally { cleanup(); }
});

shellTest("issue #13: a card that agrees with the file on disk stays STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    writeCard(home, hit, { size: readFileSync(hit).length, mtime: Date.now() / 1000 });

    const stdout = search(home);

    assert.match(stdout, /\[STRONG\]/, `indexed-and-unchanged hit must be STRONG:\n${stdout}`);
    assert.doesNotMatch(stdout, /possibly_stale/, "a hit whose content matches the card is fresh");
  } finally { cleanup(); }
});

// The cheap check must STAY cheap: size already lives in the card, and the
// filesystem answers it, so the verdict pass never opens a hit file. An audit
// hook records every `open` in the worker process; a stat/getmtime is not an
// open, so a regression to readFileSync-style verification shows up here.
shellTest("issue #13: the verdict pass never opens the files it judges", () => {
  const { home, hit, cleanup } = sandbox();
  const hookDir = mkdtempSync(join(tmpdir(), "heimdall-audit-"));
  try {
    writeCard(home, hit, { size: readFileSync(hit).length, mtime: Date.now() / 1000 });
    const auditLog = join(hookDir, "opens.txt");
    writeFileSync(join(hookDir, "sitecustomize.py"), [
      "import sys, os",
      "_log = os.environ.get('AUDIT_LOG')",
      "if _log:",
      "    def _h(event, args):",
      "        if event == 'open':",
      "            try:",
      "                with open(_log, 'a') as f: f.write(str(args[0]) + '\\n')",
      "            except Exception: pass",
      "    sys.addaudithook(_h)",
      "",
    ].join("\n"));

    search(home, { PYTHONPATH: hookDir, AUDIT_LOG: auditLog });

    assert.ok(existsSync(auditLog), "audit hook did not run — the instrument is broken, not the code");
    const opens = readFileSync(auditLog, "utf8");
    assert.doesNotMatch(opens, /file\.py/, `verdict pass opened the hit file:\n${opens.split("\n").filter((l) => l.includes("file.py")).join("\n")}`);
  } finally {
    rmSync(hookDir, { recursive: true, force: true });
    cleanup();
  }
});
