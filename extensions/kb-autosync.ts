/**
 * kb-autosync — self-healing graph: update nodes the moment ANY change lands
 * in a session. Hooks `tool_result` (edit/write/hashline_edit/bash) and
 * `user_bash`. On success, debounce-refresh:
 *   - edit/write/hashline_edit  → refresh that path's node
 *   - bash mv/git mv/rsync      → file: rehome nodes (kb-rehome.sh);
 *                                dir: bulk prefix-rewrite all nodes under it
 *   - bash rm/rmdir/trash/git rm → log + remove nodes anchored at the path
 *   - bash cp/touch/sed/tee/redirect/etc → refresh existing file nodes
 * Same semantics as sync-edits.sh; deterministic (sqlite title/body lookup,
 * never graft query top-1). Non-blocking: graft ops run on timers, never in
 * the handler. Failures logged to ~/.graft/kb-autosync.log.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = homedir();
const TSV = join(HOME, "knowledge-base", ".inventory.tsv");
const LOG = join(HOME, ".graft", "kb-autosync.log");
const STALE_LOG = join(HOME, "knowledge-base", "stale-removals.log");
const DB = join(HOME, ".graft", "profiles", "default", "graft.db");

const EDIT_TOOLS = new Set(["edit", "write", "hashline_edit"]);

// Track the session's working directory from `cd` segments so relative paths
// in later bash commands resolve deterministically (tool_result has no cwd).
let sessionCwd = process.cwd();

export const updateCwd = (command: string): void => {
	for (const seg of command.split(/&&|;/)) {
		const mm = seg.trim().match(/^cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/);
		if (!mm) continue;
		let d = mm[2] || mm[3] || mm[4] || "";
		if (d.startsWith("~/")) d = join(HOME, d.slice(2));
		if (d === "~") d = HOME;
		sessionCwd = d.startsWith("/") ? d : join(sessionCwd, d);
	}
};

export const resolvePath = (p: string): string => {
	if (p.startsWith("~/") || p === "~") return join(HOME, p.slice(2));
	if (p.startsWith("/Users/")) return p;
	if (p.startsWith("/")) return p;
	return join(sessionCwd, p);
};

// bash commands that can mutate the filesystem
const MOVE = new Set(["mv", "git", "rsync"]);
const REMOVE = new Set(["rm", "rmdir", "trash", "git"]);
const COPY = new Set(["cp", "ditto", "rsync"]);
const MODIFY = new Set([
	"touch", "sed", "tee", "mkdir", "ln", "chmod", "chown", "install",
	"truncate", "dd", "tar", "unzip", "gunzip", "gzip", "xattr", "osascript",
	"jq", "plutil", "defaults",
]);
// interpreters that MIGHT write but usually run read-only — excluding them avoids
// junk edited nodes; a redirect (>) on the segment still catches the write
const MAYBE_WRITE = new Set(["python", "python3", "node", "perl", "ruby", "bash", "sh", "zsh", "echo", "printf"]);
const SKIP_PREFIX = [
	"cd", "ls", "cat", "grep", "head", "tail", "less", "more", "echo", "find",
	"wc", "sort", "uniq", "diff", "pwd", "which", "file", "du", "df", "ps",
	"history", "env", "printenv", "git", "sqlite3",
];

export const log = (msg: string) => {
	try { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
};

export const skip = (p: string): boolean => {
	if (p.startsWith("/tmp/") || p.startsWith("/private/tmp/")) return true;
	if (p.startsWith(`${HOME}/.`)) return true;
	if (p.startsWith(`${HOME}/.pi/`) || p.startsWith(`${HOME}/.local/`) ||
		p.startsWith(`${HOME}/.graft/`) || p.startsWith(`${HOME}/Library/`)) return true;
	if (p.startsWith(`${HOME}/knowledge-base/`) || p.startsWith(`${HOME}/Desktop/Archives/`)) return true;
	return false;
};

const run = (cmd: string, args: string[], timeoutMs = 20_000): Promise<string> =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, out) => {
			resolve(err ? "" : out);
		});
	});

/** Extract /Users or ~/ path tokens from a bash command, in order, deduped. */
export const extractPaths = (command: string): string[] => {
	const re = /"([^"]*\/Users\/[^"]*)"|'([^']*\/Users\/[^']*)'|(\/Users\/[a-zA-Z0-9_\-.\/]+)|(~\/[a-zA-Z0-9_\-.\/]+)/g;
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		const raw = m[1] || m[2] || m[3] || m[4] || "";
		const p = raw.startsWith("~/") ? join(HOME, raw.slice(2)) : raw;
		if (p.startsWith("/Users/") && !out.includes(p)) out.push(p);
	}
	return out;
};

const MUTATORS = new Set([...MOVE, ...REMOVE, ...COPY, ...MODIFY]);

/** Find the first command segment (split on &&/;) that is a known mutator. */
export const firstMutatingSegment = (command: string): { word: string; segment: string } | null => {
	const segs = command.split(/&&|;/);
	for (const seg of segs) {
		let c = seg.trim().replace(/^(sudo|time|env|command|nohup|nice)\s+/g, "");
		const w = c.split(/\s+/)[0] || "";
		if (!w) continue;
		if (w === "git") {
			const sub = (c.match(/\bgit\s+(mv|rm|cp)\s+/) || [])[1];
			if (sub) return { word: `git ${sub}`, segment: c };
			continue; // other git ops: skip
		}
		if (MUTATORS.has(w)) return { word: w, segment: c };
		// interpreter or redirect: only a mutation if the segment writes (redirect/tee)
		if (MAYBE_WRITE.has(w) && />>?|tee\b/.test(c)) return { word: w, segment: c };
	}
	return null;
};

/** Shell-aware tokenizer: "quoted"/'quoted'/plain tokens. */
export const shellTokens = (s: string): string[] => {
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
	return out;
};

const FILE_EXT = /^[a-zA-Z0-9_\-.]+\.[a-z0-9]{1,8}$/;
const pathLike = (t: string): boolean =>
	t.startsWith("/") || t.startsWith("~") || t.startsWith("./") ||
	t.includes("/") || FILE_EXT.test(t);

/** Classify a bash command into mutations: {kind, src?, dst?, paths[]}. */
export const classifyCommand = (command: string): { kind: string; src?: string; dst?: string; paths: string[] } | null => {
	const hit = firstMutatingSegment(command);
	if (!hit) return null;
	const tokens = shellTokens(hit.segment).slice(hit.word.split(" ").length).filter((t) => !t.startsWith("-"));
	const resolve = (t: string) => resolvePath(t.startsWith("'") || t.startsWith("\"") ? t.slice(1, -1) : t);
	const w = hit.word;
	// git subcommand is already wordified by firstMutatingSegment (git mv/git rm/git cp)
	if (w === "git mv" || w === "mv") {
		// mv a b dir/ (multi-source) → all srcs move INTO the LAST token (dir).
		// Only the FIRST src is rehomed here; additional srcs' nodes are left for
		// the backstop stale-scan (they self-heal there) — documented limitation.
		if (tokens.length < 2) return null;
		const dst = tokens[tokens.length - 1];
		const src = tokens[0];
		return { kind: "move", src: resolve(src), dst: resolve(dst), paths: [resolve(src), resolve(dst)] };
	}
	if (w === "git rm" || w === "rm" || w === "rmdir" || w === "trash") {
		const paths = tokens.map(resolve).filter((p) => p.startsWith("/Users/") && !skip(p));
		return paths.length ? { kind: "remove", paths } : null;
	}
	if (w === "git cp" || w === "cp" || w === "ditto") {
		const [src, dst] = tokens;
		if (!src || !dst) return null;
		return { kind: "copy", src: resolve(src), dst: resolve(dst), paths: [resolve(src), resolve(dst)] };
	}
	if (w === "rsync") {
		const ps = tokens.filter(pathLike).map(resolve).filter((p) => p.startsWith("/Users/"));
		return ps.length >= 2 ? { kind: "move", src: ps[0], dst: ps[1], paths: ps } : null;
	}
	if (MODIFY.has(w) || MAYBE_WRITE.has(w) || />>?|tee\b/.test(hit.segment)) {
		const ps = tokens
			.filter((t) => pathLike(t) && !/^s\/.*\/[a-z]*$/.test(t)) // drop sed s/// expressions
			.map(resolve)
			.filter((p) => p.startsWith("/Users/") && !skip(p));
		return ps.length ? { kind: "modify", paths: ps } : null;
	}
	return null;
};

/** Escape LIKE wildcards (% _) in a path for sqlite LIKE — paths can contain them.
 *  Must pair with ESCAPE '\\' in the query — backslash does NOT escape by default. */
const likeEsc = (s: string): string => s.replace(/[%_\\]/g, (c) => `\\${c}`);

/** keywords of a node (comma-joined) */
export const nodeKeywordsAt = async (id: string): Promise<string[]> => {
	const out = await run("sqlite3", [DB,
		`SELECT group_concat(k.text) FROM node_keywords nk JOIN keywords k ON k.id = nk.keyword_id WHERE nk.node_id = x'${id.replace(/[^0-9a-fA-F]/g, "")}';`]);
	return (out || "").split(",").map((s) => s.trim()).filter(Boolean);
};

/** ids of nodes anchored at a path (body OR title starts with it). */
export const nodeIdsAt = async (p: string): Promise<string[]> => {
	const esc = likeEsc(p).replace(/'/g, "''");
	const out = await run("sqlite3", [DB, `SELECT hex(id) FROM nodes WHERE body LIKE '${esc}%' ESCAPE '\\' OR title LIKE '${esc}%' ESCAPE '\\';`]);
	return out.split(/\s+/).filter(Boolean);
};

const refresh = async (p: string): Promise<void> => {
	// only refresh real files — mkdir/ln/tee on a directory must not create junk nodes
	if (!p.startsWith("/Users/")) return;
	try {
		if (!existsSync(p) || !statSync(p).isFile()) return;
	} catch { return; } // ENOENT race-safe
	const rel = p.slice(HOME.length + 1);
	try {
		if (existsSync(TSV)) {
			// grep -F (no -q): rc=0 match → output is the line; rc=1 no-match → "".
			// (grep -qF returns "" on BOTH match and no-match, so it can't guard.)
			const hit = await run("grep", ["-F", `${rel}\t`, TSV]);
			if (!hit) {
				const d = new Date().toISOString().slice(0, 10);
				appendFileSync(TSV, `${rel}\tedited ${d} (auto-sync from agent edit log)\tauto,edited\n`);
			}
		}
		const esc = likeEsc(rel).replace(/'/g, "''");
		const ids = await run("sqlite3", [DB, `SELECT hex(id) FROM nodes WHERE title LIKE '${esc} — edited %' ESCAPE '\\';`]);
		for (const id of ids.split(/\s+/).filter(Boolean)) {
			await run("graft", ["delete", id]);
		}
		const d = new Date().toISOString().slice(0, 10);
		await run("graft", ["insert", "--title", `${rel} — edited ${d}`,
			"--body", `${p} — auto-refreshed from agent edit log ${d}`,
			"--keyword", "auto", "--keyword", "edited"]);
	} catch (err) {
		log(`refresh failed ${p}: ${err instanceof Error ? err.message : String(err)}`);
	}
};

const removeAnchored = async (p: string): Promise<void> => {
	try {
		// boundary-aware: only nodes anchored at p exactly (path boundary), not
		// prefix siblings like p.pyc or p2. The LIKE query over-matches (any
		// body starting with the string), so filter the candidates here.
		for (const id of await nodeIdsAt(p)) {
			const g = await run("graft", ["get", id]);
			let title = id, body = "";
			try {
				const r = JSON.parse(g).result ?? {};
				title = r.title ?? id; body = r.body ?? "";
			} catch { /* ignore */ }
			// boundary-aware: only nodes anchored at p exactly (path boundary), not
			// prefix siblings like p.pyc or p2. The LIKE query over-matches (any
			// body starting with the string), so filter the candidates here with a
			// TRUE boundary check: after p must come a separator, space, or EOS.
			const isAnchored = (s: string): boolean => {
				if (!s.startsWith(p)) return false;
				const after = s.slice(p.length);
				return after === "" || after.startsWith("/") || after.startsWith(" ");
			};
			const anchored = isAnchored(body ?? "") || isAnchored(title ?? "");
			if (!anchored) continue;
			appendFileSync(STALE_LOG, `${new Date().toISOString()} | ${id} | ${p} | removed-by-bash\n  title: ${title}\n  body: ${body.replace(/\n/g, " ⏎ ")}\n`);
			await run("graft", ["delete", id]);
		}
	} catch (err) {
		log(`remove failed ${p}: ${err instanceof Error ? err.message : String(err)}`);
	}
};

const bulkRewrite = async (oldDir: string, newDir: string): Promise<void> => {
	try {
		const escOld = oldDir.replace(/[%_\\]/g, (c) => `\\${c}`).replace(/'/g, "''");
		const relOld = oldDir.slice(HOME.length + 1);
		const relNew = newDir.slice(HOME.length + 1); // titles hold REL paths — rewrite both forms
		const escRel = relOld.replace(/[%_\\]/g, (c) => `\\${c}`).replace(/'/g, "''");
		// JSON output avoids sqlite3's `|`-separated multi-line corruption
		// (bodies contain newlines and pipes).
		const json = await run("sqlite3", ["-json", DB,
			`SELECT hex(id) id, title, body FROM nodes WHERE body LIKE '${escOld}%' ESCAPE '\\' OR title LIKE '${escRel}%' ESCAPE '\\';`]);
		let rows: { id: string; title: string; body: string | null }[] = [];
		try { rows = JSON.parse(json) || []; } catch { /* malformed */ }
		// write the log header BEFORE the loop — a mid-loop crash still records
		// what was being rewritten (nodes recoverable from stale-rehomes.log)
		appendFileSync(join(HOME, "knowledge-base", "stale-rehomes.log"),
			`${new Date().toISOString()} | bulk-rewrite | ${oldDir} -> ${newDir} (`);
		let n = 0;
		for (const row of rows) {
			if (!row || !row.id || !row.title) continue;
			// TRUE boundary-aware replacement: only replace whole-path segments,
			// so /a/b never corrupts /a/bc. A path is "at a boundary" when it is
			// followed by a path separator, a space (prose), or end-of-string.
			// Titles hold REL paths (Desktop/x/...) — rewrite both abs and rel forms.
			const repl = (s: string): string => {
				const bdry = (s: string, o: string, n: string): string => {
					const parts = s.split(o);
					return parts
						.map((p, i) => {
							if (i === 0) return p;
							const after = parts[i] ?? "";
							const sep = after.startsWith("/") || after.startsWith(" ") || after === "" ? "" : after;
							if (sep !== "") return o + after; // not a boundary — leave as-is
							return n + after;
						})
						.join("");
				};
				return bdry(bdry(s, oldDir, newDir), relOld, relNew);
			};
			// preserve keywords across delete+reinsert (graft doesn't carry them)
			const kws = await nodeKeywordsAt(row.id);
			const newTitle = repl(row.title);
			const newBody = repl(row.body ?? "");
			await run("graft", ["delete", row.id]);
			const args = ["insert", "--title", newTitle, "--body", newBody || ""];
			for (const k of kws) if (k) args.push("--keyword", k);
			await run("graft", args);
			n++;
		}
		appendFileSync(join(HOME, "knowledge-base", "stale-rehomes.log"), `${n} nodes)\n`);
	} catch (err) {
		log(`bulkRewrite failed ${oldDir}: ${err instanceof Error ? err.message : String(err)}`);
	}
};

export const handleMutation = async (m: { kind: string; src?: string; dst?: string; paths: string[] }): Promise<void> => {
	if (m.kind === "modify") {
		for (const p of m.paths) if (existsSync(p)) await refresh(p);
		return;
	}
	if (m.kind === "remove") {
		for (const p of m.paths) {
			// normalize trailing slash (rm -rf dir/) so isAnchored matches children
			const norm = p.endsWith("/") ? p.slice(0, -1) : p;
			if (!existsSync(norm)) await removeAnchored(norm);
		}
		return;
	}
	if (m.kind === "copy") {
		if (m.dst && existsSync(m.dst)) await refresh(m.dst);
		return;
	}
	if (m.kind === "move" && m.src && m.dst) {
		// normalize trailing slashes: 'mv a/ b/' means 'mv a b' — src/dst dirs
		const src = m.src.endsWith("/") ? m.src.slice(0, -1) : m.src;
		let dst = m.dst.endsWith("/") ? m.dst.slice(0, -1) : m.dst;
		if (!existsSync(dst)) return; // dst gone — nothing to anchor to
		let dstIsDir = false;
		try { dstIsDir = statSync(dst).isDirectory(); } catch { return; } // TOCTOU-safe
		if (dstIsDir) {
			// dst is a dir post-move. Two cases are indistinguishable from state:
			//   rename:      mv olddir newdir        → newdir/<old children>
			//   move-into:   mv olddir existingdir  → existingdir/olddir/<old children>
			// Deterministic discriminator: if dst/basename(src) exists, src was
			// moved INTO dst; otherwise dst IS the renamed src.
			const movedInto = existsSync(join(dst, basename(src)));
			dst = movedInto ? join(dst, basename(src)) : dst;
			await bulkRewrite(src, dst);
		} else {
			// dst is not a dir → plain file move/rename → rewrite src→dst directly
			// (rename changes basename, so kb-rehome's basename search can't find
			// it — the command itself is the deterministic source of truth)
			await bulkRewrite(src, dst);
		}
	}
};

export default function kbAutosyncExtension(pi: ExtensionAPI): void {
	const timers = new Map<string, NodeJS.Timeout>();
	const schedule = (key: string, fn: () => void, delay = 1200) => {
		const t = timers.get(key);
		if (t) clearTimeout(t);
		timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, delay));
	};

	pi.on("tool_result", (event) => {
		if (event.isError) return;
		const input = (event.input ?? {}) as Record<string, unknown>;

		if (EDIT_TOOLS.has(event.toolName)) {
			const p = String(input.path ?? input.file_path ?? "");
			if (p.startsWith("/Users/") && !skip(p)) {
				schedule(`edit:${p}`, () => void refresh(p));
			}
			return;
		}
		if (event.toolName === "bash") {
			updateCwd(String(input.command ?? ""));
			const m = classifyCommand(String(input.command ?? ""));
			if (m) schedule(`bash:${JSON.stringify(m)}`, () => void handleMutation(m), 1500);
		}
	});

	pi.on("user_bash", (event) => {
		updateCwd(event.command);
		const m = classifyCommand(event.command);
		if (m) schedule(`ubash:${JSON.stringify(m)}`, () => void handleMutation(m), 1500);
	});
}
