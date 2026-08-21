/**
 * kb-autosync — emit path hints for the reconciler. That is its entire job.
 *
 * This used to infer graph mutations from tool calls: regex-parse the bash
 * command, decide it was a move/remove/modify, then delete and re-insert graft
 * nodes directly from the hook. Three properties made that unfixable:
 *
 *   - It could only see writes it recognised. `git checkout`, `make`, a script,
 *     an IDE save, or a second agent were structurally invisible.
 *   - Every hook process wrote the graph concurrently, so two agents touching
 *     one file raced between the delete and the insert.
 *   - A misparse wrote WRONG data, because the command text was treated as the
 *     description of what changed.
 *
 * Now a hook only ever says "look at this path". It is never believed: the
 * reconciler reads the file itself and makes the graph match. A hint that is
 * wrong, duplicated, or missing therefore cannot corrupt anything — a missed
 * one is caught by the watcher, and failing that by the periodic audit.
 *
 * Consequences worth stating plainly: appending a line is all this does, so it
 * is non-blocking and needs no lock, no sqlite, no graft, and no debounce.
 * N agents hammering one file produce N cheap appends that collapse to one
 * queue row.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = homedir();
const HINTS = join(HOME, ".heimdall", "hints.jsonl");

const EDIT_TOOLS = new Set(["edit", "write", "hashline_edit"]);

/** Paths the graph does not track. Kept in sync with reconcile.mjs skipPath. */
export const skip = (p: string): boolean => {
	if (!p.startsWith("/")) return true;
	if (p.startsWith("/tmp/") || p.startsWith("/private/tmp/")) return true;
	if (p.startsWith(`${HOME}/.`) || p.startsWith(`${HOME}/Library/`)) return true;
	return /\/(node_modules|\.git|__pycache__|\.venv|venv|dist|build|DerivedData|Pods|\.build)\//.test(p);
};

/**
 * Append a hint. Under O_APPEND a short line is written atomically, so
 * concurrent hooks cannot interleave; a torn line would be dropped on ingest
 * and the path recovered by the audit anyway.
 */
export const hint = (path: string, reason: string): void => {
	if (skip(path)) return;
	try {
		mkdirSync(dirname(HINTS), { recursive: true });
		appendFileSync(HINTS, `${JSON.stringify({ path, reason, at: Date.now() })}\n`);
	} catch { /* a lost hint costs a delay, never correctness */ }
};

/**
 * Absolute path tokens in a bash command. Deliberately over-inclusive: a false
 * positive costs one stat, and a path that turns out not to exist is simply
 * recorded as absent. There is no attempt to determine what the command DID.
 */
export const extractPaths = (command: string): string[] => {
	const re = /"([^"]*\/[^"]*)"|'([^']*\/[^']*)'|((?:~|\/)[a-zA-Z0-9_\-./]+)/g;
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		const raw = m[1] || m[2] || m[3] || "";
		const p = raw.startsWith("~/") ? join(HOME, raw.slice(2)) : raw;
		if (p.startsWith("/") && !out.includes(p)) out.push(p);
	}
	return out;
};

export default function kbAutosyncExtension(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (event.isError) return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (EDIT_TOOLS.has(event.toolName)) {
			const p = String(input.path ?? input.file_path ?? "");
			if (p) hint(p, `tool:${event.toolName}`);
			return;
		}
		if (event.toolName === "bash") {
			for (const p of extractPaths(String(input.command ?? ""))) hint(p, "bash");
		}
	});

	pi.on("user_bash", (event) => {
		for (const p of extractPaths(event.command)) hint(p, "user_bash");
	});
}
