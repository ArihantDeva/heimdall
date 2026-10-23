// python.mjs — resolve a python that can actually run the suites that need it.
//
// WHY (2026-10-23, CI red): four suites did
//
//   const VENV_PY = join(homedir(), ".heimdall", "venv", "bin", "python3");
//   const PY = existsSync(VENV_PY) ? VENV_PY : "python3";
//
// which reads as "fall back to the system python" but MEANS "fall back to a
// python that may not have sqlite_vec". On a developer machine the venv exists
// and the fallback never fires; on CI there is no ~/.heimdall venv, so every one
// of those suites silently ran against a python with no sqlite_vec and failed
// with ModuleNotFoundError — a failure that looks like broken code and is
// actually a missing dependency nobody declared.
//
// The rule this encodes: a fallback is only a fallback if it can do the job.
// Probe for the CAPABILITY (`import sqlite_vec`), not for a path, and let callers
// skip loudly when nothing qualifies. A skip that names what is missing is
// honest; a green run that never imported the module is not.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where a sqlite_vec-capable interpreter plausibly lives, best first. */
export function pythonCandidates() {
  const out = [];
  const env = process.env.HEIMDALL_PYTHON;
  if (env) out.push(env); // documented override, same as bin/lib/depth.mjs
  out.push(join(homedir(), ".heimdall", "venv", "bin", "python3"));
  out.push("python3");
  // De-duplicate while keeping priority order.
  return [...new Set(out)];
}

const probeCache = new Map();

/** bin/embed-index.py, resolved from this file (tests/lib/ -> repo root). */
const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");
const EMBED_INDEX = join(BIN_DIR, "embed-index.py");

/**
 * True when `py` can actually USE sqlite_vec, not merely import it.
 * Memoised — this spawns a process.
 *
 * `import sqlite_vec` is necessary but NOT sufficient, and the difference is
 * load-bearing: the extension is a compiled .so/.dylib that sqlite must be able
 * to load at runtime via `enable_load_extension`. Measured 2026-10-23: macOS's
 * CommandLineTools python (/usr/bin/python3, and any venv built from it) imports
 * sqlite_vec perfectly well and then raises
 *
 *   AttributeError: 'sqlite3.Connection' object has no attribute 'enable_load_extension'
 *
 * because that sqlite3 was compiled with --disable-loadable-extensions. The old
 * probe returned true for it, so every gated suite UNSKIPPED and then failed —
 * the worst of both: a red build whose cause reads as broken product code when
 * it is a python build option. Linux/Homebrew pythons have the method, so this
 * only ever detonates on macOS, which is exactly where it went unnoticed.
 *
 * So the probe does the load. That is the capability the suites need.
 */
export function canLoadSqliteVec(py) {
  if (probeCache.has(py)) return probeCache.get(py);
  // An absolute candidate that does not exist is not worth spawning.
  if (py.includes("/") && !existsSync(py)) {
    probeCache.set(py, false);
    return false;
  }
  const probe = [
    "import sqlite3, sqlite_vec",
    "c = sqlite3.connect(':memory:')",
    // A missing attribute is the macOS case; a load failure is a broken or
    // missing .so. Both mean "this interpreter cannot serve the suites", and
    // both must read as false rather than raising out of the probe.
    "c.enable_load_extension(True)",
    "sqlite_vec.load(c)",
    // Prove the extension is genuinely registered, not merely dlopen'd.
    "c.execute('select vec_version()').fetchone()",
  ].join("\n");
  const r = spawnSync(py, ["-c", probe], { encoding: "utf8", timeout: 60_000 });
  const ok = r.status === 0;
  probeCache.set(py, ok);
  return ok;
}

/**
 * The first candidate that can import sqlite_vec, or null.
 *
 * Callers MUST treat null as "cannot verify on this machine" and skip with a
 * message naming the missing module — never as "the feature is fine".
 */
export function sqliteVecPython() {
  for (const py of pythonCandidates()) {
    if (canLoadSqliteVec(py)) return py;
  }
  return null;
}

/**
 * True when `py` can IMPORT bin/embed-index.py — i.e. it has every module that
 * module imports at top level, not just sqlite_vec.
 *
 * The behavioural tests exec embed-index.py directly, and `import sqlite_vec`
 * succeeding was never sufficient for that: embed-index.py also imports
 * sentence_transformers. Measured 2026-10-23: a CI-shaped venv with sqlite-vec
 * added gated those tests IN (sqlite_vec imports) and they failed with
 * ModuleNotFoundError: sentence_transformers — a skip that should have stayed a
 * skip, reported as broken product code.
 *
 * Probing the module the test actually imports is the only probe that cannot
 * drift from what the test needs. Each new dependency in embed-index.py is then
 * covered automatically instead of needing a second hand-maintained list.
 */
export function canImportEmbedIndex(py) {
  const key = "embed-index:" + py;
  if (probeCache.has(key)) return probeCache.get(key);
  if (!canLoadSqliteVec(py)) {
    probeCache.set(key, false);
    return false;
  }
  const script = [
    "import importlib.util, sys, sqlite3",
    `sys.path.insert(0, ${JSON.stringify(BIN_DIR)})`,  // embed-index.py imports embed_walker from its own dir
    "import sqlite_vec",
    "c = sqlite3.connect(':memory:'); c.enable_load_extension(True); sqlite_vec.load(c)",
    `spec = importlib.util.spec_from_file_location("embed_index", ${JSON.stringify(EMBED_INDEX)})`,
    "m = importlib.util.module_from_spec(spec)",
    "sys.modules['embed_index'] = m",
    "spec.loader.exec_module(m)",
  ].join("\n");
  const r = spawnSync(py, ["-c", script], { encoding: "utf8", timeout: 120_000 });
  const ok = r.status === 0;
  probeCache.set(key, ok);
  return ok;
}

/** The first candidate that can import embed-index.py, or null. */
export function embedIndexPython() {
  for (const py of pythonCandidates()) {
    if (canImportEmbedIndex(py)) return py;
  }
  return null;
}

export function embedIndexSkipReason() {
  return (
    "bin/embed-index.py is not importable by any candidate python " +
    `(${pythonCandidates().join(", ")}) — it needs sqlite_vec (loadable, not just ` +
    "importable) plus sentence_transformers. Install them where this suite can " +
    "see them, or set HEIMDALL_PYTHON to an interpreter that has both."
  );
}

/** A human-readable reason to put in a skip, naming the real gap. */
export function sqliteVecSkipReason() {
  return (
    "sqlite_vec is not importable by any candidate python " +
    `(${pythonCandidates().join(", ")}). Install it where this suite can see it: ` +
    "python3 -m pip install sqlite-vec, or set HEIMDALL_PYTHON to an interpreter that has it."
  );
}

/**
 * A python for suites that need only the STDLIB (e.g. importing embed_walker).
 *
 * Gating these on sqlite_vec would be wrong in the other direction: it would skip
 * real coverage on a machine that can perfectly well run the check. Only the
 * suites that actually import the extension may demand it.
 */
export function plainPython() {
  for (const py of pythonCandidates()) {
    if (py.includes("/") && !existsSync(py)) continue;
    const r = spawnSync(py, ["-c", "import sys"], { encoding: "utf8", timeout: 60_000 });
    if (r.status === 0) return py;
  }
  return "python3"; // let the caller fail with python's own ENOENT if there is none
}

/**
 * `node:test` skip gate for suites needing sqlite_vec.
 *
 * Pair with `describe.skipIf` / `it.skipIf`: when the extension is absent the
 * suite reports "# SKIP" with a reason instead of failing on an import it was
 * never given.
 */
export function hasSqliteVec() {
  return sqliteVecPython() !== null;
}

// ── Machine-state probes ────────────────────────────────────────────────────
//
// Some suites are INTEGRATION tests: they interrogate a live index built from the
// operator's whole home directory (people.db holds real contacts; the fact leg
// reads ~/.heimdall/global.db; the code leg needs a per-repo graft graph). They
// cannot be made hermetic without reimplementing the corpus, which would test the
// fixture instead of the retrieval.
//
// ci.yml already draws exactly this line for bench/, and says why: "bench/tests
// require the local graft daemon + embedding cache (~/.heimdall), which GitHub
// runners don't have." These probes extend the same rule to the suites that
// silently shared the requirement — they used to FAIL on a clean machine, which
// reads as broken code rather than "not applicable here".
import { existsSync as exists, readdirSync, statSync } from "node:fs";

const stateFile = (name) => join(homedir(), ".heimdall", name);

// Existence is NOT usability. Measured 2026-10-23: an unrelated suite
// (`kb-insert-latency`) creates a zero-byte ~/.heimdall/people.db as a side
// effect of running the insert CLI, which made this probe report a live store on
// a machine that had never built one — and the gate then let the person slice run
// against an empty table and fail. A store with no rows answers nothing.
const nonEmpty = (p) => {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
};

/**
 * A SQLite store that the suites can actually QUERY.
 *
 * Size is not usability either. Measured 2026-10-23 by poison-testing (seeding
 * a fake ~/.heimdall): a 9-byte text file named people.db passes `size > 0`, so
 * the gate opened, the person-slice test stopped skipping, and it then PASSED
 * against a file that is not a database — because its own catch block swallowed
 * "file is not a database" and returned early. Green, and asserting nothing.
 *
 * The only probe that cannot be fooled is opening it and running a real query:
 * that proves a SQLite header, a readable b-tree, and the table the caller
 * needs. `expectedTable` is checked too, because a valid empty database is still
 * "not a built index".
 */
function usableSqlite(file, expectedTable) {
  if (!nonEmpty(file)) return false;
  const r = spawnSync("python3", ["-c", `
import sqlite3, sys
p, table = sys.argv[1], sys.argv[2]
c = sqlite3.connect("file:%s?mode=ro" % p, uri=True)
n = c.execute("select count(*) from %s" % table).fetchone()[0]
c.close()
sys.exit(0 if n > 0 else 1)
`, file, expectedTable], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0;
}

/** A built global index — the semantic + fact legs read this. */
export const hasIndex = () => usableSqlite(stateFile("global.db"), "cards");

/** The people store, with rows — the whole person slice reads this. */
export const hasPeopleStore = () => usableSqlite(stateFile("people.db"), "people");

/** A repo graft graph under ~/Repos — the lexical/code leg reads these. */
/**
 * A BUILT per-repo graft graph, i.e. the thing the code leg actually reads.
 *
 * Checking for a directory NAMED `graft` was the same proxy bug as `size > 0`
 * on the sqlite stores (measured 2026-10-23): an EMPTY `~/Repos/x/graft/`
 * directory satisfied this probe, so the code-leg suites stopped skipping and
 * then ran against nothing. The directory name is not the artifact.
 *
 * `graft/INDEX.md` is: it is the graph entry point the backend writes, and it is
 * present in all 33 built graphs on this machine. Requiring a real file means a
 * half-initialised or emptied directory reads as "not built here", which is the
 * honest verdict — and it keeps the gate cheap (one stat per repo, no parsing).
 */
export function hasGraftGraph() {
  const repos = join(homedir(), "Repos");
  if (!exists(repos)) return false;
  try {
    // One level deep is where every per-repo graph lives (graft/ at the root).
    return readdirSync(repos, { withFileTypes: true })
      .some((e) => e.isDirectory()
        && nonEmpty(join(repos, e.name, "graft", "INDEX.md")));
  } catch {
    return false;
  }
}

/** Why a live-state suite cannot run here, naming the missing artifact. */
export function liveStateSkipReason(what) {
  const missing = [];
  if (!hasPeopleStore()) missing.push("~/.heimdall/people.db");
  if (!hasIndex()) missing.push("~/.heimdall/global.db");
  if (!hasGraftGraph()) missing.push("a per-repo graft graph under ~/Repos");
  return (
    `${what} reads live machine state that is not present here: ` +
    `${missing.join(", ")}. Build an index with \`heimdall index\` and this suite ` +
    "runs; skipping is honest, failing reads as a code defect that is not there."
  );
}
