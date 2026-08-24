/**
 * kb-orient — orient the agent with machine knowledge right after the FIRST
 * user prompt of a session (not at session start). Fires on the harness
 * `input` event, transforms the first user message to append a compact
 * knowledge block: top graft retrieve hits + a related edge walk (explore).
 * Any failure degrades silently — never blocks or breaks the user's prompt.
 *
 * Intentionally not session-start: orientation should react to what the user
 * actually asks, not burn context on speculative injection.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = process.env.HOME ?? "";

const run = (cmd: string, args: string[], timeoutMs = 8_000): Promise<string> =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 2_000_000 }, (err, out) => {
			resolve(err ? "" : out);
		});
	});

/** Compact one retrieve/explore result: score, title. */
const formatHit = (r: Record<string, unknown>): string => {
	const title = String(r.title ?? r.id_hex ?? "?");
	const score = r.score != null ? ` [${Number(r.score).toFixed(2)}]` : "";
	return `${title}${score}`;
};

export default function kbOrientExtension(pi: ExtensionAPI): void {
	// Per-process (session) flag: enrich only the first user input.
	let oriented = false;

	pi.on("input", async (event) => {
		const text = event.text?.trim() ?? "";
		if (!text || text.startsWith("/")) return { action: "continue" }; // commands don't consume the flag
		if (oriented) return { action: "continue" };
		oriented = true; // fire once even if retrieval fails

		try {
			// Cap total retrieval time — a hung graft must never stall the first prompt.
			const [retrieveOut, exploreOut] = await Promise.race([
				Promise.all([
					run("heimdall", ["search", text, "-n", "3"]),
					run("heimdall", ["search", text, "-n", "6"]),
				]),
				new Promise<[string, string]>((resolve) => setTimeout(() => resolve(["", ""]), 2500)),
			]);

			const hits: string[] = [];
			try {
				const ret = JSON.parse(retrieveOut).result ?? {};
				for (const r of ret.results ?? ret.nodes ?? []) hits.push(formatHit(r));
			} catch { /* ignore malformed */ }
			try {
				const ex = JSON.parse(exploreOut).result ?? {};
				for (const r of ex.nodes ?? ex.results ?? []) hits.push(formatHit(r));
			} catch { /* ignore malformed */ }

			if (hits.length === 0) return { action: "continue" };

			// Dedupe by title, keep first (retrieve before explore).
			const seen = new Set<string>();
			const uniq: string[] = [];
			for (const h of hits) {
				if (!h) continue;
				const key = h.split(" [")[0];
				if (seen.has(key)) continue;
				seen.add(key);
				uniq.push(h);
			}

			const block =
				`\n\n[Context: machine knowledge — related prior work, consult if relevant]\n` +
				uniq.slice(0, 6).map((h) => `- ${h}`).join("\n");

			return { action: "transform", text: text + block };
		} catch {
			return { action: "continue" };
		}
	});
}
