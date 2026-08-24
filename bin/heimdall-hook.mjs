#!/usr/bin/env node
// heimdall-hook — harness hook entrypoint called by adapter-installed hooks
// (Claude Code PostToolUse, Codex notify, etc). Reads a JSON tool event from
// stdin (or argv JSON), maintains the grep-chain state machine per session,
// prints a warning when the chain fires. NEVER exits non-zero: hooks that
// fail can break the harness, so every failure degrades to silence.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GREP_TOOLS = new Set(["bash", "read", "grep", "find", "ls", "Bash", "Grep", "Glob", "Read", "shell", "terminal"]);
const RESET_TOOLS = new Set(["kb_search", "kb_sync", "mcp__heimdall__kb_search", "mcp__heimdall__kb_sync"]);

const statePath = () => {
	const dir = join(homedir(), ".heimdall", "hooks");
	mkdirSync(dir, { recursive: true });
	return join(dir, `chain-${process.ppid ?? "x"}.json`);
};

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
		console.log(
			escalated
				? `[heimdall] chain=${s.chain}: you are deep in filesystem-discovery territory. Run kb_search (MCP: mcp__heimdall__kb_search) or justify in one line why memory is irrelevant.`
				: `[heimdall] ${s.chain} search actions without kb_search. Memory-first rule (AGENTS.md): run kb_search for what you're looking for before more ls/grep/find.`
		);
	}
	process.exit(0);
}

try { main(); } catch { process.exit(0); }
