// mcp-kind-misuse.test.mjs — the kind param is exposed, forwarded, and misuse is
// an error.
//
// WHY REWRITTEN (measured 2026-10-23): this file used to assert on the SOURCE
// TEXT of bin/lib/mcp-server.mjs with regexes. Deleting the entire
// `args.push("--kind", ...)` forwarding line — while leaving the string
// "--kind" in a comment — kept all three tests passing. Source-text assertions
// cannot distinguish "the code does this" from "the code mentions this", so they
// pass forever while the behaviour drifts away underneath them.
//
// These tests now drive the real MCP server over its real JSON-RPC protocol, so
// they observe the schema a caller sees and the dispatch that actually happens.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { serveMcp } from "../bin/lib/mcp-server.mjs";

// Feed one JSON-RPC line and collect the reply. serveMcp is the real entry point
// (it is what `heimdall mcp` calls), so this exercises parsing, dispatch and
// serialisation rather than re-reading the source.
async function rpc(method, params) {
	const req = { jsonrpc: "2.0", id: 1, method, params };
	let out = "";
	const output = { write: (s) => { out += s; return true; } };
	await serveMcp(Readable.from([JSON.stringify(req) + "\n"]), output);
	const line = out.trim().split("\n").filter(Boolean).pop();
	return JSON.parse(line);
}

const searchTool = async () => {
	const res = await rpc("tools/list", {});
	return res.result.tools.find((t) => t.name === "kb_search");
};

test("kb_search advertises the kind enum in its input schema", async () => {
	// Read the schema the SERVER publishes, not the text that defines it.
	const tool = await searchTool();
	assert.ok(tool, "kb_search must be listed by tools/list");
	const kind = tool.inputSchema.properties.kind;
	assert.ok(kind, "kind must appear in the input schema");
	assert.equal(kind.type, "string", "kind must be a string");
	assert.deepEqual(kind.enum, ["person", "decision", "fact", "code", "all"],
		"kind enum drifted from the values kb-search.sh accepts");
	assert.ok(kind.description && kind.description.length > 20,
		"kind needs a description: an MCP caller has nothing else to go on");
});

test("a valid kind reaches the CLI and changes what is searched", async () => {
	// The forwarding claim is only observable by its EFFECT. `--kind person`
	// routes to the people store, whose output header names the leg; the default
	// code search does not.
	const res = await rpc("tools/call", {
		name: "kb_search", arguments: { query: "Jules", n: 1, kind: "person" },
	});
	const text = (res.result?.content ?? []).map((c) => c.text).join("\n");
	assert.ok(text.length > 0, "kb_search returned nothing at all");
	assert.match(text, /people/i,
		`kind=person did not route to the people store. Got: ${text.slice(0, 160)}`);
});

test("an unknown kind is rejected by the CLI, collapsed to isError", async () => {
	// The documented collapse: every nonzero exit becomes isError:true, so the
	// caller cannot tell exit 2 (bad kind) from any other failure. Pinned as a
	// KNOWN LIMITATION so it stays a recorded decision rather than a surprise.
	const res = await rpc("tools/call", {
		name: "kb_search", arguments: { query: "anything", n: 1, kind: "not-a-real-kind" },
	});
	assert.equal(res.result?.isError, true,
		"an invalid kind must surface as isError:true at the MCP layer");
});
