// extract.mjs — the desired state for one path at one depth.
//
// Pure function of (file content, depth): same bytes and same depth always
// produce the same node/edge set. That property is what makes reconcile
// idempotent, and therefore what makes concurrent edits harmless.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { capability, rank, REPO_ROOT } from "./depth.mjs";

const BRIDGE = join(REPO_ROOT, "bin", "lib", "heimdall_extract.py");

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function hashFile(path) {
  return sha256(readFileSync(path));
}

const LANG_BY_EXT = {
  ".py": "python", ".js": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mjs": "javascript", ".cjs": "javascript",
  ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".rb": "ruby",
  ".cs": "csharp", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala",
  ".php": "php", ".swift": "swift", ".lua": "lua", ".zig": "zig",
  ".ps1": "powershell", ".ex": "elixir", ".exs": "elixir",
  ".m": "objc", ".mm": "objc", ".jl": "julia",
  ".md": "markdown", ".sh": "shell", ".bash": "shell", ".yaml": "yaml", ".yml": "yaml",
  ".json": "json", ".toml": "toml", ".sql": "sql", ".html": "html", ".css": "css",
};

export const languageOf = (path) => LANG_BY_EXT[extname(path).toLowerCase()] ?? "text";

/**
 * Node ids must be unique across the whole graph. graphify derives ids from the
 * file STEM (`_make_id(stem, name)`), so every `index.ts` in a monorepo would
 * collide. We namespace by a hash of the full path and keep graphify's raw id
 * as the `symbol`, which is what cross-file edges resolve against.
 */
const nsFor = (path) => sha256(path).slice(0, 12);
export const nodeIdFor = (path, rawId) => `${nsFor(path)}:${rawId}`;

const lineOf = (loc) => {
  const m = /^L(\d+)$/.exec(String(loc ?? ""));
  return m ? Number(m[1]) : null;
};

/**
 * Run the tree-sitter bridge for a batch of paths.
 * @returns {Map<string, {nodes: any[], edges: any[], error: string|null}>}
 */
export function runBridge(paths, cap = capability()) {
  if (!paths.length || !cap.python) return new Map();
  let raw;
  try {
    raw = execFileSync(cap.python, [BRIDGE, ...paths], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    // Bridge crash must not lose files: callers fall back to L1.
    return new Map(paths.map((p) => [p, { nodes: [], edges: [], error: `bridge: ${err.message?.split("\n")[0]}` }]));
  }
  try {
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed.results ?? {}));
  } catch {
    return new Map(paths.map((p) => [p, { nodes: [], edges: [], error: "bridge: bad json" }]));
  }
}

/**
 * Desired state for a path.
 *
 * @param {string} path absolute
 * @param {string} depth requested effective depth
 * @param {object} [opts]
 * @param {Map} [opts.bridged] pre-computed bridge output (batch mode)
 * @returns {{nodes: any[], edges: any[], pending: any[], depth: string, hash: string, size: number, mtimeMs: number}}
 */
export function desiredState(path, depth, opts = {}) {
  const st = statSync(path);
  const buf = readFileSync(path);
  const hash = sha256(buf);
  const fileNodeId = nodeIdFor(path, "__file__");

  // L0: the file exists. Nothing more.
  const nodes = [{ node_id: fileNodeId, kind: "file", symbol: null, line: 1 }];
  const edges = [];
  const pending = [];
  let achieved = "path";

  if (rank(depth) >= rank("file")) {
    nodes[0].symbol = basename(path);
    nodes[0].language = languageOf(path);
    nodes[0].size = st.size;
    achieved = "file";
  }

  if (rank(depth) >= rank("symbol")) {
    const bridged = opts.bridged?.get(path) ?? runBridge([path], opts.cap).get(path);
    // No usable extraction (unsupported language, parse error, tree-sitter
    // gone) degrades this ONE path to L1. It is still indexed; it never
    // silently disappears.
    if (bridged && !bridged.error && bridged.nodes?.length) {
      const local = new Set(bridged.nodes.map((n) => n.id));
      // graphify emits its own file-level node, and hangs `contains` edges off
      // it. We drop that node (ours already covers the file) but keep its id so
      // those edges can be re-pointed at our file node instead of dangling.
      let fileRawId = null;
      for (const n of bridged.nodes) {
        if (n.id === undefined || n.id === null) continue;
        const isFileNode = String(n.label ?? "") === basename(path);
        if (isFileNode) { fileRawId = n.id; continue; }
        nodes.push({
          node_id: nodeIdFor(path, n.id),
          kind: "symbol",
          symbol: n.id,
          label: n.label,
          line: lineOf(n.source_location),
        });
      }
      achieved = "symbol";

      if (rank(depth) >= rank("graph")) {
        const idOf = (raw) => (raw === fileRawId ? fileNodeId : nodeIdFor(path, raw));
        for (const e of bridged.edges ?? []) {
          if (!e || !e.source || !e.target) continue;
          const src = idOf(e.source);
          if (local.has(e.target)) {
            edges.push({
              src, dst: idOf(e.target),
              relation: e.relation ?? "uses", line: lineOf(e.source_location),
            });
          } else {
            // Target lives in another file we may not have indexed yet.
            // Owned by THIS file, resolved when the target's file is
            // reconciled — so reconcile order cannot change the final graph.
            pending.push({
              src, dst_symbol: e.target,
              relation: e.relation ?? "uses", line: lineOf(e.source_location),
            });
          }
        }
        achieved = "graph";
      }
    }
  }

  return {
    nodes, edges, pending,
    depth: achieved,
    hash, size: st.size, mtimeMs: Math.floor(st.mtimeMs),
  };
}
