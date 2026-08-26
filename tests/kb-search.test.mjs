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
