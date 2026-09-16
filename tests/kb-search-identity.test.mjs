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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  const drop = existsSync(db) ? 'con.execute("DROP TABLE IF EXISTS cards")' : "";
  // SQLite is dynamically typed: binding a non-numeric mtime (a string) stores
  // TEXT in a REAL NOT NULL column, which is how a legacy or hand-edited row
  // ends up carrying a value the freshness arithmetic cannot subtract.
  const insert = `con.execute('INSERT INTO cards VALUES ("1", ?, ?, ?, ?, "r", ?, ?)', (${JSON.stringify(path)}, ${JSON.stringify(title)}, ${JSON.stringify(body)}, "s1", ${JSON.stringify(mtime)}, ${size}))`;
  execFileSync("/usr/bin/python3", ["-c", [
    "import sqlite3,sys",
    `con = sqlite3.connect(${JSON.stringify(db)})`,
    drop,
    `con.execute(${JSON.stringify(CARDS_DDL)})`,
    insert,
    "con.commit()",
  ].filter(Boolean).join("; ")]);
  return db;
}

/** The card a real index pass would have written for this file, right now. */
const cardFor = (path) => {
  const st = statSync(path);
  return { size: st.size, mtime: st.mtimeMs / 1000 };
};

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

const search = (home, extra, query = "example") => execFileSync("bash", [KB_SEARCH, query], {
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

// A file OLDER than its card must not pass identity. `<=` on a signed
// difference accepts a downward skew of any size, which is reachable without
// utime: embed-index fast-paths on an exact mtime match, so an edit landing in
// the same coarse tick as the index pass keeps the old content hash forever.
// Backup restores and mtime-preserving editors land here too, and the freshness
// token two blocks below uses the opposite operator — so a hit could read
// `fresh` and `STRONG` while its mtime no longer equals the card at all.
shellTest("issue #13: a file older than its card is not STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    writeFileSync(hit, "ALLOWED=1\n");
    const cardMtime = Date.now() / 1000;
    writeCard(home, hit, { size: 10, mtime: cardMtime });
    writeFileSync(hit, "DELETED=1\n"); // same 10 bytes, opposite meaning
    utimesSync(hit, cardMtime - 0.5, cardMtime - 0.5); // older than the card

    const stdout = search(home);

    const line = stdout.split("\n").find((l) => l.includes("file.py")) ?? "";
    assert.doesNotMatch(line, /\[STRONG\]/, `a back-dated file must not be STRONG:\n${stdout}`);
    assert.doesNotMatch(line, /fresh/, "a file whose mtime no longer matches its card is not fresh");
  } finally { cleanup(); }
});

// A directory and a symlink are not "the content that was indexed". Both pass
// os.path.exists and os.stat (which follows links), so without explicit checks
// each inherits whatever verdict the path used to carry. The fixtures below
// deliberately give them matching size and mtime, so they cannot pass by
// accident — the only thing that can reject them is knowing what they are.
shellTest("issue #13: a hit path that is a directory or a symlink is not STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    // 1. the path became a directory, whose size and mtime are made to match
    rmSync(hit);
    mkdirSync(hit, { recursive: true });
    writeCard(home, hit, cardFor(hit));
    const asDir = search(home);
    assert.equal(statSync(hit).isDirectory(), true, "fixture must still be a directory");
    assert.doesNotMatch(
      asDir.split("\n").find((l) => l.includes("file.py")) ?? "",
      /\[STRONG\]/, `a directory is not indexed content:\n${asDir}`,
    );

    // 2. the path became a symlink to a different file of identical size and mtime
    rmSync(hit, { recursive: true, force: true });
    const elsewhere = join(home, "Repos", "example", "other.py");
    writeFileSync(elsewhere, "NOT=THIS\n"); // same 9 bytes as the indexed fake
    writeFileSync(hit, "NOT=THIS\n");
    const tgt = statSync(elsewhere);
    rmSync(hit);
    symlinkSync(elsewhere, hit);
    utimesSync(elsewhere, tgt.mtimeMs / 1000, tgt.mtimeMs / 1000);
    writeCard(home, hit, { size: tgt.size, mtime: tgt.mtimeMs / 1000 });
    const asLink = search(home);
    assert.equal(lstatSync(hit).isSymbolicLink(), true, "fixture must be a symlink");
    assert.doesNotMatch(
      asLink.split("\n").find((l) => l.includes("file.py")) ?? "",
      /\[STRONG\]/, `a symlink is not the indexed file, however well its target's stats line up:\n${asLink}`,
    );
  } finally { cleanup(); }
});

// The mnemosyne backend has its own verdict pass. A fix applied only to the
// graft pass leaves this one claiming STRONG on a path plus matching tokens,
// with no index card in existence — precisely what "verified" must exclude.
// It exits early (line ~91) before the card-based pass ever runs.
shellTest("issue #13: the mnemosyne verdict does not claim unverified STRONG", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-mnemo-verdict-"));
  try {
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const target = join(home, "deploy.py");
    writeFileSync(target, "ALLOW_DEPLOY = False\n");
    const mnemo = join(bin, "mnemosyne");
    // One memory whose prose claims the opposite of what the file says, and
    // whose content mentions the path — the exact shape that scores cov 100%.
    // The path must be HOME-anchored (~/...): the backend extracts only
    // home-anchored paths, and one that fails to resolve becomes NOPATH, which
    // would make this test pass without ever exercising the verdict rule.
    writeFileSync(mnemo, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' '{\"results\":[{\"id\":\"m1\",\"score\":0.9,\"content\":\"deploy policy ALLOW_DEPLOY True ~/deploy.py\"}]}'",
      "",
    ].join("\n"));
    chmodSync(mnemo, 0o755);

    const stdout = execFileSync("bash", [KB_SEARCH, "ALLOW_DEPLOY deploy policy"], {
      encoding: "utf8",
      env: runEnv(home, { HEIMDALL_BACKEND: "mnemosyne", MNEMOSYNE: undefined }),
    });

    assert.match(stdout, /deploy\.py/, "memory hit returned");
    assert.doesNotMatch(stdout, /NOPATH/, `the anchor must resolve, or this asserts nothing:\n${stdout}`);
    assert.match(stdout, /cov100%/, "the memory's prose contains the path and every query token");
    assert.doesNotMatch(
      stdout,
      /\[STRONG\]/,
      `mnemosyne has no index card to verify against, so nothing it returns can be STRONG:\n${stdout}`,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// How coverage works, so the two cases below are unambiguous: `cov` is measured
// over the TEXT OF THE HIT the backend returned (its title + snippet, with the
// path removed) — not over the card row. The card supplies identity; the hit
// supplies the text the query is matched against.
//
// The path is removed rather than merely excluded as a field because every
// producer embeds it in the hit body (`snippet [path]`), so a filename alone
// used to supply full coverage and read STRONG — the "agent acts without a
// round-trip on content that does not answer the question" failure.
shellTest("issue #13: a matching filename does not make unrelated content STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    // identity HOLDS: the card matches the file exactly, so only the coverage
    // half can save this hit. The query is chosen so every token exists ONLY in
    // the path portion of the hit body — the hit's own text is "example"
    // (tests/fixtures/fake-graft.sh). Including the path in `covered` therefore
    // made this cov100% and STRONG; excluding it, the hit's text shares nothing
    // with the query and it must fall to WEAK.
    writeCard(home, hit, cardFor(hit));

    const stdout = search(home, {}, "src py");

    assert.match(stdout, /file\.py/, "hit still returned (ranking is a different concern)");
    assert.doesNotMatch(
      stdout,
      /\[STRONG\]/,
      `identity holds but every matching token came from the path, none from the hit's text:\n${stdout}`,
    );
  } finally { cleanup(); }
});

// ...and the converse, so the rule is not "nothing can be STRONG": a hit whose
// own text covers the query, with identity intact, still passes.
shellTest("issue #13: a hit whose text matches the query still reaches STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    writeCard(home, hit, cardFor(hit));

    // The hit's own text is "example" (tests/fixtures/fake-graft.sh), so this
    // query is covered by content — not by the path.
    const stdout = search(home, {}, "example");

    assert.match(stdout, /\[STRONG\]/, `unchanged hit whose text matches must be STRONG:\n${stdout}`);
  } finally { cleanup(); }
});

// SQLite is dynamically typed, so one hand-edited or legacy row can hold a
// non-numeric mtime. Arithmetic on it raised inside the print loop and took the
// ENTIRE result set down with it — one bad row, zero results.
shellTest("issue #13: a malformed card row does not crash the search", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    writeCard(home, hit, { size: statSync(hit).size, mtime: "not-a-number" });

    const stdout = search(home); // throws if the worker exits non-zero

    assert.match(stdout, /Expected hit/, "the hit must still be reported");
    assert.doesNotMatch(stdout, /\[STRONG\]/, "a row that cannot be interpreted verifies nothing");
  } finally { cleanup(); }
});

// When the cards table cannot be read, no hit can be identity-checked. The
// caller must be able to tell that apart from "this path was never indexed":
// bin/lib/mcp-server.mjs returns stdout only and drops stderr, so a reason that
// only exists on stderr is invisible to an agent on the MCP path.
shellTest("issue #13: an unreadable index is named on stdout, not only stderr", () => {
  const { home, cleanup } = sandbox();
  try {
    // global.db exists but is not a database, so the cards read fails.
    mkdirSync(join(home, ".heimdall"), { recursive: true });
    writeFileSync(join(home, ".heimdall", "global.db"), "not a database");

    const stdout = execFileSync("bash", [KB_SEARCH, "example"], {
      encoding: "utf8",
      env: runEnv(home),
    });

    assert.match(stdout, /Expected hit/, "hits are still returned, just not trusted");
    assert.match(stdout, /INDEX_ERROR:/, `an unreadable index must be machine-readable on stdout:\n${stdout}`);
    assert.doesNotMatch(stdout, /\[STRONG\]/, "nothing can be verified without the index");
    assert.match(stdout, /index unreadable/, "the per-hit reason names the index, not the path");
  } finally { cleanup(); }
});

// Determinism is a property worth pinning, because a tolerance that is too
// tight would silently downgrade CORRECT hits (a false WEAK is as damaging to
// the contract as a false STRONG). The card is written from st_mtime and read
// back through SQLite's REAL, so assert the round trip is exact and that a
// freshly written file is STRONG on the first search — no window, no warm-up.
// Also asserts the reverse: a whole-second card (what a hand-written row looks
// like) against a fractional-mtime file is correctly NOT STRONG.
shellTest("issue #13: a freshly indexed, unchanged file is STRONG on the first search", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    // Card written the way embed-index.py writes it: straight from os.stat.
    writeCard(home, hit, cardFor(hit));

    const stdout = search(home, {}, "example");

    assert.match(stdout, /\[STRONG\]/, `no warm-up or retry should be needed:\n${stdout}`);
  } finally { cleanup(); }

  // And the mtime the card holds equals the file's mtime exactly, so
  // `abs(st_mtime - card) < 1e-6` is an equality test on a value that survives
  // the disk -> sqlite REAL -> disk round trip bit-for-bit.
  const { home: home2, hit: hit2, cleanup: cleanup2 } = sandbox();
  try {
    writeCard(home2, hit2, cardFor(hit2));
    const stored = Number(execFileSync("/usr/bin/python3", ["-c",
      `import sqlite3; print(repr(sqlite3.connect(${JSON.stringify(join(home2, ".heimdall", "global.db"))}).execute("SELECT mtime FROM cards").fetchone()[0]))`,
    ], { encoding: "utf8" }).trim());
    const onDisk = statSync(hit2).mtimeMs / 1000;
    assert.equal(
      stored,
      onDisk,
      "the stored mtime must be bit-identical to the file's, or correct hits would be downgraded",
    );
  } finally { cleanup2(); }
});

shellTest("issue #13: a card that agrees with the file on disk stays STRONG", () => {
  const { home, hit, cleanup } = sandbox();
  try {
    // a card from a real index pass, for the file exactly as written
    writeCard(home, hit, cardFor(hit));

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
    writeCard(home, hit, cardFor(hit));
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
