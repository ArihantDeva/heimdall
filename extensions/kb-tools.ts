/**
 * kb-tools — expose the machine knowledge base (Graft) as first-class
 * Pi tools: ranked search, verified query, insert, edit-log sync.
 * Backends: ~/knowledge-base/kb-search.sh, graft CLI, sync-edits.sh.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Scripts ship inside this package; legacy ~/knowledge-base copies are fallback.
const PKG_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const kbScript = (name: string): string => {
	const pkg = join(PKG_BIN, name);
	if (existsSync(pkg)) return pkg;
	return join(process.env.HOME ?? "", "knowledge-base", name);
};

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
			"Ranked cross-project knowledge search over the machine index (~/knowledge-base + Graft graph). Use BEFORE starting any implementation to find existing work: returns top-k candidate titles with relevance scores. Prefer this over graft query for discovery; use --scope to filter by directory.",
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
			explore: Type.Optional(Type.Boolean({ description: "Also walk the graph for related knowledge" })),
		}),
		async execute(_id, params, signal) {
			const args = [params.query, "-n", String(params.n ?? 6)];
			if (params.scope) args.push("--scope", params.scope);
			if (params.explore) args.push("--explore");
			const { ok, text } = await run("bash", [kbScript("kb-search.sh"), ...args], signal);
			return { content: [{ type: "text", text }], details: { ok } };
		},
	});
	pi.registerTool({
		name: "kb_insert",
		label: "Knowledge Insert",
		description:
			"Record reusable work into the Graft memory graph: title (anchor), body (path + what/why), keywords. Mandatory AFTER completing reusable work (fix, pattern, decision, gotcha) so future sessions find and reuse it.",
		promptSnippet: "Record completed reusable work into machine memory",
		promptGuidelines: [
			"Use kb_insert after completing any reusable work: fix, pattern, decision, or gotcha.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short anchor title, e.g. '<project> <what>'" }),
			body: Type.String({ description: "Path + what/why, tested-on details" }),
			keywords: Type.Array(Type.String({ description: "Search keywords" })),
		}),
		async execute(_id, params, signal) {
			const args = ["insert", "--title", params.title, "--body", params.body];
			for (const k of params.keywords ?? []) args.push("--keyword", k);
			const { ok, text } = await run("graft", args);
			return { content: [{ type: "text", text }], details: { ok } };
		},
	});

	pi.registerTool({
		name: "kb_sync",
		label: "Knowledge Sync",
		description:
			"Refresh the knowledge index from agent session edit logs (incremental, cheap): reads write/edit tool-call paths since the last sync, updates .inventory.tsv, and replaces graft nodes for edited files. Run after working sessions or before significant new work.",
		promptSnippet: "Refresh knowledge index from session edit logs",
		parameters: Type.Object({}),
		async execute() {
			const { ok, text } = await run("bash", [kbScript("sync-edits.sh")]);
			return { content: [{ type: "text", text }], details: { ok } };
		},
	});
}
