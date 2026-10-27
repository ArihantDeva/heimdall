# Ranking evidence through verified search output

This change only transports and validates ranking evidence. It does not score a
candidate, fetch more candidates, load a model, or let a score grant STRONG.
The existing regular-file, card identity, freshness and query coverage checks
remain separate and unchanged.

## Opt-in and compatible fallback

`HEIMDALL_RERANK=1` on a fused search asks the warm worker for `rerank:true`.
Without the opt-in, the existing request/output behavior is unchanged. The
scorer socket belongs to the worker's environment, not to query input; see
`docs/warm-reranking.md` in the companion worker change. No socket/model/runtime
readiness is implied by setting the CLI flag.

An old worker may ignore the opt-in. The shim then reports
`unavailable/worker_unsupported`, not a fictitious successful rerank. Native
service failures and deadlines likewise remain visible as ranking degradation,
independent of `sem_coverage`; a reranker failure is not a lexical-only search.

## Agent-visible evidence

MCP retains search stdout, not arbitrary stderr, so the verifier prints:

- one `RERANK:` JSON summary with validated method/status/reason/window counts;
- a bounded `signals=` JSON line for each annotated hit, preserving finite-or-null
  `s_vec`, title-trigram `s_lex`, `s_ce`, availability/source labels, original
  retrieval scalar/kind, and the separate actual ranking scalar;
- explicit scoring-input snapshot provenance rather than document bodies.

The generic sortable `score` can be an ordinal `order_key`; it is never renamed
as a calibrated relevance magnitude. Genuine observed zero is zero, absent is
null, and `s_lex_source:title_trigram_jaccard` is not a claim of body relevance or
BM25 calibration. Inconsistent counts, positions, unstable ties, malformed
signals, unsolicited applied ranking, and keys that would undo reported order
are rejected rather than presented as applied evidence.

No arbitrary worker/native response fields or raw documents are copied into the
new diagnostic lines. Ranking cannot alter the original semantic/related leg or
supply a filename as content coverage. A high CE score cannot promote a changed,
cardless, missing, nonregular or zero-coverage hit to STRONG.

## Scored snapshot versus verified snapshot

The scorer uses an indexed text snapshot before its potentially slow model call.
The verifier independently reads the current card in its existing read snapshot.
Those two observations can legitimately differ after a concurrent index update.

`scoring_input_sha256` fingerprints the already-indexed title/body in memory:
SHA-256 of the version tag `heimdall-scoring-text-v1` plus NUL, then an eight-byte
big-endian UTF-8 title length, title bytes, and body bytes. The worker never hashes
a live target file to obtain it. The verifier applies the same format to the
current indexed text, without reading a target file.

The output preserves `scored_card_sha1` as the worker's stored-index observation,
not a proof of file bytes. It separately reports `current_index_card_sha1`,
`current_index_text_sha256`, and `scoring_snapshot`:

- `matches_current_index`: the text fingerprints agree;
- `changed_since_scoring`: ranking features belong to a different indexed text
  snapshot, with an explicit warning that they do not verify the current card;
- `unknown`: no comparable observation is available.

A current card may pass metadata/coverage verification while an old model score
is clearly labeled stale. No old score is relabeled fresh, and no snapshot hash
bypasses regular-file/card/coverage conditions. Metadata agreement and an indexed
text fingerprint are not cryptographic proof of a live file's bytes.

The tests use fixed socket replies and temporary cards to check this contract,
including zero/null, high-score trust non-promotion, old-worker degradation,
stale snapshot labeling and malformed claims. They do not run a model, evaluate
retrieval quality, or claim a quality/performance gain.
