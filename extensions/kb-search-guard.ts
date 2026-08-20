/**
 * kb-search-guard — warn the agent when it runs 3+ consecutive grep-style
 * search actions without consulting machine knowledge (kb_search / kb_sync /
 * graft). Non-blocking: prepends a ⚠️ WARNING to the tool result, which the
 * model sees immediately. Reset on any knowledge-access action. Per-process
 * state (one closure per pi process = one agent session).
 *
 * Degrades silently: guard-core is plain JS, zero deps; any failure here
 * leaves tool results untouched (warn-only, never block).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGuard, GREP_TOOLS, RESET_TOOLS } from "./lib/kb-guard-core.mjs";

export default function kbSearchGuardExtension(pi: ExtensionAPI): void {
  const guard = createGuard();
  let pending: string | null = null;

  pi.on("tool_call", (event) => {
    if (typeof event.toolName !== "string") return;
    // Feed exactly once per tool invocation (tool_result also fires, but
    // feeding there would double-count). Warning text is stashed here and
    // delivered on tool_result, which is the hook that can patch content.
    const w = guard.note(event.toolName, event.input as Record<string, unknown>);
    if (w) pending = w;
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
