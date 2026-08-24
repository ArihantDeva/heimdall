import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
