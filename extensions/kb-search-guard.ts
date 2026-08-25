/**
 * kb-search-guard — police grep-style search chains without machine knowledge
 * (kb_search / kb_sync / graft). Ladder per session:
 *   firing 1 → ⚠️ WARNING prepended to result (tool_result patch)
 *   firing 2 → 🛑 ESCALATION prepended
 *   firing 3+ → tool_call BLOCKED for search actions (grep/find/ls/read tools;
 *   bash only when search-headed — npm test etc. always pass).
 * Reset on any knowledge-access action. Per-process state.
 *
 * Degrades silently: guard-core is plain JS, zero deps; any failure here
 * leaves tool results untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGuard, GREP_TOOLS, RESET_TOOLS } from "./lib/kb-guard-core.mjs";

export default function kbSearchGuardExtension(pi: ExtensionAPI): void {
  const guard = createGuard();
  let pending: string | null = null;

  pi.on("tool_call", (event) => {
    if (typeof event.toolName !== "string") return;
    // Feed exactly once per tool invocation (tool_result also fires, but
    // feeding there would double-count). String verdicts = warn/escalate,
    // stashed and delivered on tool_result. Object verdicts = block, acted
    // on here — tool_call is the only hook that can block.
    const v = guard.note(event.toolName, event.input as Record<string, unknown>);
    if (v && typeof v === "object" && v.block === true) {
      return { block: true, reason: v.reason };
    }
    if (typeof v === "string") pending = v;
  });

  pi.on("tool_result", (event) => {
    if (typeof event.toolName !== "string") return;
    if (!GREP_TOOLS.has(event.toolName) || RESET_TOOLS.has(event.toolName)) return;
    const warning = pending;
    pending = null; // consumed — one warning per firing action
    if (!warning) return;
    const content = Array.isArray(event.content) ? event.content : [];
    return {
      content: [
        { type: "text", text: warning + "\n" },
        ...content.filter((b) => !(b?.type === "text" && (b.text ?? "").startsWith("⚠️ WARNING — kb-guard"))),
      ],
    };
  });
}

// ── Demo self-check (matches guard-tower.ts precedent) ────────────────────
if (import.meta.main) {
  const g = createGuard();
  console.log("1:", g.note("read", {}));
  console.log("2:", g.note("grep", {}));
  console.log("3:", g.note("bash", { command: "ls" }));
  console.log("reset:", g.note("kb_search", {}));
  console.log("post:", g.note("find", {}));
}
