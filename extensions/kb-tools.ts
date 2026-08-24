/**
 * kb-tools — expose Heimdall memory as first-class Pi tools:
 * ranked verified search, insert, index sync. Backends: the `heimdall`
 * CLI (npm @arihantdeva/heimdall) which fronts graft per-repo graphs
 * + the global bge-m3 semantic index.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Route through the installed heimdall CLI; fall back to repo bin scripts.
const PKG_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const kbScript = (name: string): string => join(PKG_BIN, name);
const HEIMDALL = process.env.HEIMDALL_BIN ?? "heimdall";

const run = (cmd: string, args: string[], signal?: AbortSignal): Promise<{ ok: boolean; text: string }> =>
	new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ ok: false, text: "ERROR: aborted" });
			return;
		}
		execFile(cmd, args, { timeout: 300_000, maxBuffer: 2_000_000, signal }, (err, out) => {
			resolve(err ? { ok: false, text: `ERROR: ${err.message}\n${out}` } : { ok: true, text: out });
		});
	});

export default function kbToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "kb_search",
		label: "Knowledge Search",
		description:
			"Heimdall memory search: ranked, verified hits across ALL repos on this machine (lexical code graph + semantic embeddings). Use BEFORE any implementation/fix/research and INSTEAD of ls/grep/find chains for locating prior work. Every hit carries a trust verdict (STRONG/WEAK) verified against the live filesystem.",
		promptSnippet: "Search machine knowledge for existing work before implementing",
		promptGuidelines: [
			"Use kb_search BEFORE any implementation, feature, or fix to find work that already exists in another project/directory — the cross-project reuse gate.",
			"kb_search returns ranked candidates; a top hit pointing at an existing path means reuse, not redo.",
			"kb_search hits are index-verified anchors: go straight to the referenced paths. Do NOT re-locate them with ls/find/grep — that rediscovery is exactly the redundancy this tool exists to prevent.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What you're about to build or look for" }),
			n: Type.Optional(Type.Number({ description: "Max results (default 6)" })),
			scope: Type.Optional(Type.String({ description: "Filter by directory/path substring, e.g. poker, job" })),
		}),
		async execute(_id, params, signal) {
			const args = [params.query, "-n", String(params.n ?? 6)];
			if (params.scope) args.push("--scope", params.scope);
			const { ok, text } = await run(HEIMDALL, ["search", ...args], signal);
			return { content: [{ type: "text", text }], details: { ok } };
		},
	});
	pi.registerTool({
		name: "kb_insert",
		label: "Knowledge Insert",
		description:
			"Record reusable work into Heimdall memory: title (anchor), body (path + what/why), keywords. Mandatory AFTER completing reusable work (fix, pattern, decision, gotcha) so future sessions find and reuse it.",
		promptSnippet: "Record completed reusable work into machine memory",
		promptGuidelines: [
			"Use kb_insert after completing any reusable work: fix, pattern, decision, or gotcha.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short anchor title, e.g. '<project> <what>'" }),
			body: Type.String({ description: "Path + what/why, tested-on details" }),
			keywords: Type.Array(Type.String({ description: "Search keywords" })),
		}),
		async execute(_id, params, _signal) {
			const args = ["insert", "--title", params.title, "--body", params.body];
			for (const k of params.keywords ?? []) args.push("--keywords", k);
			const { ok, text } = await run(HEIMDALL, args);
			return { content: [{ type: "text", text }], details: { ok } };
		},
	});

	pi.registerTool({
		name: "kb_sync",
		label: "Knowledge Sync",
		description:
			"Converge Heimdall indexes with the filesystem (incremental, cheap): reconciles queued edit hints against disk so moved/deleted files re-anchor or get pruned. Run after bulk file operations or before important searches.",
		promptSnippet: "Refresh knowledge index from session edit logs",
		parameters: Type.Object({}),
		async execute() {
			const { ok, text } = await run(HEIMDALL, ["reconcile"]);
			return { content: [{ type: "text", text }], details: { ok } };
		},
	});
}
