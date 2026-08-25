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
