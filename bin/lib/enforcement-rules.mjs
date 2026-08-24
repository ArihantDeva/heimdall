// enforcement-rules — canonical Heimdall enforcement text, single source of
// truth for every harness adapter. Adapters embed this block verbatim (with a
// per-harness tool-name mapping) into their rules/memory files. Keeping it in
// one place prevents rule drift across harnesses.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES_VERSION = 1;

/**
 * The memory-first retrieval rule block. `${tool}` is the harness's name for
 * the search tool (kb_search everywhere via MCP; some harnesses rename it).
 */
export const ruleBlock = (tool = "kb_search") => `<!-- heimdall:enforcement v${RULES_VERSION} -->
## Memory-first retrieval (Heimdall) — HARD RULE

Before ANY implementation/fix/research, and instead of ls/find/grep chains for locating prior work:

1. **${tool} first.** Locating code/knowledge starts with a memory query over all repos on this machine — not filesystem discovery.
2. **Trust verdicts:** STRONG = verified on disk (act on it); WEAK = plausible (verify before acting). Never act on STALE/REMOVED paths.
3. **Never re-locate a hit.** A ${tool} hit with an existing path IS the location.
4. **Record reusable work** with kb_insert after completing it (fix/pattern/decision/gotcha).
5. **3+ consecutive search actions without ${tool} = waste.** If a guard warns you, run ${tool} next or state in one line why memory is irrelevant to this step.
<!-- /heimdall:enforcement -->`;

/** Claude Code hooks fragment: PostToolUse warning on grep-style chains. */
export const claudeHooksFragment = () => ({
	"hooks": {
		"PostToolUse": [
			{
				"matcher": "Bash|Grep|Glob|Read",
				"hooks": [
					{
						"type": "command",
						"command": "\"$HOME/.local/bin/heimdall-hook\" claude-code",
						"timeout": 5,
					},
				],
			},
		],
	},
});

/** Path of this module's dir (for locating bundled assets). */
export const assetsDir = () => join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
