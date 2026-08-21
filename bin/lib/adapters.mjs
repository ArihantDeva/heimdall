// adapters.mjs — per-harness config writers for `heimdall init --harness X`.
// Each writer installs the smallest config that makes heimdall usable:
// a search/insert instruction + (where hooks exist) an edit-log sync hook.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";

const HOME = () => os.homedir();

const SEARCH_SNIPPET = `## Heimdall knowledge search
Before implementing anything that might duplicate prior work, run:
  heimdall search "<topic>" --scope <project-or-empty>
Record reusable work after completing it:
  heimdall insert --title "<project> <what>" --body "<path> — <what/why>" --keywords a,b
Trust the verdict labels: STRONG = verified, WEAK = semantic-only, STALE = path gone.`;

function ensure(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePi(home) {
  const cfgDir = ensure(join(home, ".heimdall", "adapters", "pi"));
  writeFileSync(
    join(cfgDir, "README.md"),
    "# Pi adapter\n\nCopy extensions/kb-*.ts from the heimdall package into your pi extensions dir:\n  cp <npm-root>/heimdall/extensions/kb-*.ts ~/.pi/agent/extensions/\nThen add kb_search/kb_insert/kb_sync tools (kb-tools.ts) — they call the vendored bin/ scripts.\n",
  );
  writeFileSync(join(cfgDir, "snippet.md"), SEARCH_SNIPPET);
  return "pi";
}

function writeClaudeCode(home) {
  const settingsDir = ensure(join(home, ".claude"));
  const settingsPath = join(settingsDir, "settings.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* start fresh */ }
  }
  settings.hooks = settings.hooks || {};
  settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
  // Resolve the sync script ONCE at init (npm root -g is slow and can differ
  // inside hook shells); fall back to a PATH shim if the package moves.
  let syncScript = "";
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const candidate = join(root, "heimdall", "bin", "sync-edits.sh");
    if (existsSync(candidate)) syncScript = candidate;
  } catch { /* npm missing -> leave empty, fall through to shim */ }
  const hookCmd = syncScript
    ? `bash '${syncScript}' 2>/dev/null || true`
    : "heimdall-sync-edits 2>/dev/null || true";
  if (!settings.hooks.PostToolUse.some((h) => JSON.stringify(h).includes("heimdall"))) {
    settings.hooks.PostToolUse.push({
      matcher: "Write|Edit",
      hooks: [{ type: "command", command: hookCmd }],
    });
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  writeFileSync(join(home, ".claude", "HEIMDALL.md"), SEARCH_SNIPPET);
  return "claude-code";
}

function writeCodex(home) {
  const mdPath = join(home, "AGENTS.md");
  let md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  if (!md.includes("heimdall search")) {
    md += (md ? "\n" : "") + SEARCH_SNIPPET + "\n";
    writeFileSync(mdPath, md);
  }
  return "codex";
}

function writeRules(home, dirName, fileName) {
  const rulesDir = ensure(join(home, dirName, "rules"));
  const rulesPath = join(rulesDir, fileName);
  if (!existsSync(rulesPath)) writeFileSync(rulesPath, SEARCH_SNIPPET + "\n");
  return fileName;
}

const WRITERS = {
  pi: writePi,
  "claude-code": writeClaudeCode,
  codex: writeCodex,
  cursor: (home) => writeRules(home, ".cursor", "heimdall.mdc"),
  windsurf: (home) => writeRules(home, ".windsurf", "heimdall.md"),
};

export function installAdapter(harness, home = HOME()) {
  if (harness === "all") {
    return Object.keys(WRITERS).map((h) => installAdapter(h, home));
  }
  const writer = WRITERS[harness];
  if (!writer) throw new Error(`unknown harness: ${harness}`);
  return writer(home);
}
