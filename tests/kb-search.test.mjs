import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const shellTest = process.platform === "win32" ? test.skip : test;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

shellTest("kb-search passes the resolved graft path to its Python worker", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-kb-search-"));
  try {
    const graft = join(home, ".local", "bin", "graft");
    mkdirSync(dirname(graft), { recursive: true });
    copyFileSync(join(repoRoot, "tests", "fixtures", "fake-graft.sh"), graft);
    chmodSync(graft, 0o755);
    mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true });

    const stdout = execFileSync("bash", [join(repoRoot, "bin", "kb-search.sh"), "example"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined },
    });

    assert.match(stdout, /Expected hit/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("kb-search defaults to the graft backend with zero config", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-backend-default-"));
  try {
    const graft = join(home, ".local", "bin", "graft");
    mkdirSync(dirname(graft), { recursive: true });
    writeFileSync(graft, "#!/usr/bin/env bash\nprintf '%s\\n' '{\"hits\":[{\"pointer\":\"a.py:1\",\"title\":\"GraftRan\",\"score\":1,\"snippet\":\"s\"}]}'\n");
    chmodSync(graft, 0o755);
    mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true });

    const stdout = execFileSync("bash", [join(repoRoot, "bin", "kb-search.sh"), "example"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined, MNEMOSYNE: undefined, HEIMDALL_BACKEND: undefined },
    });

    assert.match(stdout, /GraftRan/);
    assert.doesNotMatch(stdout, /Mnemo hit/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("kb-search HEIMDALL_BACKEND=mnemosyne routes through recall --json", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-backend-mnemo-"));
  try {
    const mnemo = join(home, ".local", "bin", "mnemosyne");
    mkdirSync(dirname(mnemo), { recursive: true });
    copyFileSync(join(repoRoot, "tests", "fixtures", "fake-mnemosyne.sh"), mnemo);
    chmodSync(mnemo, 0o755);
    mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true }); // indexed repo present but must NOT be queried

    const stdout = execFileSync("bash", [join(repoRoot, "bin", "kb-search.sh"), "example"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", HEIMDALL_BACKEND: "mnemosyne", MNEMOSYNE: undefined },
    });

    assert.match(stdout, /Mnemo hit/);
    assert.doesNotMatch(stdout, /== retrieve \(per-repo graft/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

shellTest("kb-search mnemosyne backend missing binary exits 0 with guidance", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-backend-missing-"));
  try {
    const res = spawnSync("bash", [join(repoRoot, "bin", "kb-search.sh"), "example"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", HEIMDALL_BACKEND: "mnemosyne", MNEMOSYNE: undefined },
    });

    assert.equal(res.status, 0);
    assert.match(res.stdout + res.stderr, /mnemosyne/i);
    assert.match(res.stdout + res.stderr, /pip install|uv pip|install/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// F1 regression gate: a semantic hit with ZERO lexical corroboration must
// stay WEAK (not STRONG). A semantic hit with some corroboration upgrades.
shellTest("kb-search verdict gate: zero-coverage semantic hit stays WEAK", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-verdict-gate-"));
  try {
    const graft = join(home, ".local", "bin", "graft");
    mkdirSync(dirname(graft), { recursive: true });
    writeFileSync(graft, "#!/usr/bin/env bash\nprintf '%s\\n' '{\"hits\":[]}'\n");
    chmodSync(graft, 0o755);
    mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true });
    // The semantic hit points at an existing file whose name matches nothing.
    const semPath = join(home, "Repos", "example", "src", "unrelated.py");
    mkdirSync(dirname(semPath), { recursive: true });
    writeFileSync(semPath, "x");
    // Sandbox the semantic layer to our stub: fake venv python + global.db,
    // and put the stub where kb-search.sh looks for embed-index.py (script dir).
    const venvBin = join(home, ".heimdall", "venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    const stubPy = "#!/usr/bin/env bash\nexec /usr/bin/env python3 " +
      JSON.stringify(join(repoRoot, "tests", "fixtures", "fake-embed-index.py")) + " \"$@\"\n";
    writeFileSync(join(venvBin, "python3"), stubPy);
    chmodSync(join(venvBin, "python3"), 0o755);
    writeFileSync(join(home, ".heimdall", "global.db"), "");
    // Copy real bin/ next to nothing — instead point cwd at repo so the
    // script-dir guess finds the REAL embed-index; override it by placing
    // our stub FIRST on PATH is not enough (absolute path used). So we copy
    // the whole bin dir trick is heavy; simplest: run with cwd=repo but HOME
    // sandbox and FAKE_SEMANTIC_PATH pointing inside it. Real embed-index.py
    // exists → venv check fails first (no ~/.heimdall/venv in sandbox)…
    // …so we provide venv+db as above AND make script_dir/cwd findable stub:
    // the code prefers SCRIPT_DIR/embed-index.py which IS the real one, but
    // venv_py now resolves INSIDE $HOME sandbox to our stub wrapper. Good.

    const stdout = execFileSync("bash", [join(repoRoot, "bin", "kb-search.sh"), "zznomatchq"], {
      encoding: "utf8",
      env: {
        ...process.env, HOME: home, PATH: "/usr/bin:/bin",
        GRAFT: undefined, MNEMOSYNE: undefined, HEIMDALL_BACKEND: undefined,
        FAKE_SEMANTIC_PATH: semPath,
      },
    });

    assert.match(stdout, /\[WEAK\s*\]\s+cov00%/, "header shows WEAK + zero coverage");
    assert.match(stdout, /unrelated\.py/, "semantic hit path present");
    assert.doesNotMatch(stdout, /STRONG/, "never STRONG without lexical corroboration");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// P1 (zvec-grep port): a dead semantic leg must degrade LOUDLY and
// machine-readably — SEMANTIC_ERROR line on stdout, no raw tracebacks.
shellTest("kb-search dead semantic leg emits SEMANTIC_ERROR with reason", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-sem-dead-"));
  try {
    const graft = join(home, ".local", "bin", "graft");
    mkdirSync(dirname(graft), { recursive: true });
    writeFileSync(graft, "#!/usr/bin/env bash\nprintf '%s\\n' '{\"hits\":[{\"pointer\":\"a.py:1\",\"title\":\"GraftOnly\",\"score\":1,\"snippet\":\"s\"}]}'\n");
    chmodSync(graft, 0o755);
    mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true });
    // Fake venv python whose embed-index query exits non-zero with an error.
    const venvBin = join(home, ".heimdall", "venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    const failingPy = "#!/usr/bin/env bash\necho 'boom: simulated dim mismatch' >&2\nexit 3\n";
    writeFileSync(join(venvBin, "python3"), failingPy);
    chmodSync(join(venvBin, "python3"), 0o755);
    writeFileSync(join(home, ".heimdall", "global.db"), "");

    const stdout = execFileSync("bash", [join(repoRoot, "bin", "kb-search.sh"), "example"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined, MNEMOSYNE: undefined, HEIMDALL_BACKEND: undefined },
    });

    assert.match(stdout, /SEMANTIC_ERROR:/, "machine-readable degradation marker present");
    assert.match(stdout, /LEXICAL-ONLY/, "caller told results are lexical-only");
    assert.match(stdout, /GraftOnly/, "lexical hits still served");
    assert.doesNotMatch(stdout, /Traceback/, "no raw traceback in output");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// P2 (zvec-grep port): freshness tokens — final hits carry as_of=<age>
// plus fresh/possibly_stale, anchored to the indexed snapshot mtime.
shellTest("kb-search hits carry freshness as_of + fresh/possibly_stale", () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-freshness-"));
  try {
    const graft = join(home, ".local", "bin", "graft");
    mkdirSync(dirname(graft), { recursive: true });
    writeFileSync(graft, "#!/usr/bin/env bash\nprintf '%s\\n' '{\"hits\":[{\"pointer\":\"a.py:1\",\"title\":\"FreshHit\",\"score\":1,\"snippet\":\"s\"}]}'\n");
    chmodSync(graft, 0o755);
    const repo = join(home, "Repos", "example");
    mkdirSync(join(repo, "graft"), { recursive: true });
    // The searched file must exist (for the freshness mtime comparison).
    writeFileSync(join(repo, "a.py"), "print('indexed payload')\n");
    // Real sqlite db with a cards row whose mtime LAGS the file's mtime
    // (simulate an index built 10 days ago).
    const old = Math.floor(Date.now() / 1000) - 10 * 86400;
    const db = join(home, ".heimdall", "global.db");
    mkdirSync(dirname(db), { recursive: true });
    execFileSync("/usr/bin/python3", ["-c", [
      "import sqlite3,sys",
      `con = sqlite3.connect(${JSON.stringify(db)})`,
      "con.execute('CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha1 TEXT NOT NULL, root TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL)')",
      `con.execute('INSERT INTO cards VALUES (\"1\", ?, \"FreshHit\", \"body\", \"s1\", \"r\", ?, 100)', (${JSON.stringify(join(repo, "a.py"))}, ${old}))`,
      "con.commit()",
    ].join("; ")]);

    const stdout = execFileSync("bash", [join(repoRoot, "bin", "kb-search.sh"), "example"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", GRAFT: undefined, MNEMOSYNE: undefined, HEIMDALL_BACKEND: undefined },
    });

    assert.match(stdout, /FreshHit/, "hit present");
    assert.match(stdout, /as_of=[\d.]+[hd]/, "as_of age token present");
    assert.match(stdout, /possibly_stale/, "10-day-lagged card reported stale");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
