import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
// Protocol: MCP 2024-11-05, newline-delimited JSON over stdin/stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const HEIMDALL = process.platform === "win32" ? test.skip : "node";

function rpc(msgs, { timeout = 30_000, env = process.env } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(repo, "bin", "heimdall.js"), "mcp"], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buf = "";
		const out = [];
		const timer = setTimeout(() => { child.kill(); reject(new Error("mcp timeout; got: " + out.length)); }, timeout);
		child.stdout.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (!line) continue;
				try { out.push(JSON.parse(line)); } catch {}
			}
			if (out.length >= msgs.filter((m) => !m._notify).length) {
				clearTimeout(timer);
				child.kill();
				resolve(out);
			}
		});
		child.stderr.on("data", () => {});
		for (const m of msgs) child.stdin.write(JSON.stringify(m) + "\n");
	});
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

test("mcp: initialize responds with protocol version + server info", async () => {
	const [res] = await rpc([INIT]);
	assert.equal(res.id, 1);
	assert.equal(res.result.protocolVersion, "2024-11-05");
	assert.equal(res.result.serverInfo.name, "heimdall");
});

test("mcp: tools/list exposes search, insert, sync", async () => {
	const [, res] = await rpc([INIT, LIST]);
	assert.equal(res.id, 2);
	const names = res.result.tools.map((t) => t.name).sort();
	assert.deepEqual(names, ["kb_insert", "kb_search", "kb_sync"]);
	assert.ok(res.result.tools.every((t) => typeof t.description === "string" && t.inputSchema.type === "object"));
});

test("mcp: tools/call kb_search returns text content", async () => {
	// Hermetic HOME with a fake graft binary + one indexed repo: same contract
	// (non-empty text) without loading the real semantic layer (bge-m3 model
	// load exceeds bun's 5s default test timeout; sibling tests use this pattern).
	const home = mkdtempSync(join(tmpdir(), "heimdall-mcp-kbs-"));
	try {
		const graft = join(home, ".local", "bin", "graft");
		mkdirSync(dirname(graft), { recursive: true });
		copyFileSync(join(repo, "tests", "fixtures", "fake-graft.sh"), graft);
		chmodSync(graft, 0o755);
		mkdirSync(join(home, "Repos", "example", "graft"), { recursive: true });
		const CALL = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kb_search", arguments: { query: "reconcile graph convergence" } } };
		const res = await rpc([INIT, LIST, CALL], { env: { ...process.env, HOME: home, GRAFT: undefined, HEIMDALL_REPOS: undefined }, timeout: 30_000 });
		const call = res.find((r) => r.id === 3);
		assert.ok(call, "no response for call");
		assert.equal(call.result.isError ?? false, false);
		assert.ok(Array.isArray(call.result.content));
		// Contract: non-empty text content. (Bracketed hit lines are env-dependent —
		// a machine with zero indexed repos validly returns guidance text.)
		assert.ok(typeof call.result.content[0]?.text === "string" && call.result.content[0].text.length > 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("mcp: kb_search on fresh machine (no graft, no ~/.heimdall) still returns content, not an error", async () => {
	const fresh = mkdtempSync(join(tmpdir(), "heimdall-fresh-"));
	try {
		const CALL = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "kb_search", arguments: { query: "anything" } } };
		const res = await rpc([INIT, CALL], { env: { ...process.env, HOME: fresh, GRAFT: "", HEIMDALL_REPOS: "" }, timeout: 30_000 });
		const call = res.find((r) => r.id === 5);
		assert.ok(call, "no response for call");
		assert.equal(call.result.isError ?? false, false, `expected success, got: ${JSON.stringify(call.result.content)}`);
		assert.ok(Array.isArray(call.result.content) && call.result.content[0]?.text?.length > 0, "empty content");
	} finally {
		rmSync(fresh, { recursive: true, force: true });
	}
});

test("mcp: kb_search with graft binary but zero indexed repos → content, not an error", async () => {
	const fresh = mkdtempSync(join(tmpdir(), "heimdall-norepos-"));
	mkdirSync(join(fresh, ".local", "bin"), { recursive: true });
	writeFileSync(join(fresh, ".local", "bin", "graft"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	try {
		const CALL = { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "kb_search", arguments: { query: "anything" } } };
		const res = await rpc([INIT, CALL], { env: { ...process.env, HOME: fresh, HEIMDALL_REPOS: "" }, timeout: 30_000 });
		const call = res.find((r) => r.id === 6);
		assert.ok(call, "no response for call");
		assert.equal(call.result.isError ?? false, false, `expected success, got: ${JSON.stringify(call.result.content)}`);
	} finally {
		rmSync(fresh, { recursive: true, force: true });
	}
});

test("mcp: unknown tool → isError with message", async () => {
	const CALL = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } };
	const res = await rpc([INIT, CALL]);
	const call = res.find((r) => r.id === 4);
	assert.equal(call.result.isError, true);
	assert.match(call.result.content[0].text, /unknown tool/i);
});
