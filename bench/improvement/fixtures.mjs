// bench/improvement/fixtures.mjs — held-out labeled cases for the accuracy lane.
//
// These labels are FROZEN: they exist to be scored against, never tuned
// against. Changing a label is a baseline-breaking event, not a fix.
//
// `ranked` is the ranking a system produced (best first); `gold` is the set of
// ids that are actually relevant. The runner scores them with
// bench/improvement/eval.mjs; nothing here depends on a daemon.
//
// Case design notes (each one is a behavior the product claims):
//   · exact/gold-first          — the easy case; a broken system must still fail it
//   · gold-late                 — tests discounting, not just presence
//   · gold-absent               — the "hallucinated match" case: nothing relevant
//                                 was retrieved, so a truthful system must refuse
//                                 rather than promote the top hit
//   · near-miss-token           — lexical overlap without relevance

export const FIXTURES = [
  {
    id: "gold-first",
    ranked: ["kb_search_before_implementing", "unrelated_style_guide", "old_migration_note"],
    gold: ["kb_search_before_implementing"],
  },
  {
    id: "gold-second",
    ranked: ["near_miss_title", "reconcile_single_writer", "unrelated_style_guide"],
    gold: ["reconcile_single_writer"],
  },
  {
    id: "gold-late",
    ranked: ["a", "b", "c", "d", "verdict_content_aware", "f"],
    gold: ["verdict_content_aware"],
  },
  {
    id: "gold-absent-must-not-promote",
    ranked: ["hallucinated_match", "unrelated_style_guide", "old_migration_note"],
    gold: ["nothing_relevant_retrieved"],
  },
  {
    id: "near-miss-token",
    ranked: ["kb_guard_search_chain_docs", "kb_search_identity"],
    gold: ["kb_search_identity"],
  },
  {
    id: "stale-path-not-strong",
    ranked: ["moved_file_old_path", "live_file_current_path"],
    gold: ["live_file_current_path"],
  },
];

/**
 * Sanity check the frozen labels themselves. A fixture whose gold id appears
 * in `ranked` more than once, or which has no gold at all, would silently
 * corrupt every metric computed from it.
 */
export function validateFixtures(fixtures = FIXTURES) {
  const problems = [];
  for (const f of fixtures) {
    if (!f.gold.length) problems.push(`${f.id}: no gold labels`);
    const dupes = f.ranked.filter((id, i) => f.ranked.indexOf(id) !== i);
    if (dupes.length) problems.push(`${f.id}: duplicate ranked ids ${dupes.join(", ")}`);
    if (new Set(f.gold).size !== f.gold.length) problems.push(`${f.id}: duplicate gold ids`);
  }
  return problems;
}
