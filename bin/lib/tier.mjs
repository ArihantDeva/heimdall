// tier.mjs — which memory variant runs: the CPU-only base (zero LLM calls
// at runtime) or the agent-memory tier (LLM extraction behind explicit
// config). Default is always cpu: the zero-token promise holds unless the
// user opts in. Spec: docs/superpowers/specs/2026-08-23-fact-layer-design.md
// D2 (CPU heuristics); agent tier added by the 2026-08-23 R&D cycle.

const TIERS = new Set(["cpu", "agent"]);

/**
 * Resolve the memory tier from a loaded config.
 * Unknown/missing values fall back to "cpu" — never throw, never guess up.
 *
 * @param {{memory?: {tier?: string}}} [cfg] loaded ~/.heimdall/config.json
 * @returns {{tier: "cpu"|"agent", requested: string|undefined}}
 */
export function resolveTier(cfg = {}) {
  const requested = cfg?.memory?.tier;
  const tier = TIERS.has(typeof requested === "string" ? requested.toLowerCase() : "")
    ? /** @type {"cpu"|"agent"} */ (requested.toLowerCase())
    : "cpu";
  return { tier, requested };
}
