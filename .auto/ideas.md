# Deferred optimizations / leads

- tests/seed-graft-rollback.test.mjs — text-only suite (reads source, never spawns
  the script). Claim: "re-seeding a row must not destroy it". Mutate the rollback
  logic while preserving the grepped shape and see if it survives. Data-integrity
  adjacent, so ranked above the next item.
- tests/per-command-assignment-and-scratch-cleanup.test.mjs — text-only suite over
  bin/kb-verify.sh. Assertions about scratch-HOME assignment and the
  silent-swallow check inspecting a handler BODY. Same shape-vs-behaviour question.
- The remaining text-only suites were found with:
    for f in $(rg --no-ignore -l 'readFileSync\((SCRIPT|SRC|BIN|src)' tests/*.mjs); do
      rg -q 'spawnSync\("bash", \[(SCRIPT|SRC|BIN)' "$f" || echo "TEXT-ONLY: $f"; done
  Re-run that after edits; the list should shrink toward zero.
- The inverse sweep (worth doing once): suites that DO spawn a script but pass it
  no arguments and ignore its exit status — a spawn that never asserts is as weak
  as a grep.
- DONE (#59): kb-verify.sh scratch cleanup behaviour suite. Remaining backlog
  item: tests/kb-rebuild-fail-closed.test.mjs and stale-node-absence-and-mass-guard
  are still listed as TEXT-ONLY by the sweep even though behaviour suites now
  exist alongside them. Consider whether the text-only ones earn their keep or
  should shrink to the few shape facts that matter (the shape assertions are not
  harmful, just insufficient).
- Unexplored axis: scripts whose cleanup/guard branches are correct but never
  REACHED (dead code after an early exit). Mutation = move the branch after a
  `return`/`exit` and see if any suite notices.
