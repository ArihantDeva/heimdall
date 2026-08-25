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
import { Type } from "typebox";
import { createGuard, GREP_TOOLS, RESET_TOOLS, BLOCK_REASON } from "./lib/kb-guard-core.mjs";

export default function kbSearchGuardExtension(pi: ExtensionAPI): void {
  const guard = createGuard();
  let pending: string | null = null;

  // Turn clock for agent-requested suspensions (kb_guard_pause): each model
  // turn consumes one paused turn; expiry restores enforcement clean-slate.
  // String-keyed overload — older stubs may not list turn_start in EventMap.
  pi.on("turn_start", () => {
    guard.tickTurn();
  });

  // Agent self-service escape hatch: suspend warn/escalate/block for N turns
  // the AGENT chooses. Self-service only — nothing ever engages it automatically.
  pi.registerTool({
    name: "kb_guard_pause",
    label: "KB Guard Pause",
    description:
      "Temporarily suspend Heimdall kb-guard warnings/escalations/blocks for N model turns " +
      "(1–20, you choose). Use when doing legitimate heavy file exploration that the guard " +
      "mis-fires on (deep refactors, bulk renames, log triage). Enforcement resumes " +
      "automatically from a clean slate after N turns; re-calling extends the pause. " +
      "Self-service: no approval needed.",
    promptSnippet: "Pause kb-search-guard enforcement for N turns",
    parameters: Type.Object({
      turns: Type.Number({
        description:
          "How many model turns to stay suspended (1–20). Pick enough to finish the " +
          "exploration burst that triggered the guard.",
      }),
    }),
    async execute(_id, params) {
      const applied = guard.suspend(params.turns);
      const text =
        applied > 0
          ? `⏸️ kb-guard suspended for ${applied} turn(s). Warnings/escalations/blocks off; enforcement resumes automatically from a clean slate.`
          : "kb_guard_pause: invalid turns (need a positive number, clamped to 20) — guard unchanged.";
      return { content: [{ type: "text", text }], details: { pausedTurns: applied } };
    },
  });

  pi.on("tool_call", (event) => {
    if (typeof event.toolName !== "string") return;
    // Feed exactly once per tool invocation (tool_result also fires, but
    // feeding there would double-count). String verdicts = warn/escalate,
    // stashed and delivered on tool_result. Object verdicts = block, acted
    // on here — tool_call is the only hook that can block.
    const v: string | { block?: boolean; reason?: string } | null = guard.note(
      event.toolName,
      event.input as Record<string, unknown>,
    );
    if (v !== null && typeof v === "object" && v.block === true) {
      return { block: true, reason: v.reason ?? BLOCK_REASON };
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
  console.log("pause:", g.suspend(2), "turns");
  console.log("paused note:", g.note("read", {}));
  g.tickTurn();
  g.tickTurn();
  console.log("post-pause chain:", g.chain, "firings:", g.firings);
}
