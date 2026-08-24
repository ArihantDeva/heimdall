// mcp-server — Model Context Protocol stdio server for Heimdall.
// Newline-delimited JSON-RPC 2.0 per MCP spec (2024-11-05 transport).
// Tools map 1:1 onto the CLI: kb_search → search, kb_insert → insert,
// kb_sync → reconcile. Zero dependencies; stdout carries ONLY protocol
// frames (all diagnostics go to stderr).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEIMDALL_JS = join(BIN_DIR, "heimdall.js");
let VERSION = "0.0.0";
try {
	VERSION = JSON.parse(readFileSync(join(BIN_DIR, "..", "package.json"), "utf8")).version ?? VERSION;
} catch { /* dev checkout without package.json at root */ }

const TOOLS = [
	{
		name: "kb_search",
		description:
			"Heimdall memory search: ranked, verified hits across ALL repos on this machine " +
			"(lexical code graph + semantic embeddings). Use BEFORE any implementation/fix/research " +
			"and INSTEAD of ls/grep/find chains. Hits carry trust verdicts (STRONG/WEAK) verified against disk.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to look for in machine memory" },
				n: { type: "number", description: "Max results (default 6)" },
			},
			required: ["query"],
		},
		run: (a) => {
			if (typeof a.query !== "string" || !a.query.trim()) return Promise.resolve({ code: 1, text: "ERROR: query is required and must be a non-empty string" });
			return cli(["search", String(a.query), "-n", String(Math.max(1, Math.min(50, Number(a.n) || 6)))]);
		},
	},
	{
		name: "kb_insert",
		description:
			"Record reusable work into Heimdall memory (title anchor + body path/what/why + keywords). " +
			"Mandatory after completing reusable work so future sessions reuse it.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				body: { type: "string" },
				keywords: { type: "string", description: "Comma-separated keywords" },
			},
			required: ["title", "body"],
		},
		run: (a) => {
			if (typeof a.title !== "string" || !a.title.trim() || typeof a.body !== "string" || !a.body.trim()) {
				return Promise.resolve({ code: 1, text: "ERROR: title and body are required non-empty strings" });
			}
			return cli([
				"insert", "--title", String(a.title), "--body", String(a.body),
				...(a.keywords ? ["--keywords", String(a.keywords)] : []),
			]);
		},
	},
	{
		name: "kb_sync",
		description:
			"Converge Heimdall indexes with the filesystem (incremental): re-anchors moved files, prunes dead paths.",
		inputSchema: { type: "object", properties: {} },
		run: () => cli(["reconcile"]),
	},
];

function cli(args, { timeoutMs = 120_000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [HEIMDALL_JS, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", () => {});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, text: out.trim() || "(no output)" });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: 1, text: `spawn failed: ${err.message}` });
		});
	});
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
	if (msg.method === "initialize") {
		return ok(msg.id, {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "heimdall", version: VERSION },
		});
	}
	if (msg.method === "notifications/initialized") return null;
	if (msg.method === "tools/list") {
		return ok(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
	}
	if (msg.method === "tools/call") {
		const tool = TOOLS.find((t) => t.name === msg.params?.name);
		if (!tool) {
			return ok(msg.id, {
				content: [{ type: "text", text: `Unknown tool: ${msg.params?.name}. Available: ${TOOLS.map((t) => t.name).join(", ")}` }],
				isError: true,
			});
		}
		try {
			const { code, text } = await tool.run(msg.params?.arguments ?? {});
			return ok(msg.id, { content: [{ type: "text", text }], isError: code !== 0 });
		} catch (e) {
			return ok(msg.id, { content: [{ type: "text", text: `tool failed: ${e.message}` }], isError: true });
		}
	}
	if (msg.id !== undefined && msg.method?.startsWith("prompts/")) return err(msg.id, -32601, "prompts not supported");
	if (msg.id === undefined) return null; // notifications never get replies (JSON-RPC 2.0)
	return err(msg.id, -32601, `method not found: ${msg.method}`);
}

export async function serveMcp(input = process.stdin, output = process.stdout) {
	let buf = "";
	for await (const chunk of input) {
		buf += chunk.toString();
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				output.write(JSON.stringify(err(null, -32700, "parse error")) + "\n");
				continue;
			}
			const res = await handle(msg);
			if (res) output.write(JSON.stringify(res) + "\n");
		}
	}
}
