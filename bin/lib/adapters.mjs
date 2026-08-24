// adapters.mjs — per-harness config writers for `heimdall init --harness X`.
// Each writer installs the full enforcement stack for its harness:
//   1. rules/memory file with the canonical memory-first rule block
//   2. guard hook wired into the harness's hook system (where supported)
//   3. MCP server registration (where supported) → kb_search/kb_insert/kb_sync
// Writers merge into existing configs (never clobber) and are idempotent.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync, chmodSync, appendFileSync } from "node:fs";
import os from "node:os";
import { ruleBlock, RULES_VERSION } from "./enforcement-rules.mjs";

const HOME = () => os.homedir();

const MARKER_OPEN = `<!-- heimdall:enforcement v${RULES_VERSION} -->`;
const MARKER_CLOSE = "<!-- /heimdall:enforcement -->";

function ensure(dir) {
	mkdirSync(dir, { recursive: true });
	return dir;
}

function readIfExists(p) {
	return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Append the rule block to a markdown file if not already present. Idempotent. */
function upsertMarkdownBlock(mdPath, block = ruleBlock()) {
	const existing = readIfExists(mdPath);
	if (existing.includes(MARKER_OPEN)) return false;
	const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
	ensure(join(mdPath, ".."));
	appendFileSync(mdPath, `${sep}${block}\n`);
	return true;
}

/** Merge a JSON file deeply-ish (top-level + one nested level), preserving non-heimdall keys.
 * Parse failure = ABORT (never reset user config from {}); backs up before first write. */
function mergeJson(jsonPath, patch) {
	let data = {};
	if (existsSync(jsonPath)) {
		const raw = readFileSync(jsonPath, "utf8");
		if (raw.trim()) {
			try {
				data = JSON.parse(raw);
			} catch (e) {
				throw new Error(`${jsonPath} is not valid JSON (${e.message}) — fix or remove it, then rerun init`);
			}
			copyFileSync(jsonPath, `${jsonPath}.heimdall-bak`);
		}
	}
	for (const [k, v] of Object.entries(patch)) {
		if (v && typeof v === "object" && !Array.isArray(v) && data[k] && typeof data[k] === "object" && !Array.isArray(data[k])) {
			Object.assign(data[k], v);
		} else {
			data[k] = v;
		}
	}
	ensure(join(jsonPath, ".."));
	writeFileSync(jsonPath, JSON.stringify(data, null, 2) + "\n");
}

// adapters.mjs lives at <root>/bin/lib/ → lib=1×dirname, bin=2×, package root=3×.
const HERE_LIB = dirname(fileURLToPath(import.meta.url));
const pkgBinDir = () => dirname(HERE_LIB);
const pkgRoot = () => dirname(dirname(HERE_LIB));

/** Install bin/heimdall-hook.mjs as ~/.local/bin/heimdall-hook executable shim. */
export function installHookBinary(home = HOME()) {
	const dest = ensure(join(home, ".local", "bin"));
	const src = join(pkgRoot(), "bin", "heimdall-hook.mjs");
	if (!existsSync(src)) throw new Error(`heimdall-hook.mjs not found at ${src}`);
	const target = join(dest, "heimdall-hook");
	copyFileSync(src, target);
	chmodSync(target, 0o755);
	return target;
}

/**
 * Register the MCP server in a settings object shaped like
 * { mcpServers: { heimdall: { command, args } } } — the common dialect
 * (Claude Code, Gemini CLI, Cursor, DeepSeek all use mcpServers).
 */
function mcpServerEntry(nodeBin, heimdallJs) {
	return { command: nodeBin || "node", args: [heimdallJs], env: {} };
}

function resolveCli() {
	// The installed package layout: <root>/bin/lib/adapters.mjs
	// so heimdall.js is always <root>/bin/heimdall.js — works for global
	// installs, local installs, and repo checkouts alike.
	return join(pkgRoot(), "bin", "heimdall.js");
}

// ---------- pi ---------------------------------------------------------------
// pi auto-discovers extensions from ~/.pi/agent/extensions/. The heimdall npm
// package ships kb-tools.ts / kb-search-guard.ts / kb-autosync.ts / kb-orient.ts.
function writePi(home) {
	const pkgExtensions = join(pkgRoot(), "extensions");
	const targetDir = ensure(join(home, ".pi", "agent", "extensions"));
	const libTarget = ensure(join(targetDir, "lib"));
	const files = ["kb-tools.ts", "kb-search-guard.ts", "kb-autosync.ts", "kb-orient.ts"];
	const copied = [];
	for (const f of files) {
		const src = join(pkgExtensions, f);
		if (existsSync(src)) { copyFileSync(src, join(targetDir, f)); copied.push(f); }
	}
	const coreSrc = join(pkgExtensions, "lib", "kb-guard-core.mjs");
	if (existsSync(coreSrc)) copyFileSync(coreSrc, join(libTarget, "kb-guard-core.mjs"));
	upsertMarkdownBlock(join(home, ".pi", "agent", "AGENTS.md"));
	return "pi";
}

// ---------- claude-code --------------------------------------------------------
function writeClaudeCode(home) {
	const cli = resolveCli();
	const hookBin = installHookBinary(home);
	mergeJson(join(home, ".claude", "settings.json"), {
		mcpServers: { heimdall: mcpServerEntry(process.execPath, cli) },
	});
	// hooks.PostToolUse is an ARRAY the user may already use (formatters etc).
	// Merge entry-wise: drop prior heimdall entries (idempotency), keep theirs.
	const settingsPath = join(home, ".claude", "settings.json");
	let settings = {};
	try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* fresh */ }
	settings.hooks = settings.hooks ?? {};
	const existing = Array.isArray(settings.hooks.PostToolUse) ? settings.hooks.PostToolUse : [];
	const ours = { matcher: "Bash|Grep|Glob|Read", hooks: [{ type: "command", command: `'${hookBin}'`, timeout: 5 }] };
	const kept = existing.filter((e) => !JSON.stringify(e).includes("heimdall-hook"));
	writeFileSync(settingsPath, JSON.stringify({ ...settings, hooks: { ...settings.hooks, PostToolUse: [...kept, ours] } }, null, 2) + "\n");
	upsertMarkdownBlock(join(home, ".claude", "CLAUDE.md"), ruleBlock("mcp__heimdall__kb_search"));
	return "claude-code";
}

// ---------- codex ---------------------------------------------------------------
// Codex reads ~/.codex/config.toml; MCP servers under [mcp_servers.<name>].
// Line-based TOML insertion — no TOML dependency.
function writeCodex(home) {
	const cli = resolveCli();
	const cfgDir = ensure(join(home, ".codex"));
	const cfgPath = join(cfgDir, "config.toml");
	const toml = readIfExists(cfgPath);
	if (!toml.includes("[mcp_servers.heimdall]")) {
		const entry = `\n[mcp_servers.heimdall]\ncommand = "${process.execPath}"\nargs = ["${cli}"]\n`;
		appendFileSync(cfgPath, entry);
	}
	upsertMarkdownBlock(join(home, "AGENTS.md"), ruleBlock("kb_search"));
	return "codex";
}

// ---------- cursor ----------------------------------------------------------------
// Project-type rules live in ~/.cursor/rules/*.mdc with frontmatter.
function writeCursor(home) {
	const rulesDir = ensure(join(home, ".cursor", "rules"));
	const rulePath = join(rulesDir, "heimdall.mdc");
	if (!readIfExists(rulePath).includes(MARKER_OPEN)) {
		const body = `---\ndescription: Heimdall memory-first retrieval enforcement\nalwaysApply: true\n---\n\n${ruleBlock("mcp__heimdall__kb_search")}\n`;
		writeFileSync(rulePath, body);
	}
	mergeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { heimdall: mcpServerEntry(process.execPath, resolveCli()) } });
	return "cursor";
}

// ---------- opencode -----------------------------------------------------------------
// OpenCode loads plugins from ~/.config/opencode/plugins/*.js — each a module
// exporting hooks. We ship a plugin that registers the guard + tool guidance.
function writeOpencode(home) {
	const cli = resolveCli();
	const pluginsDir = ensure(join(home, ".config", "opencode", "plugins"));
	const pluginPath = join(pluginsDir, "heimdall.js");
	const plugin = `// heimdall plugin — installed by 'heimdall init --harness opencode'
// Guard: counts grep-style tool calls; after 3 without kb_search, appends a
// warning to bash output. Tools come via the heimdall MCP server configured
// in opencode.json (written alongside this plugin).
const MARKER = "[heimdall]";
let chain = 0;
export const HeimdallPlugin = async ({ project }) => ({
	event: async ({ event }) => {
		if (event.type === "message.updated") return;
	},
	"tool.execute.after": async (input, output) => {
		const name = String(input?.tool ?? "");
		const isSearch = /kb_search|kb_sync/i.test(name);
		const isGrepStyle = /^(bash|grep|find|ls|read)$/i.test(name);
		if (isSearch) { chain = 0; return output; }
		if (!isGrepStyle) return output;
		chain += 1;
		if (chain >= 3) {
			output.addOutput({
				title: MARKER,
				output: \`\${chain} search actions without kb_search. Run mcp__heimdall__kb_search first (memory-first rule), or state why memory is irrelevant.\`,
			});
		}
		return output;
	},
});
`;
	writeFileSync(pluginPath, plugin);
	// opencode.json at ~/.config/opencode/opencode.json — mcp local servers
	mergeJson(join(home, ".config", "opencode", "opencode.json"), {
		mcp: { heimdall: { type: "local", enabled: true, command: [process.execPath, cli] } },
	});
	upsertMarkdownBlock(join(home, ".config", "opencode", "AGENTS.md"), ruleBlock("mcp__heimdall__kb_search"));
	return "opencode";
}

// ---------- gemini-cli ------------------------------------------------------------------
function writeGeminiCli(home) {
	const cli = resolveCli();
	mergeJson(join(home, ".gemini", "settings.json"), {
		mcpServers: { heimdall: mcpServerEntry(process.execPath, cli) },
	});
	upsertMarkdownBlock(join(home, ".gemini", "GEMINI.md"), ruleBlock("mcp__heimdall__kb_search"));
	return "gemini-cli";
}

// ---------- deepseek ----------------------------------------------------------------------
// DeepSeek's published agent harness follows the Claude-Code-style config:
// ~/.deepseek/settings.json with mcpServers + hooks. Marked experimental:
// if the product's real paths differ, --detect won't find it and this writer
// still produces a valid config dir users can point the harness at.
function writeDeepseek(home) {
	const cli = resolveCli();
	const hookBin = installHookBinary(home);
	mergeJson(join(home, ".deepseek", "settings.json"), {
		experimental_heimdall: true,
		mcpServers: { heimdall: mcpServerEntry(process.execPath, cli) },
	});
	// same array-aware PostToolUse merge as claude-code
	const settingsPath = join(home, ".deepseek", "settings.json");
	let settings = {};
	try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* fresh */ }
	settings.hooks = settings.hooks ?? {};
	const existing = Array.isArray(settings.hooks.PostToolUse) ? settings.hooks.PostToolUse : [];
	const ours = { matcher: "Bash|Grep|Glob|Read", hooks: [{ type: "command", command: `'${hookBin}'`, timeout: 5 }] };
	const kept = existing.filter((e) => !JSON.stringify(e).includes("heimdall-hook"));
	writeFileSync(settingsPath, JSON.stringify({ ...settings, hooks: { ...settings.hooks, PostToolUse: [...kept, ours] } }, null, 2) + "\n");
	upsertMarkdownBlock(join(home, ".deepseek", "AGENTS.md"), ruleBlock("mcp__heimdall__kb_search"));
	return "deepseek (experimental — verify config path matches your DeepSeek harness version)";
}

const WRITERS = {
	pi: writePi,
	"claude-code": writeClaudeCode,
	codex: writeCodex,
	cursor: writeCursor,
	opencode: writeOpencode,
	"gemini-cli": writeGeminiCli,
	deepseek: writeDeepseek,
};

export const KNOWN_HARNESSES = Object.keys(WRITERS);

/** Probe standard config locations; returns list of installed harness names. */
export function detectHarnesses(home = HOME()) {
	const probes = [
		["claude-code", join(home, ".claude")],
		["codex", join(home, ".codex")],
		["cursor", join(home, ".cursor")],
		["opencode", join(home, ".config", "opencode")],
		["gemini-cli", join(home, ".gemini")],
		["deepseek", join(home, ".deepseek")],
		["pi", join(home, ".pi", "agent")],
	];
	return probes.filter(([, p]) => existsSync(p)).map(([name]) => name);
}

export function installAdapter(harness, home = HOME()) {
	if (harness === "all") {
		return Object.keys(WRITERS).map((h) => installAdapter(h, home));
	}
	const writer = WRITERS[harness];
	if (!writer) throw new Error(`unknown harness: ${harness}. Known: ${KNOWN_HARNESSES.join(", ")}`);
	return writer(home);
}
