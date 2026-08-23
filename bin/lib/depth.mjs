// depth.mjs — how much of a file the graph knows about.
//
//   L0 path    the file exists
//   L1 file    + language, size, description
//   L2 symbol  + one node per top-level definition, with file:line and signature
//   L3 graph   + imports / calls / inherits / uses edges, intra- and cross-file
//
// The default is `max`, which resolves to the deepest level whose dependencies
// are ACTUALLY PRESENT on this machine. A box without tree-sitter degrades to
// L1 and `heimdall doctor` says so, instead of failing to install. That keeps
// "default is maximum" honest without making tree-sitter a hard blocker.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const LEVELS = ["path", "file", "symbol", "graph"];
export const rank = (d) => LEVELS.indexOf(d);

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(dirname(HERE));

export const configPath = () => join(homedir(), ".heimdall", "config.json");
export const journalPath = () => join(homedir(), ".heimdall", "journal.db");
export const lockPath = () => join(homedir(), ".heimdall", "reconciler.lock");
export const queueHintPath = () => join(homedir(), ".heimdall", "hints.jsonl");

/** The python3 that can import tree_sitter, or null. */
export function pythonWithTreeSitter(env = process.env) {
  const candidates = [
    env.HEIMDALL_PYTHON,
    join(homedir(), ".heimdall", "venv", "bin", "python3"),
    "python3",
  ].filter(Boolean);
  for (const py of candidates) {
    try {
      execFileSync(py, ["-c", "import tree_sitter"], { stdio: "ignore", timeout: 10_000 });
      return py;
    } catch { /* try next */ }
  }
  return null;
}

let _cachedCap;
/**
 * Deepest level this machine can actually produce.
 * L2 and L3 both need tree-sitter; without it we cap at L1.
 */
export function capability(env = process.env, { fresh = false } = {}) {
  if (!fresh && _cachedCap) return _cachedCap;
  const py = pythonWithTreeSitter(env);
  _cachedCap = {
    max: py ? "graph" : "file",
    python: py,
    reason: py ? "tree-sitter available" : "tree-sitter not importable — L2/L3 unavailable",
  };
  return _cachedCap;
}

export function loadConfig(file = configPath()) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * Glob match limited to what root patterns actually need: `*` matches within a
 * path segment, `**` across segments. Anchored at the start, since roots are
 * prefixes.
 */
function matchRoot(pattern, path) {
  const pat = expand(pattern).replace(/\/+$/, "");
  if (!pat.includes("*")) return path === pat || path.startsWith(pat + "/");
  const rx = pat
    .split(/(\*\*|\*)/)
    .map((seg) => {
      if (seg === "**") return ".*";
      if (seg === "*") return "[^/]*";
      return seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${rx}(/|$)`).test(path);
}

/**
 * Depth for a path: the most specific matching root wins (longest pattern),
 * then the global default, then `max`. Always clamped to what this machine can
 * do, so a config asking for L3 on a tree-sitter-less box yields L1 rather
 * than an error.
 *
 * @returns {{requested: string, effective: string, clamped: boolean}}
 */
export function depthFor(path, cfg = loadConfig(), cap = capability()) {
  const roots = cfg.roots ?? {};
  let best = null;
  let bestLen = -1;
  for (const [pattern, level] of Object.entries(roots)) {
    if (!LEVELS.includes(level) && level !== "max") continue;
    if (matchRoot(pattern, path) && pattern.length > bestLen) {
      best = level;
      bestLen = pattern.length;
    }
  }
  const requested = best ?? cfg.depth ?? "max";
  const wanted = requested === "max" ? cap.max : requested;
  const effective = rank(wanted) > rank(cap.max) ? cap.max : wanted;
  return { requested, effective, clamped: effective !== wanted };
}

/** Roots the daemon watches. Defaults to the config's root patterns' literal prefixes. */
export function watchRoots(cfg = loadConfig()) {
  const explicit = cfg.watch_roots;
  if (Array.isArray(explicit) && explicit.length) return explicit.map(expand);
  const fromRoots = Object.keys(cfg.roots ?? {})
    .map((p) => expand(p).split("*")[0].replace(/\/+$/, ""))
    .filter(Boolean);
  return [...new Set(fromRoots)];
}
