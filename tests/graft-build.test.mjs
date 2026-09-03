// graft-build — tests for probeGraftd, findWorkingGraftd, toolchainStatus,
// accelCmakeFlags, buildPaths, buildGraftd, installGraftd, ensureGraftd.
// All tests use temp HOME dirs and fake shell scripts. No network, no real cmake.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
// Dynamic import so we can test BEFORE the file exists (import error = test fail, which is correct)
const GB = await import("../bin/lib/graft-build.mjs");
const {
  probeGraftd, findWorkingGraftd, toolchainStatus, accelCmakeFlags,
  buildPaths, buildGraftd, installGraftd, ensureGraftd,
} = GB;

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), "heimdall-gb-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// Write a fake graftd shell script that exits 0 and prints model_path.
function makeFakeGraftd(dir, name, { exitCode = 0, output = "model_path: /nonexistent/probe.gguf\nhardware_accel: false\n" } = {}) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho '${output.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`);
  chmodSync(p, 0o755);
  return p;
}

// Build a stripped PATH with only node in it.
function strippedEnv(home) {
  // Create a bin dir with only a node symlink
  const binDir = join(home, "stripped-bin");
  mkdirSync(binDir, { recursive: true });
  return { ...process.env, HOME: home, PATH: binDir };
}

// Make a temp dir with a probe config file (for writeProbeConfig equivalent)
async function makeProbeConfig(home) {
  const { writeProbeConfig } = await import("../bin/lib/setup.mjs");
  return writeProbeConfig(home);
}

// ---------------------------------------------------------------------------
// probeGraftd
// ---------------------------------------------------------------------------
test("probeGraftd: ok=true when script exits 0 and stdout has model_path", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const bin = makeFakeGraftd(home, "graftd");
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await probeGraftd(bin, { configPath });
      assert.equal(r.ok, true, `ok false: ${JSON.stringify(r)}`);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /model_path:/);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("probeGraftd: ok=false when script exits 1 (broken binary)", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const bin = makeFakeGraftd(home, "graftd-broken", { exitCode: 1 });
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await probeGraftd(bin, { configPath });
      assert.equal(r.ok, false);
      assert.notEqual(r.code, 0);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("probeGraftd: ok=false when binary is missing (ENOENT)", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await probeGraftd(join(home, "nonexistent-graftd"), { configPath });
      assert.equal(r.ok, false);
      assert.ok(r.error != null || r.code !== 0, "should report error or non-zero code");
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("probeGraftd: never throws even on weird input", async () => {
  const r = await probeGraftd("/dev/null", { configPath: "/no/such/config.yaml" });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// findWorkingGraftd
// ---------------------------------------------------------------------------
test("findWorkingGraftd: picks first working of [broken, working]", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const broken = makeFakeGraftd(home, "graftd-broken", { exitCode: 1 });
    const working = makeFakeGraftd(home, "graftd-ok");
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const found = await findWorkingGraftd({ candidates: [broken, working], configPath });
      assert.equal(found, working);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("findWorkingGraftd: returns null when no candidate works", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const broken1 = makeFakeGraftd(home, "graftd-b1", { exitCode: 1 });
    const broken2 = makeFakeGraftd(home, "graftd-b2", { exitCode: 2 });
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const found = await findWorkingGraftd({ candidates: [broken1, broken2], configPath });
      assert.equal(found, null);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// toolchainStatus
// ---------------------------------------------------------------------------
test("toolchainStatus: reports missing tools on stripped PATH", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const binDir = join(home, "empty-bin");
    mkdirSync(binDir, { recursive: true });
    const env = { ...process.env, HOME: home, PATH: binDir };
    const s = await toolchainStatus({ env });
    assert.equal(s.cmake, null, "cmake should be missing");
    assert.equal(s.compiler, null, "compiler should be missing");
    assert.equal(s.git, null, "git should be missing");
    assert.equal(s.ok, false);
  } finally {
    cleanup();
  }
});

test("toolchainStatus: finds real tools on real PATH", async () => {
  // Just verify it doesn't throw and returns the right shape
  const s = await toolchainStatus({ env: process.env });
  assert.ok(typeof s.ok === "boolean");
  assert.ok(s.cmake === null || typeof s.cmake === "string");
  assert.ok(s.compiler === null || typeof s.compiler === "string");
  assert.ok(s.git === null || typeof s.git === "string");
});

// ---------------------------------------------------------------------------
// accelCmakeFlags
// ---------------------------------------------------------------------------
test("accelCmakeFlags: metal → []", () => {
  assert.deepEqual(accelCmakeFlags("metal"), []);
});

test("accelCmakeFlags: cuda → [-DGGML_CUDA=ON]", () => {
  assert.deepEqual(accelCmakeFlags("cuda"), ["-DGGML_CUDA=ON"]);
});

test("accelCmakeFlags: cpu → both OFF flags", () => {
  const flags = accelCmakeFlags("cpu");
  assert.ok(flags.includes("-DGGML_METAL=OFF"), "METAL=OFF");
  assert.ok(flags.includes("-DGGML_CUDA=OFF"), "CUDA=OFF");
});

test("accelCmakeFlags: unknown → both OFF flags (same as cpu)", () => {
  const flags = accelCmakeFlags("unknown");
  assert.ok(flags.includes("-DGGML_METAL=OFF"), "METAL=OFF");
  assert.ok(flags.includes("-DGGML_CUDA=OFF"), "CUDA=OFF");
});

// ---------------------------------------------------------------------------
// buildPaths
// ---------------------------------------------------------------------------
test("buildPaths: dev checkout (has .git) → buildDir inside vendor", () => {
  const { home, cleanup } = tmpHome();
  try {
    // repo root has .git
    const paths = buildPaths({ pkgRoot: repo, home, env: {} });
    assert.equal(paths.sourceDir, join(repo, "vendor", "graft"));
    assert.equal(paths.buildDir, join(repo, "vendor", "graft", "build"));
    assert.equal(paths.llamaSourceDir, null);
  } finally {
    cleanup();
  }
});

test("buildPaths: installed package (no .git) → buildDir in ~/.heimdall", () => {
  const { home, cleanup } = tmpHome();
  try {
    // Use home as a fake pkg root without .git
    const fakePkg = join(home, "fakepkg");
    mkdirSync(fakePkg, { recursive: true });
    const paths = buildPaths({ pkgRoot: fakePkg, home, env: {} });
    assert.equal(paths.sourceDir, join(fakePkg, "vendor", "graft"));
    assert.equal(paths.buildDir, join(home, ".heimdall", "build", "graft"));
    assert.equal(paths.llamaSourceDir, join(home, ".heimdall", "build", "llama.cpp"));
  } finally {
    cleanup();
  }
});

test("buildPaths: env overrides HEIMDALL_BUILD_DIR and HEIMDALL_LLAMA_SRC", () => {
  const { home, cleanup } = tmpHome();
  try {
    const fakePkg = join(home, "fakepkg");
    mkdirSync(fakePkg, { recursive: true });
    const overrideBuildDir = join(home, "custom-build");
    const overrideLlama = join(home, "custom-llama");
    const env = {
      HEIMDALL_BUILD_DIR: overrideBuildDir,
      HEIMDALL_LLAMA_SRC: overrideLlama,
    };
    const paths = buildPaths({ pkgRoot: fakePkg, home, env });
    assert.equal(paths.buildDir, overrideBuildDir);
    assert.equal(paths.llamaSourceDir, overrideLlama);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// buildGraftd
// ---------------------------------------------------------------------------
test("buildGraftd: reason=toolchain without cmake on PATH", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const binDir = join(home, "empty-bin");
    mkdirSync(binDir, { recursive: true });
    const env = { ...process.env, HOME: home, PATH: binDir };
    const logFile = join(home, "build.log");
    const r = await buildGraftd({
      sourceDir: join(home, "src"),
      buildDir: join(home, "build"),
      llamaSourceDir: null,
      accel: "cpu",
      jobs: 1,
      timeoutMs: 5000,
      logFile,
      env,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "toolchain");
    assert.equal(r.logFile, logFile);
  } finally {
    cleanup();
  }
});

test("buildGraftd: reason=configure when cmake exits 1", async () => {
  const { home, cleanup } = tmpHome();
  try {
    // Create a fake cmake that exits 1
    const binDir = join(home, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCmake = join(binDir, "cmake");
    writeFileSync(fakeCmake, "#!/bin/sh\necho 'cmake error' >&2\nexit 1\n");
    chmodSync(fakeCmake, 0o755);
    // Also add fake compiler and git
    for (const tool of ["c++", "git"]) {
      const t = join(binDir, tool);
      writeFileSync(t, "#!/bin/sh\necho 'ok'\nexit 0\n");
      chmodSync(t, 0o755);
    }
    const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` };
    const logFile = join(home, "build.log");
    const r = await buildGraftd({
      sourceDir: join(home, "src"),
      buildDir: join(home, "build"),
      llamaSourceDir: null,
      accel: "cpu",
      jobs: 1,
      timeoutMs: 5000,
      logFile,
      env,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "configure");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// installGraftd
// ---------------------------------------------------------------------------
test("installGraftd: installs working binary, creates backup of existing", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const destDir = join(home, ".local", "bin");
    mkdirSync(destDir, { recursive: true });
    // Create an existing (broken) binary at dest
    const destBin = join(destDir, "graftd");
    const brokenScript = "#!/bin/sh\nexit 1\n";
    writeFileSync(destBin, brokenScript);
    chmodSync(destBin, 0o755);

    // Source binary is working
    const srcBin = makeFakeGraftd(home, "graftd-src");
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await installGraftd({ srcBin, destBin, configPath });
      assert.equal(r.ok, true, `install failed: ${JSON.stringify(r)}`);
      assert.equal(r.destBin, destBin);
      assert.ok(r.backup != null, "backup should be set");
      assert.ok(existsSync(r.backup), `backup file ${r.backup} should exist`);
      // Installed file should be the working one
      assert.ok(existsSync(destBin));
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("installGraftd: restores backup when probe fails after copy", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const destDir = join(home, ".local", "bin");
    mkdirSync(destDir, { recursive: true });

    // Original dest: a working binary (so the backup is worth restoring)
    const destBin = join(destDir, "graftd");
    const workingScript = "#!/bin/sh\necho 'model_path: /orig.gguf'\nexit 0\n";
    writeFileSync(destBin, workingScript);
    chmodSync(destBin, 0o755);

    // Source binary is broken (probe will fail after copy)
    const srcBin = makeFakeGraftd(home, "graftd-bad", { exitCode: 1 });
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await installGraftd({ srcBin, destBin, configPath });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "probe");
      // Backup should be restored
      assert.ok(existsSync(destBin), "original binary should be restored");
      const content = readFileSync(destBin, "utf8");
      assert.ok(content.includes("model_path:"), "restored binary should be the working original");
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ensureGraftd
// ---------------------------------------------------------------------------
test("ensureGraftd: returns source=existing without building when working binary present", async () => {
  const { home, cleanup } = tmpHome();
  try {
    // Install a working graftd at ~/.local/bin/graftd
    const destDir = join(home, ".local", "bin");
    mkdirSync(destDir, { recursive: true });
    const destBin = join(destDir, "graftd");
    makeFakeGraftd(destDir, "graftd");

    // Use stripped PATH so no toolchain is available
    const binDir = join(home, "empty-bin");
    mkdirSync(binDir, { recursive: true });
    const env = { ...process.env, HOME: home, PATH: binDir };
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await ensureGraftd({
        configPath,
        accel: "cpu",
        allowBuild: true,
        log: () => {},
        env,
        home,
        pkgRoot: repo,
      });
      assert.equal(r.ok, true, `ensureGraftd failed: ${JSON.stringify(r)}`);
      assert.equal(r.source, "existing");
      assert.equal(r.path, destBin);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("ensureGraftd: message starts with SETUP NEEDED when no toolchain and no working binary", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const binDir = join(home, "empty-bin");
    mkdirSync(binDir, { recursive: true });
    // Point HEIMDALL_BUILD_DIR to an empty temp dir so the checkout's vendor binary is never probed.
    const emptyBuildDir = join(home, "empty-build");
    mkdirSync(emptyBuildDir, { recursive: true });
    const env = { ...process.env, HOME: home, PATH: binDir, HEIMDALL_BUILD_DIR: emptyBuildDir };
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await ensureGraftd({
        configPath,
        accel: "cpu",
        allowBuild: true,
        log: () => {},
        env,
        home,
        pkgRoot: repo,
      });
      assert.equal(r.ok, false);
      assert.ok(r.message.startsWith("SETUP NEEDED"), `message: ${r.message}`);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("ensureGraftd: ok=false with message when allowBuild=false and no working binary", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await ensureGraftd({
        configPath,
        accel: "cpu",
        allowBuild: false,
        log: () => {},
        env: process.env,
        home,
        pkgRoot: repo,
      });
      // If no working binary found on this machine, should fail with SETUP NEEDED
      if (!r.ok) {
        assert.ok(r.message.startsWith("SETUP NEEDED"), `message should start with SETUP NEEDED: ${r.message}`);
      }
      // If a working binary is found (canonical or another candidate), it should
      // succeed with source "existing" or "installed" (install-from-candidate
      // is not a build, so it is permitted even when allowBuild=false).
      if (r.ok) {
        assert.ok(
          r.source === "existing" || r.source === "installed",
          `source should be 'existing' or 'installed' when ok, got: ${r.source}`,
        );
      }
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// defaultCandidates isolation tests
// ---------------------------------------------------------------------------
test("default candidates follow HEIMDALL_BUILD_DIR: candidate[1] uses env override", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const tmpBuildDir = join(home, "custom-build");
    mkdirSync(tmpBuildDir, { recursive: true });
    const env = { HEIMDALL_BUILD_DIR: tmpBuildDir };
    // Use a fake pkgRoot (not a dev checkout) to avoid .git-based override
    const fakePkg = join(home, "fakepkg");
    mkdirSync(fakePkg, { recursive: true });
    // Call findWorkingGraftd with an explicit no-candidates (impossible path) to
    // indirectly validate candidate generation via buildPaths.
    const { buildPaths } = GB;
    const paths = buildPaths({ pkgRoot: fakePkg, home, env });
    assert.equal(paths.buildDir, tmpBuildDir, "buildDir should be overridden by HEIMDALL_BUILD_DIR");
    // Also verify buildDir is the actual custom dir not the vendor dir
    assert.notEqual(paths.buildDir, join(repo, "vendor", "graft", "build"));
  } finally {
    cleanup();
  }
});

test("default candidates follow HEIMDALL_BUILD_DIR: dev pkgRoot without override uses vendor/graft/build", async () => {
  const { home, cleanup } = tmpHome();
  try {
    // repo is a dev checkout (.git exists), no HEIMDALL_BUILD_DIR override
    const { buildPaths: bp } = GB;
    const paths = bp({ pkgRoot: repo, home, env: {} });
    assert.equal(paths.buildDir, join(repo, "vendor", "graft", "build"),
      "dev checkout without override should use vendor/graft/build");
  } finally {
    cleanup();
  }
});

test("findWorkingGraftd returns HEIMDALL_BUILD_DIR/graftd when ~/.local/bin/graftd is absent", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const tmpBuildDir = join(home, "custom-build");
    mkdirSync(tmpBuildDir, { recursive: true });
    // Place a fake working graftd in the custom build dir
    makeFakeGraftd(tmpBuildDir, "graftd");
    const env = { HEIMDALL_BUILD_DIR: tmpBuildDir };
    // Use a fakePkg so isDev=false and buildPaths uses the env override
    const fakePkg = join(home, "fakepkg");
    mkdirSync(fakePkg, { recursive: true });
    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const found = await findWorkingGraftd({ home, env, pkgRoot: fakePkg, configPath });
      assert.equal(found, join(tmpBuildDir, "graftd"),
        `expected ${join(tmpBuildDir, "graftd")} but got ${found}`);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FIX 3: probeGraftd must short-circuit when configPath is falsy
// ---------------------------------------------------------------------------
test("probeGraftd: ok=false with 'configPath required' error when configPath is omitted", () => {
  // Call with no configPath at all — must return immediately without spawning
  const r = probeGraftd("/some/path/graftd");
  assert.equal(r.ok, false);
  assert.equal(r.error, "configPath required");
  assert.equal(r.code, null);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

// ---------------------------------------------------------------------------
// FIX 1: ensureGraftd canonical-first install semantics
// ---------------------------------------------------------------------------
test("ensureGraftd: canonical broken + build-dir working → source=installed, path=canonical, .bak exists, no build attempted", async () => {
  const { home, cleanup } = tmpHome();
  try {
    // Broken canonical at ~/.local/bin/graftd
    const canonicalDir = join(home, ".local", "bin");
    mkdirSync(canonicalDir, { recursive: true });
    const canonical = join(canonicalDir, "graftd");
    writeFileSync(canonical, "#!/bin/sh\nexit 1\n");
    chmodSync(canonical, 0o755);

    // Working binary in build dir
    const buildDir = join(home, "fake-build");
    mkdirSync(buildDir, { recursive: true });
    makeFakeGraftd(buildDir, "graftd");

    // Stripped PATH — if a build were attempted it would fail (no cmake/compiler/git)
    const emptyBin = join(home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const env = { ...process.env, HOME: home, PATH: emptyBin, HEIMDALL_BUILD_DIR: buildDir };

    const fakePkg = join(home, "fakepkg");
    mkdirSync(fakePkg, { recursive: true });

    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await ensureGraftd({
        configPath,
        accel: "cpu",
        allowBuild: true,
        log: () => {},
        env,
        home,
        pkgRoot: fakePkg,
      });
      assert.equal(r.ok, true, `ensureGraftd failed: ${JSON.stringify(r)}`);
      assert.equal(r.source, "installed");
      assert.equal(r.path, canonical);

      // Canonical must now pass probe
      const probe = probeGraftd(canonical, { configPath });
      assert.equal(probe.ok, true, `canonical probe failed after install: ${JSON.stringify(probe)}`);

      // A .bak file must exist (the broken canonical was backed up)
      const files = readdirSync(canonicalDir);
      const bak = files.find((f) => f.startsWith("graftd.bak-"));
      assert.ok(bak != null, `no graftd.bak-* found in ${canonicalDir}: [${files.join(", ")}]`);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("ensureGraftd: canonical missing + build-dir working → source=installed, no .bak file", async () => {
  const { home, cleanup } = tmpHome();
  try {
    // No canonical installed at all; pre-create the dir so readdirSync works
    const canonicalDir = join(home, ".local", "bin");
    mkdirSync(canonicalDir, { recursive: true });
    const canonical = join(canonicalDir, "graftd");

    // Working binary in build dir
    const buildDir = join(home, "fake-build");
    mkdirSync(buildDir, { recursive: true });
    makeFakeGraftd(buildDir, "graftd");

    const emptyBin = join(home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const env = { ...process.env, HOME: home, PATH: emptyBin, HEIMDALL_BUILD_DIR: buildDir };

    const fakePkg = join(home, "fakepkg");
    mkdirSync(fakePkg, { recursive: true });

    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await ensureGraftd({
        configPath,
        accel: "cpu",
        allowBuild: true,
        log: () => {},
        env,
        home,
        pkgRoot: fakePkg,
      });
      assert.equal(r.ok, true, `ensureGraftd failed: ${JSON.stringify(r)}`);
      assert.equal(r.source, "installed");
      assert.equal(r.path, canonical);

      // No .bak file because canonical did not exist before
      const files = readdirSync(canonicalDir);
      const bak = files.find((f) => f.startsWith("graftd.bak-"));
      assert.equal(bak, undefined, `unexpected .bak file: ${bak}`);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});

test("ensureGraftd: canonical working → source=existing even if build-dir also works (no copy, no .bak)", async () => {
  const { home, cleanup } = tmpHome();
  try {
    // Working canonical
    const canonicalDir = join(home, ".local", "bin");
    mkdirSync(canonicalDir, { recursive: true });
    const canonical = join(canonicalDir, "graftd");
    makeFakeGraftd(canonicalDir, "graftd");

    // Also working binary in build dir — must NOT be used
    const buildDir = join(home, "fake-build");
    mkdirSync(buildDir, { recursive: true });
    makeFakeGraftd(buildDir, "graftd");

    const emptyBin = join(home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const env = { ...process.env, HOME: home, PATH: emptyBin, HEIMDALL_BUILD_DIR: buildDir };

    const fakePkg = join(home, "fakepkg");
    mkdirSync(fakePkg, { recursive: true });

    const { configPath, cleanup: cleanCfg } = await makeProbeConfig(home);
    try {
      const r = await ensureGraftd({
        configPath,
        accel: "cpu",
        allowBuild: true,
        log: () => {},
        env,
        home,
        pkgRoot: fakePkg,
      });
      assert.equal(r.ok, true, `ensureGraftd failed: ${JSON.stringify(r)}`);
      assert.equal(r.source, "existing");
      assert.equal(r.path, canonical);

      // No .bak file — no install attempted
      const files = readdirSync(canonicalDir);
      const bak = files.find((f) => f.startsWith("graftd.bak-"));
      assert.equal(bak, undefined, `unexpected .bak file: ${bak}`);
    } finally {
      cleanCfg();
    }
  } finally {
    cleanup();
  }
});
