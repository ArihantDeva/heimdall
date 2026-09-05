// kb-guard-core — pure state machine for the kb_search-before-search-chain guard.
// grep-style DISCOVERY actions are counted per-session; ladder of consequences:
//   firing 1 (chain hits 3): ⚠️ WARNING prepended to result
//   firing 2:               🛑 ESCALATION prepended
//   firing 3+:              {block:true, reason} — pi blocks the tool call.
// Scope-aware (2026-08-27): only UNscoped discovery chains warn/escalate — a
// search that names an explicit path (repo dir, ~-relative, ./ ../, absolute,
// or a `cd <dir>` into a repo) is legitimate scoped work and never fires.
// Blocks apply to search actions only: grep/find/ls/read TOOL calls always;
// bash only when its first token is a search binary (rg/grep/find/ls/fd).
// Non-search bash (tests, builds, echo) is never blockable.
// At BLOCK stage (firings >= 2) legacy semantics hold: any search-head bash
// or search tool call blocks — reaching block stage means 2 escalations were
// ignored; kb_search/kb_sync/kb_guard_pause reset or suspend.
// Reset: kb_search, kb_sync, or a bash command touching graft/heimdall.
// Interleaved edit/write do NOT reset — only knowledge-access actions do.
//
// Exported alone so impl-review-loop + node --test can exercise it without the
// pi ExtensionAPI runtime; the extension (kb-search-guard.ts) owns the hook.

export const GREP_TOOLS = new Set(["bash", "read", "grep", "find", "ls"]);
export const RESET_TOOLS = new Set(["kb_search", "kb_sync"]);

export const WARNING =
  "⚠️ kb-guard: 3+ consecutive UNscoped search actions without kb_search. " +
  "Run kb_search FIRST (ranked cross-project memory, verified paths) — scoped " +
  "repo searches (explicit paths) never trip this guard. Chain resets on kb_search/kb_sync.";

export const ESCALATION =
  "🛑 kb-guard ESCALATED: this is the SECOND+ warning without any kb_search. " +
  "You are burning context re-discovering work the memory index already knows. " +
  "MANDATORY next action: call kb_search for what you're looking for. " +
  "If Heimdall is genuinely irrelevant to this exact step, state why in one line, then proceed.";

export const BLOCK_REASON =
  "🛑 kb-guard BLOCKED: three+ discovery-chain warnings ignored — pathless " +
  "rg/grep/find/ls/read spam without a single kb_search. Call kb_search for what " +
  "you're looking for FIRST (it resets this guard), then retry the search.";

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

/** Is this bash command a SCOPED search — i.e. it names an explicit path the
 * agent already knows (repo dir, ~/home, ./.., absolute, or `cd <dir>`)?
 * Scoped searches are legitimate work; only pathless discovery chains trip
 * the guard. Conservative: any path-like token => scoped.
 * The search binary's own path (e.g. /usr/bin/grep) is NOT a scoping path —
 * only the operands matter. */
export function isScopedSearch(command) {
  const cmd = String(command ?? "");
  if (cmd === "") return false;
  // `cd <path>` establishes a working directory — the search is inside it.
  if (/cd\s+(\/|~|\$HOME|\.\.?\/|[^\s]*\/)/.test(cmd)) return true;
  // Drop the leading binary path if present (`/usr/bin/grep -rn x` → `-rn x`).
  const operands = cmd.replace(/^(\S*\/)+(rg|grep|ggrep|find|ls|fd)(\b|\s)/, "");
  // Any operand that is a path: leading /, ~, ~/x, ./x, ../x, x/y (contains a slash),
  // or a standalone . / .. (cwd / parent cwd).
  return /(^|\s)(\/|~\/|\.\.?\/|~(\.)?(\s|$)|(\.\.?)(\s|$)|[^\s]*\/)/.test(operands);
}

/** Is this non-bash search TOOL call scoped? read/ls/find/grep take a `path`
 * field — a non-empty path means the agent is reading/searching something it
 * knows. A bare pattern (no path) is unscoped discovery. */
export function isScopedToolSearch(toolName, input) {
  if (!input || typeof input !== "object") return false;
  const p = input.path;
  return typeof p === "string" && p.trim() !== "";
}

function consequence(firings) {
  if (firings <= 1) return WARNING;
  if (firings === 2) return ESCALATION;
  return { block: true, reason: BLOCK_REASON };
}

export function createGuard() {
  let chain = 0;
  let firings = 0; // total warnings fired this session — drives escalation
  let pausedTurns = 0; // >0: agent-requested suspension — note() always null
  return {
    /** Suspend all enforcement for N model turns (agent self-service escape hatch).
     * Returns turns actually applied (clamped to 1..20, floored; junk → 0 = no-op).
     * Re-suspend takes the MAX, so a small second call never shortens a pause. */
    suspend(turns) {
      const n = Math.min(20, Math.floor(Number(turns)));
      if (!Number.isFinite(n) || n < 1) return 0;
      pausedTurns = Math.max(pausedTurns, n);
      return pausedTurns;
    },
    /** Advance the turn clock by one model turn; expires a lapsed pause with a
     * full clean slate — consulting knowledge de-escalates, same as kb_search. */
    tickTurn() {
      if (pausedTurns <= 0) return;
      pausedTurns -= 1;
      if (pausedTurns === 0) {
        chain = 0;
        firings = 0;
      }
    },
    get pausedTurns() {
      return pausedTurns;
    },
    get firings() {
      return firings;
    },
    /** Feed one tool call. Returns warning string, block verdict {block,reason}, else null.
     * While suspended (agent-called kb_guard_pause), always null — full bypass.
     * Resets are clean-slate: chain AND firings cleared — consulting knowledge
     * de-escalates fully; a stale bad stretch can't prime later blocks. */
    note(toolName, input) {
      if (pausedTurns > 0) return null; // suspension active — enforcement off
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
        const search = isSearchHead(cmd);
        // Past escalation, only SEARCH-headed bash matters: non-search bash
        // neither fires nor advances the chain (stays "search actions since reset").
        if (firings >= 2) {
          // Block stage: scoped searches stay exempt (they are legitimate work
          // even after escalations); only pathless discovery keeps blocking.
          if (!search) return null;
          return isScopedSearch(cmd) ? null : { block: true, reason: BLOCK_REASON };
        }
        // Warn/escalate stage: scoped searches are legitimate work — skip them.
        if (search && isScopedSearch(cmd)) return null;
        chain += 1;
        if (chain >= 3) {
          firings += 1;
          return consequence(firings);
        }
        return null;
      }
      if (GREP_TOOLS.has(toolName)) {
        // Scoped tool calls (read with a path, etc.) never fire at any stage.
        if (isScopedToolSearch(toolName, input)) return null;
        if (firings >= 2) {
          chain += 1;
          if (chain >= 3) {
            firings += 1;
            return consequence(firings);
          }
          return null;
        }
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
