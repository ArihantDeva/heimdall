// kb-guard-core — pure state machine for the kb_search-before-search-chain guard.
// grep-style actions are counted per-session; at the 3rd consecutive one (and
// every one after), the agent receives a warning to run kb_search first.
// Reset: kb_search, kb_sync, or a bash command whose argv starts with `graft`
// (user-level=false so we never fire inside subagents). Interleaved read tool
// call / edit / write do NOT reset — only knowledge-access actions do.
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

export function createGuard() {
  let chain = 0;
  let firings = 0; // total warnings fired this session — drives escalation
  return {
    /** Feed one tool call. Returns warning string when the chain fires, else null. */
    note(toolName, input) {
      if (RESET_TOOLS.has(toolName)) {
        chain = 0;
        return null;
      }
      if (toolName === "bash") {
        const cmd = String(input?.command ?? "");
        if (/(^|[;&\s])\s*(graft|heimdall)\b/.test(cmd)) {
          chain = 0;
          return null;
        }
        // bash counts as a grep-style action (it's how most searches run); graft/heimdall
        // commands above reset instead. Everything else that searches lives here.
        chain += 1;
        if (chain >= 3) {
          firings += 1;
          return firings >= 2 ? ESCALATION : WARNING;
        }
        return null;
      }
      if (GREP_TOOLS.has(toolName)) {
        chain += 1;
        if (chain >= 3) {
          firings += 1;
          return firings >= 2 ? ESCALATION : WARNING;
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
