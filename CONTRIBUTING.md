# Contributing to Heimdall

Thanks for helping build persistent memory for AI coding agents.

## Quick start

```bash
git clone https://github.com/ArihantDeva/heimdall.git
cd heimdall
npm install
npm test            # full suite — must stay green
npm run typecheck   # extensions typecheck
```

You don't need the graft backend to contribute: `MemorySink` (used by tests and `--dry-run`) covers the whole reconciler path without a daemon. The L3 end-to-end test self-skips if tree-sitter isn't available on your machine.

## Ground rules

1. **Level-triggered, not event-driven.** Code may only say "look at this path". Never trust a hint about *what* changed — read the file from disk.
2. **Single writer.** Every journal/graph mutation goes through `Lock`. If you're writing state outside the lock, stop.
3. **Exact ownership.** A commit owns all of one path's rows, deleted and re-inserted in one transaction.
4. **Bound parameters only** in the journal. No SQL string building.
5. **No LLM calls at ingest.** Indexing costs CPU, never tokens. This is a product promise.

If a PR breaks one of these invariants, the concurrency tests will go red — that's by design.

## Before opening a PR

- `npm test` green (262 tests)
- `npm run typecheck` clean
- New behavior has a test
- README updated if you changed user-facing behavior

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, and `heimdall doctor` output. Redact any private paths from the graph output — your memory graph is yours.

## License

MIT. By contributing you agree your contributions are licensed under MIT.
