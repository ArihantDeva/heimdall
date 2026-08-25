// kb-guard-core — pure state machine for the kb_search-before-search-chain guard.
// grep-style actions are counted per-session; ladder of consequences:
//   firing 1 (chain hits 3): ⚠️ WARNING prepended to result
//   firing 2:               🛑 ESCALATION prepended
//   firing 3+:              {block:true, reason} — pi blocks the tool call.
// Blocks apply to search actions only: grep/find/ls/read TOOL calls always;
// bash only when its first token is a search binary (rg/grep/find/ls/fd).
// Non-search bash (tests, builds, echo) is never blockable.
// Reset: kb_search, kb_sync, or a bash command touching graft/heimdall.
// Interleaved edit/write do NOT reset — only knowledge-access actions do.
//
// Exported alone so impl-review-loop + node --test can exercise it without the
// pi ExtensionAPI runtime; the extension (kb-search-guard.ts) owns the hook.

export const GREP_TOOLS = new Set(["bash", "read", "grep", "find", "ls"]);
export const RESET_TOOLS = new Set(["kb_search", "kb_sync"]);

export const WARNING =
  "⚠️ kb-guard: 3+ consecutive search actions without kb_search. " +
  "Run kb_search FIRST (ranked cross-project memory, verified paths). " +
  "AGENTS.md requires it before implementation/research. Chain resets only on kb_search/kb_sync.";

export const ESCALATION =
  "🛑 kb-guard ESCALATED: this is the SECOND+ warning without any kb_search. " +
  "You are burning context re-discovering work the memory index already knows. " +
  "MANDATORY next action: call kb_search for what you're looking for. " +
  "If Heimdall is genuinely irrelevant to this exact step, state why in one line, then proceed.";

export const BLOCK_REASON =
  "🛑 kb-guard BLOCKED: three+ search-chain warnings ignored — rg/grep/find/ls/read spam " +
  "without a single kb_search. Call kb_search for what you're looking for FIRST " +
  "(it resets this guard), then retry the search.";

/** Bash command where ANY pipe/chain segment leads with a file-search binary.
 * Covers `rg x .`, `cat f | grep x`, `echo hi && ls`. Path prefixes ok.
 * ponytail: misses env-prefix (`FOO=1 rg`) and wrappers (`timeout 60 rg`);
 * nudge guard, not adversarial security — extend regex if that matters. */
export function isSearchHead(command) {
  const segs = String(command ?? "").split(/\|\||\||&&|;|\n/);
  return segs.some((s) => {
    const head = s.trim().split(/\s+/)[0] ?? "";
    return /^(.*\/)?(rg|(ba|e|f)?grep|ggrep|find|ls|fd)$/.test(head);
  });
}

function consequence(firings) {
  if (firings <= 1) return WARNING;
  if (firings === 2) return ESCALATION;
  return { block: true, reason: BLOCK_REASON };
}

export function createGuard() {
  let chain = 0;
  let firings = 0; // total warnings fired this session — drives escalation
  return {
    /** Feed one tool call. Returns warning string, block verdict {block,reason}, else null.
     * Resets are clean-slate: chain AND firings cleared — consulting knowledge
     * de-escalates fully; a stale bad stretch can't prime later blocks. */
    note(toolName, input) {
      if (RESET_TOOLS.has(toolName)) {
        chain = 0;
        firings = 0;
        return null;
      }
      if (toolName === "bash") {
        const cmd = String(input?.command ?? "");
        if (/(^|[;&\s])\s*(graft|heimdall)\b/.test(cmd)) {
          chain = 0;
          firings = 0;
          return null;
        }
        // Past escalation, only SEARCH-headed bash matters: other bash neither
        // fires nor advances the chain (stays "search actions since reset").
        if (firings >= 2 && !isSearchHead(cmd)) return null;
        chain += 1;
        if (chain >= 3 && (firings < 2 || isSearchHead(cmd))) {
          firings += 1;
          return consequence(firings);
        }
        return null;
      }
      if (GREP_TOOLS.has(toolName)) {
        chain += 1;
        if (chain >= 3) {
          firings += 1;
          return consequence(firings);
        }
        return null;
      }
      return null; // edit/write/intercom/etc: chain untouched, no warning
    },
    get chain() {
      return chain;
    },
  };
}
