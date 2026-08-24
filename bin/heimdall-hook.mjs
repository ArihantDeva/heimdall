#!/usr/bin/env node
// heimdall-hook — harness hook entrypoint called by adapter-installed hooks
// (Claude Code PostToolUse, Codex notify, etc). Reads a JSON tool event from
// stdin (or argv JSON), maintains the grep-chain state machine per session,
// prints a warning when the chain fires. NEVER exits non-zero: hooks that
// fail can break the harness, so every failure degrades to silence.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GREP_TOOLS = new Set(["bash", "grep", "find", "ls", "Bash", "Grep", "Glob", "shell", "terminal"]);
const RESET_TOOLS = new Set(["kb_search", "kb_sync", "read", "Read", "mcp__heimdall__kb_search", "mcp__heimdall__kb_sync"]);

const stateDir = () => {
	const dir = join(homedir(), ".heimdall", "hooks");
	mkdirSync(dir, { recursive: true });
	return dir;
};

/** Session key: prefer the harness's session id (stable across shell wrappers
 * and PID reuse); fall back to PPID. */
const statePath = () => {
	const sid = String(process.env.CLAUDE_SESSION_ID ?? process.env.HEIMDALL_SESSION ?? process.ppid ?? "x");
	return join(stateDir(), `chain-${sid.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}.json`);
};

/** Sweep state files older than 24h — hooks run constantly, so keep this O(1)-ish. */
let lastSweep = 0;
function sweep() {
	const now = Date.now();
	if (now - lastSweep < 60_000) return; // at most once a minute across processes
	lastSweep = now;
	try {
		for (const f of readdirSync(stateDir())) {
			const p = join(stateDir(), f);
			try { if (now - statSync(p).mtimeMs > 86_400_000) unlinkSync(p); } catch {}
		}
	} catch {}
}

const load = () => {
	try { return JSON.parse(readFileSync(statePath(), "utf8")); } catch { return { chain: 0 }; }
};

const save = (s) => {
	try { writeFileSync(statePath(), JSON.stringify(s)); } catch { /* warn-only */ }
};

function main() {
	let raw = "";
	try { raw = readFileSync(0, "utf8"); } catch {}
	let input = {};
	if (raw.trim()) { try { input = JSON.parse(raw); } catch {} }
	sweep();
	const tool = String(input.tool_name ?? input.toolName ?? input.tool ?? "");
	const cmd = String(input.command ?? input.input?.command ?? "");
	const args = String(input.arguments ? JSON.stringify(input.arguments) : "");

	// reset tools / heimdall+graft CLI usage resets the chain
	if (RESET_TOOLS.has(tool) || /(^|[;&\s])(heimdall|graft)\b/.test(`${cmd} ${args}`)) {
		save({ chain: 0 });
		process.exit(0);
	}
	if (!GREP_TOOLS.has(tool)) process.exit(0); // edit/write/etc don't count

	const s = load();
	s.chain += 1;
	save(s);
	if (s.chain >= 3) {
		const escalated = s.chain >= 9;
		const msg = escalated
			? `[heimdall] chain=${s.chain}: you are deep in filesystem-discovery territory. Run kb_search (MCP: mcp__heimdall__kb_search) or justify in one line why memory is irrelevant.`
			: `[heimdall] ${s.chain} search actions without kb_search. Memory-first rule (AGENTS.md): run kb_search for what you're looking for before more ls/grep/find.`;
		// Claude Code PostToolUse hooks reach the model only via hookSpecificOutput
		// JSON on stdout; other harnesses get the plain-text fallback on stderr.
		console.log(JSON.stringify({
			hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg },
		}));
		console.error(msg);
	}
	process.exit(0);
}

try { main(); } catch { process.exit(0); }
