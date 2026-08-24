// init-e2e — golden end-to-end: fresh HOME → init --harness all → every
// harness has its enforcement stack; re-run is idempotent; the installed
// hook binary runs and warns on a grep chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const HEIMDALL = join(repo, "bin", "heimdall.js");

const ALL7 = ["claude-code", "codex", "cursor", "deepseek", "gemini-cli", "opencode", "pi"];

test("e2e: init --harness all wires every harness in a fresh HOME", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-e2e-"));
	// pretend every harness is installed so 'all' covers real dirs
	for (const d of [".claude", ".codex", ".cursor", ".config/opencode", ".gemini", ".deepseek", ".pi/agent"]) {
		mkdirSync(join(home, d), { recursive: true });
	}
	try {
		const r = spawnSync(process.execPath, [HEIMDALL, "init", "--harness", "all", "--quiet"], {
			encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000,
		});
		assert.equal(r.status, 0, r.stderr);

		assert.ok(existsSync(join(home, ".claude", "settings.json")));
		assert.ok(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8").includes("heimdall:enforcement v1"));
		assert.ok(existsSync(join(home, ".local", "bin", "heimdall-hook")));

		assert.ok(readFileSync(join(home, ".codex", "config.toml"), "utf8").includes("[mcp_servers.heimdall]"));
		assert.ok(readFileSync(join(home, "AGENTS.md"), "utf8").includes("heimdall:enforcement v1"));

		assert.ok(existsSync(join(home, ".cursor", "rules", "heimdall.mdc")));
		assert.ok(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.heimdall);

		assert.ok(existsSync(join(home, ".config", "opencode", "plugins", "heimdall.js")));

		assert.ok(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.heimdall);
		assert.ok(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8").includes("heimdall:enforcement v1"));

		assert.ok(JSON.parse(readFileSync(join(home, ".deepseek", "settings.json"), "utf8")).mcpServers.heimdall);

		assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "kb-tools.ts")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

test("e2e: idempotent — second run leaves exactly one block/hook", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-e2e-"));
	try {
		mkdirSync(join(home, ".claude"), { recursive: true });
		mkdirSync(join(home, ".codex"), { recursive: true });
		for (const _ of [1, 2]) {
			spawnSync(process.execPath, [HEIMDALL, "init", "--harness", "all", "--quiet"], {
				encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000,
			});
		}
		const claude = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
		assert.equal(claude.split("heimdall:enforcement v1").length - 1, 1);
		const agents = readFileSync(join(home, "AGENTS.md"), "utf8");
		assert.equal(agents.split("heimdall:enforcement v1").length - 1, 1);
		const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
		assert.equal(settings.hooks.PostToolUse.length, 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, { timeout: 120_000 });

test("e2e: installed heimdall-hook binary warns on 3rd grep action and resets on kb_search", () => {
	const home = mkdtempSync(join(tmpdir(), "heimdall-e2e-"));
	try {
		spawnSync(process.execPath, [HEIMDALL, "init", "--harness", "claude-code", "--quiet"], {
			cwd: repo, env: { ...process.env, HOME: home }, timeout: 60_000,
		});
		const hook = join(home, ".local", "bin", "heimdall-hook");
		assert.ok(existsSync(hook));
		const feed = (tool) => spawnSync(hook, { input: JSON.stringify({ tool_name: tool }), encoding: "utf8" });
		assert.equal(feed("Bash").stdout.trim(), "");
		assert.equal(feed("Grep").stdout.trim(), "");
		assert.match(feed("Read").stdout, /kb_search/);
		// MCP-style reset
		feed("mcp__heimdall__kb_search");
		assert.equal(feed("Bash").stdout.trim(), "");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, { timeout: 120_000 });
