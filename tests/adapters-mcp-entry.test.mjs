// adapters-mcp-entry.test.mjs — issue #11 regression gate.
//
// The MCP protocol tests (tests/mcp-server.test.mjs) spawn `heimdall.js mcp`
// directly, so they never exercise the command+args the adapters actually
// write into a harness config. That gap let every generated config ship an
// entry point that prints usage and exits instead of serving JSON-RPC.
//
// These tests read the GENERATED config and launch what it says, which is the
// only way to catch a stale manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installAdapter, KNOWN_HARNESSES } from "../bin/lib/adapters.mjs";

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

function freshHome() {
	const home = mkdtempSync(join(tmpdir(), "heimdall-mcp-entry-"));
	return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Launch command+args, send one `initialize`, resolve the first JSON reply. */
function initializeOver(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		const timer = setTimeout(() => { child.kill(); resolve({ out, timedOut: true }); }, 15_000);
		child.stdout.on("data", (d) => {
			out += d;
			if (out.includes("\n")) {
				clearTimeout(timer);
				child.kill();
				resolve({ out, timedOut: false });
			}
		});
		child.stderr.on("data", (d) => { out += d; });
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.stdin.write(JSON.stringify(INIT) + "\n");
	});
}

/** Minimal TOML reader for the two keys the codex writer emits. */
function readCodexEntry(home) {
	const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
	const section = toml.split("[mcp_servers.heimdall]")[1] ?? "";
	const command = section.match(/^\s*command\s*=\s*"([^"]+)"/m)?.[1];
	const args = section.match(/^\s*args\s*=\s*\[([^\]]*)\]/m)?.[1]
		?.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
	return { command, args: args ?? [] };
}

test("issue #11: re-running init repairs a codex config written by the broken version", () => {
	const { home, cleanup } = freshHome();
	try {
		// Exactly what 0.10.0 wrote: the entry point with no `mcp` subcommand.
		mkdirSync(join(home, ".codex"), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), [
			'[mcp_servers.other]',
			'command = "/usr/bin/other"',
			'',
			'[mcp_servers.heimdall]',
			'command = "/usr/bin/node"',
			'args = ["/old/path/bin/heimdall.js"]',
			'',
		].join("\n"));

		installAdapter("codex", home);
		const { args } = readCodexEntry(home);

		assert.ok(
			args.includes("mcp"),
			`upgrading must repair the stale entry, but re-running init left args ${JSON.stringify(args)} — every 0.10.0 user stays broken after upgrade`,
		);
		assert.ok(
			readFileSync(join(home, ".codex", "config.toml"), "utf8").includes("[mcp_servers.other]"),
			"repairing our entry must not drop the user's other MCP servers",
		);
	} finally { cleanup(); }
});

test("issue #11: launching the generated codex config serves MCP, not usage text", async () => {
	const { home, cleanup } = freshHome();
	try {
		installAdapter("codex", home);
		const { command, args } = readCodexEntry(home);
		assert.ok(command, "config.toml must carry a command");
		assert.ok(args.length > 0, "config.toml must carry args");

		const { out, timedOut } = await initializeOver(command, args);

		assert.doesNotMatch(out, /usage: heimdall/i, "generated entry point printed usage instead of serving MCP");
		assert.equal(timedOut, false, `no MCP reply within 15s; got: ${out.slice(0, 400)}`);
		const reply = JSON.parse(out.split("\n").find((l) => l.trim().startsWith("{")));
		assert.equal(reply.id, 1, "reply must answer the initialize request");
		assert.ok(reply.result?.serverInfo, "initialize reply must carry serverInfo");
		assert.ok(reply.result?.protocolVersion, "initialize reply must carry protocolVersion");
	} finally { cleanup(); }
});

/** Every adapter that registers an MCP server, and how to read its args. */
const MCP_HARNESSES = {
	"claude-code": (home) => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).mcpServers.heimdall,
	// codex writes TOML, so the entry is read with the same minimal parser the
	// launch test uses; its args are asserted here like every other adapter's.
	codex: (home) => readCodexEntry(home),
	cursor: (home) => JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.heimdall,
	"gemini-cli": (home) => JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.heimdall,
	deepseek: (home) => JSON.parse(readFileSync(join(home, ".deepseek", "settings.json"), "utf8")).mcpServers.heimdall,
	// opencode stores the whole argv in `command`
	opencode: (home) => {
		const e = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8")).mcp.heimdall;
		return { command: e.command[0], args: e.command.slice(1) };
	},
};

for (const [harness, entryOf] of Object.entries(MCP_HARNESSES)) {
	test(`issue #11: ${harness} MCP entry carries the mcp subcommand`, () => {
		const { home, cleanup } = freshHome();
		try {
			installAdapter(harness, home);
			const entry = entryOf(home);
			assert.ok(entry.command, `${harness}: entry has no command`);
			assert.ok(entry.args.length > 0, `${harness}: entry has no args`);
			assert.ok(
				entry.args.includes("mcp"),
				`${harness}: args ${JSON.stringify(entry.args)} would print usage and exit — the CLI serves MCP only for the explicit 'mcp' command`,
			);
		} finally { cleanup(); }
	});
}

test("issue #11: claude-code MCP entry actually serves a JSON-RPC initialize", async () => {
	const { home, cleanup } = freshHome();
	try {
		installAdapter("claude-code", home);
		const entry = MCP_HARNESSES["claude-code"](home);
		const { out, timedOut } = await initializeOver(entry.command, entry.args);
		assert.equal(timedOut, false, `no MCP reply within 15s; got: ${out.slice(0, 400)}`);
		assert.doesNotMatch(out, /usage: heimdall/i);
	} finally { cleanup(); }
});

// The map above is a literal; on its own it asserts nothing about the product.
// This derives the real answer by running every known adapter and checking which
// ones actually wrote an MCP entry, so gaining a writer (or losing one) without
// updating the map fails here instead of reading as coverage.
test("issue #11: the harness map lists exactly the adapters that register MCP", () => {
	const registered = KNOWN_HARNESSES.filter((h) => {
		const home = mkdtempSync(join(tmpdir(), "heimdall-known-"));
		try {
			installAdapter(h, home);
			return [
				join(home, ".claude", "settings.json"),
				join(home, ".codex", "config.toml"),
				join(home, ".cursor", "mcp.json"),
				join(home, ".gemini", "settings.json"),
				join(home, ".deepseek", "settings.json"),
				join(home, ".config", "opencode", "opencode.json"),
			].some((p) => existsSync(p));
		} finally { rmSync(home, { recursive: true, force: true }); }
	});

	assert.deepEqual(
		registered.sort(),
		Object.keys(MCP_HARNESSES).sort(),
		"an adapter registers MCP but is not exercised above (or vice versa) — the map has drifted from the product",
	);
});
