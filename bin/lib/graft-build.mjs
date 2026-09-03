// graft-build.mjs — build/probe/install the graftd C++ daemon.
// ESM, node built-ins only. Must NOT import setup.mjs (setup.mjs imports this).
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, copyFileSync, renameSync, chmodSync,
  unlinkSync, openSync, appendFileSync, writeSync, closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Package root = two levels up from bin/lib/
const HERE = dirname(fileURLToPath(import.meta.url)); // bin/lib
const PKG_ROOT = dirname(dirname(HERE));               // repo root

// ---------------------------------------------------------------------------
// probeGraftd
// ---------------------------------------------------------------------------
// Returns { ok, code, stdout, stderr, error }. Never throws.
export function probeGraftd(binPath, { configPath, timeoutMs = 15000 } = {}) {
  if (!configPath) {
    return { ok: false, code: null, stdout: "", stderr: "", error: "configPath required" };
  }
  try {
    if (!existsSync(binPath)) {
      return { ok: false, code: null, stdout: "", stderr: "", error: `ENOENT: ${binPath}` };
    }
    const r = spawnSync(binPath, ["--check-config", configPath], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    const code = r.status;
    const error = r.error ? String(r.error) : null;
    const ok = (code === 0) && !r.error && /model_path:/.test(stdout);
    return { ok, code, stdout, stderr, error };
  } catch (e) {
    return { ok: false, code: null, stdout: "", stderr: "", error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// findWorkingGraftd
// ---------------------------------------------------------------------------
// Returns first candidate path whose probe is ok, else null.
export async function findWorkingGraftd({ candidates, configPath, home, env, pkgRoot } = {}) {
  const list = candidates ?? defaultCandidates({ home, env, pkgRoot });
  for (const c of list) {
    const r = probeGraftd(c, { configPath });
    if (r.ok) return c;
  }
  return null;
}

function defaultCandidates({ home, env, pkgRoot } = {}) {
  const h = home ?? os.homedir();
  const resolvedEnv = env ?? {};
  const { buildDir } = buildPaths({ pkgRoot: pkgRoot ?? PKG_ROOT, home: h, env: resolvedEnv });
  return [
    join(h, ".local", "bin", "graftd"),
    join(buildDir, "graftd"),
    join(h, "Repos", "graft-cpp", "build", "graftd"),
  ];
}

// ---------------------------------------------------------------------------
// toolchainStatus
// ---------------------------------------------------------------------------
// Returns { cmake, compiler, git, ok }. Paths are absolute strings or null.
export function toolchainStatus({ env = process.env } = {}) {
  const cmake = findOnPath("cmake", env);
  const compilerNames = ["c++", "g++", "clang++", "cc", "gcc", "clang"];
  let compiler = null;
  for (const name of compilerNames) {
    const found = findOnPath(name, env);
    if (found) { compiler = found; break; }
  }
  const git = findOnPath("git", env);
  const ok = !!(cmake && compiler && git);
  return { cmake, compiler, git, ok };
}

function findOnPath(name, env) {
  const PATH = env.PATH ?? "";
  const dirs = PATH.split(":");
  for (const dir of dirs) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// accelCmakeFlags
// ---------------------------------------------------------------------------
export function accelCmakeFlags(accel) {
  if (accel === "metal") return [];
  if (accel === "cuda") return ["-DGGML_CUDA=ON"];
  return ["-DGGML_METAL=OFF", "-DGGML_CUDA=OFF"];
}

// ---------------------------------------------------------------------------
// buildPaths
// ---------------------------------------------------------------------------
export function buildPaths({ pkgRoot = PKG_ROOT, home = os.homedir(), env = {} } = {}) {
  const sourceDir = join(pkgRoot, "vendor", "graft");
  const isDev = existsSync(join(pkgRoot, ".git"));
  let buildDir, llamaSourceDir;
  if (isDev) {
    buildDir = join(pkgRoot, "vendor", "graft", "build");
    llamaSourceDir = null;
  } else {
    buildDir = join(home, ".heimdall", "build", "graft");
    llamaSourceDir = join(home, ".heimdall", "build", "llama.cpp");
  }
  if (env.HEIMDALL_BUILD_DIR) buildDir = env.HEIMDALL_BUILD_DIR;
  if (env.HEIMDALL_LLAMA_SRC) llamaSourceDir = env.HEIMDALL_LLAMA_SRC;
  return { sourceDir, buildDir, llamaSourceDir };
}

// ---------------------------------------------------------------------------
// buildGraftd
// ---------------------------------------------------------------------------
export function buildGraftd({
  sourceDir,
  buildDir,
  llamaSourceDir,
  accel = "cpu",
  jobs,
  timeoutMs,
  logFile,
  env = process.env,
} = {}) {
  const t0 = Date.now();
  const home = env.HOME ?? os.homedir();
  const resolvedLogFile = logFile ?? join(home, ".heimdall", "bootstrap.log");
  const resolvedTimeoutMs = timeoutMs ??
    (env.HEIMDALL_BUILD_TIMEOUT_MS ? parseInt(env.HEIMDALL_BUILD_TIMEOUT_MS, 10) : 1_800_000);
  const defaultJobs = Math.min(
    env.HEIMDALL_BUILD_JOBS ? parseInt(env.HEIMDALL_BUILD_JOBS, 10) : os.availableParallelism?.() ?? 4,
    4,
  );
  const resolvedJobs = jobs ?? defaultJobs;

  try {
    // Check toolchain
    const tc = toolchainStatus({ env });
    if (!tc.ok) {
      return {
        ok: false,
        binPath: null,
        graftCliPath: null,
        elapsedMs: Date.now() - t0,
        reason: "toolchain",
        logFile: resolvedLogFile,
      };
    }

    // Ensure log dir exists
    try { mkdirSync(dirname(resolvedLogFile), { recursive: true }); } catch { /* best effort */ }

    // Helper to append to log
    const appendLog = (text) => {
      try { appendFileSync(resolvedLogFile, text); } catch { /* best effort */ }
    };

    // Configure step
    const configureArgs = [
      "-S", sourceDir,
      "-B", buildDir,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DGRAFT_BUILD_TESTS=OFF",
    ];
    if (llamaSourceDir) {
      configureArgs.push(`-DGRAFT_LLAMA_CPP_SOURCE_DIR=${llamaSourceDir}`);
    }
    configureArgs.push(...accelCmakeFlags(accel));

    const timeoutLeft1 = resolvedTimeoutMs - (Date.now() - t0);
    if (timeoutLeft1 <= 0) {
      return { ok: false, binPath: null, graftCliPath: null, elapsedMs: Date.now() - t0, reason: "timeout", logFile: resolvedLogFile };
    }

    appendLog(`\n[heimdall] cmake configure: cmake ${configureArgs.join(" ")}\n`);
    const cfg = spawnSync(tc.cmake, configureArgs, {
      encoding: "utf8",
      timeout: timeoutLeft1,
      env,
    });
    appendLog(cfg.stdout ?? "");
    appendLog(cfg.stderr ?? "");
    if (cfg.error) appendLog(`error: ${cfg.error}\n`);

    if (cfg.status !== 0 || cfg.error) {
      return { ok: false, binPath: null, graftCliPath: null, elapsedMs: Date.now() - t0, reason: "configure", logFile: resolvedLogFile };
    }

    // Build step
    const timeoutLeft2 = resolvedTimeoutMs - (Date.now() - t0);
    if (timeoutLeft2 <= 0) {
      return { ok: false, binPath: null, graftCliPath: null, elapsedMs: Date.now() - t0, reason: "timeout", logFile: resolvedLogFile };
    }
    const buildArgs = ["--build", buildDir, "--target", "graftd", "graft", "--parallel", String(resolvedJobs)];
    appendLog(`[heimdall] cmake build: cmake ${buildArgs.join(" ")}\n`);
    const bld = spawnSync(tc.cmake, buildArgs, {
      encoding: "utf8",
      timeout: timeoutLeft2,
      env,
    });
    appendLog(bld.stdout ?? "");
    appendLog(bld.stderr ?? "");
    if (bld.error) appendLog(`error: ${bld.error}\n`);

    if (bld.status !== 0 || bld.error) {
      return { ok: false, binPath: null, graftCliPath: null, elapsedMs: Date.now() - t0, reason: "build", logFile: resolvedLogFile };
    }

    const binPath = join(buildDir, "graftd");
    const graftCliPath = join(buildDir, "graft");
    return { ok: true, binPath, graftCliPath, elapsedMs: Date.now() - t0, reason: null, logFile: resolvedLogFile };
  } catch (e) {
    return { ok: false, binPath: null, graftCliPath: null, elapsedMs: Date.now() - t0, reason: "build", logFile: resolvedLogFile };
  }
}

// ---------------------------------------------------------------------------
// installGraftd
// ---------------------------------------------------------------------------
// Returns { ok, destBin, backup, reason }. Never throws.
export function installGraftd({ srcBin, destBin, configPath } = {}) {
  let backup = null;
  try {
    const destDir = dirname(destBin);
    mkdirSync(destDir, { recursive: true });

    // Backup existing
    if (existsSync(destBin)) {
      backup = `${destBin}.bak-${Date.now()}`;
      renameSync(destBin, backup);
    }

    // Copy to temp then atomic rename
    const tmpDest = join(destDir, `.graftd-install-${Date.now()}`);
    copyFileSync(srcBin, tmpDest);
    chmodSync(tmpDest, 0o755);
    renameSync(tmpDest, destBin);

    // Probe
    const r = probeGraftd(destBin, { configPath });
    if (!r.ok) {
      // Remove new file and restore backup
      try { unlinkSync(destBin); } catch { /* best effort */ }
      if (backup && existsSync(backup)) {
        renameSync(backup, destBin);
      }
      return { ok: false, destBin, backup, reason: "probe" };
    }

    return { ok: true, destBin, backup, reason: null };
  } catch (e) {
    // Attempt to restore backup on error
    if (backup && existsSync(backup) && !existsSync(destBin)) {
      try { renameSync(backup, destBin); } catch { /* best effort */ }
    }
    return { ok: false, destBin, backup, reason: "install" };
  }
}

// ---------------------------------------------------------------------------
// ensureGraftd
// ---------------------------------------------------------------------------
// Helper: copy the sibling `graft` CLI from srcBinDir to ~/.local/bin/graft
// only when the source exists and the destination does not.
function copyGraftCli(srcBinDir, home) {
  const srcGraft = join(srcBinDir, "graft");
  if (!existsSync(srcGraft)) return;
  const destGraft = join(home, ".local", "bin", "graft");
  if (existsSync(destGraft)) return;
  try {
    mkdirSync(dirname(destGraft), { recursive: true });
    copyFileSync(srcGraft, destGraft);
    chmodSync(destGraft, 0o755);
  } catch { /* best effort */ }
}

export async function ensureGraftd({
  configPath,
  accel = "cpu",
  allowBuild = true,
  log = console.log,
  env = process.env,
  home = os.homedir(),
  pkgRoot = PKG_ROOT,
} = {}) {
  const t0 = Date.now();
  const canonical = join(home, ".local", "bin", "graftd");

  // 1a. Probe canonical first. If it works, nothing to do.
  const canonicalProbe = probeGraftd(canonical, { configPath });
  if (canonicalProbe.ok) {
    return { ok: true, path: canonical, source: "existing", elapsedMs: Date.now() - t0, reason: null, message: null };
  }

  // 1b. Probe other default candidates (build dir, ~/Repos/graft-cpp).
  //     If any works, install it atomically into canonical and return.
  const { buildDir } = buildPaths({ pkgRoot, home, env });
  const otherCandidates = [
    join(buildDir, "graftd"),
    join(home, "Repos", "graft-cpp", "build", "graftd"),
  ];

  for (const candidate of otherCandidates) {
    const r = probeGraftd(candidate, { configPath });
    if (!r.ok) continue;

    // Found a working non-canonical binary — install it into canonical.
    const installResult = installGraftd({ srcBin: candidate, destBin: canonical, configPath });
    if (installResult.ok) {
      // Copy the sibling `graft` CLI if applicable.
      copyGraftCli(dirname(candidate), home);
      return {
        ok: true,
        path: canonical,
        source: "installed",
        from: candidate,
        elapsedMs: Date.now() - t0,
        reason: null,
        message: null,
      };
    }
    // Install failed (probe of the newly copied file failed); fall through to build.
    break;
  }

  // 2. If build not allowed
  if (!allowBuild) {
    const msg = [
      "SETUP NEEDED",
      "No working graftd binary was found.",
      "Run: heimdall setup",
      "Or set HEIMDALL_NO_BUILD=1 to skip the build step.",
    ].join("\n");
    return { ok: false, path: null, source: null, elapsedMs: Date.now() - t0, reason: "no-binary", message: msg };
  }

  // 3. Check toolchain
  const tc = toolchainStatus({ env });
  if (!tc.ok) {
    const missing = [];
    if (!tc.cmake) missing.push("cmake");
    if (!tc.compiler) missing.push("a C/C++ compiler (c++, g++, clang++, cc, gcc, or clang)");
    if (!tc.git) missing.push("git");
    const paths = buildPaths({ pkgRoot, home, env });
    const msg = [
      "SETUP NEEDED",
      `Missing from PATH: ${missing.join(", ")}.`,
      `Install them, then run: heimdall setup`,
      `Manual: cmake -S ${paths.sourceDir} -B ${paths.buildDir} -DCMAKE_BUILD_TYPE=Release && cmake --build ${paths.buildDir} --target graftd graft`,
      `Skip build: HEIMDALL_NO_BUILD=1 heimdall setup`,
    ].join("\n");
    return { ok: false, path: null, source: null, elapsedMs: Date.now() - t0, reason: "toolchain", message: msg };
  }

  // 4. Build
  const paths = buildPaths({ pkgRoot, home, env });
  const logFile = join(home, ".heimdall", "bootstrap.log");
  log(`[heimdall] building graftd — this may take several minutes. Log: ${logFile}`);

  const buildResult = buildGraftd({
    sourceDir: paths.sourceDir,
    buildDir: paths.buildDir,
    llamaSourceDir: paths.llamaSourceDir,
    accel,
    logFile,
    env,
  });

  if (!buildResult.ok) {
    const msg = [
      "SETUP NEEDED",
      `Build failed (reason: ${buildResult.reason}).`,
      `Log: ${buildResult.logFile}`,
      `Retry: heimdall setup`,
      `Manual: cmake -S ${paths.sourceDir} -B ${paths.buildDir} -DCMAKE_BUILD_TYPE=Release && cmake --build ${paths.buildDir} --target graftd graft`,
      `Skip: HEIMDALL_NO_BUILD=1 heimdall setup`,
    ].join("\n");
    return { ok: false, path: null, source: null, elapsedMs: Date.now() - t0, reason: buildResult.reason, message: msg };
  }

  // 5. Install graftd (installGraftd probes the destination internally; no
  //    extra probe needed after a successful install — FIX 2).
  const installResult = installGraftd({ srcBin: buildResult.binPath, destBin: canonical, configPath });

  // 6. Copy graft CLI if it doesn't exist yet
  if (buildResult.graftCliPath) {
    copyGraftCli(dirname(buildResult.graftCliPath), home);
  }

  if (!installResult.ok) {
    const msg = [
      "SETUP NEEDED",
      `Install failed (reason: ${installResult.reason}).`,
      `Log: ${logFile}`,
      `Retry: heimdall setup`,
      `Manual: cmake -S ${paths.sourceDir} -B ${paths.buildDir} -DCMAKE_BUILD_TYPE=Release && cmake --build ${paths.buildDir} --target graftd graft`,
      `Skip: HEIMDALL_NO_BUILD=1 heimdall setup`,
    ].join("\n");
    return { ok: false, path: null, source: null, elapsedMs: Date.now() - t0, reason: installResult.reason, message: msg };
  }

  return { ok: true, path: canonical, source: "built", elapsedMs: Date.now() - t0, reason: null, message: null };
}
