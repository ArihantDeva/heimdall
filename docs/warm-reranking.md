# Opt-in warm-worker reranking

This is a ranking adapter over **the worker's existing results**, not a new
retrieval leg. It calls the shared daemon's compute-only `score_candidates`
operation through the stdlib-only `candidate_scorer.py` client. It never starts a
daemon, invokes an installed `graft` binary, loads a model, or opens a hit's
target file. Ranking cannot grant `STRONG` or substitute for identity, regular
file, freshness, or coverage verification.

## Request and configuration

The warm JSON socket accepts an actual boolean on either `search` or `query`:

```json
{"op":"search","q":"example query","n":6,"related":true,"rerank":true}
```

An omitted or `false` `rerank` preserves the previous response/hit shape and
ordering. Values such as `1`, `"true"`, or `null` are errors, not opt-ins. There
is no global ranking-enable flag in the worker. A caller/shim is responsible for
translating its `HEIMDALL_RERANK=1` opt-in into this boolean and preserving the
returned evidence through verification. This worker change does not implement
that forwarding or change CLI trust logic; those belong to the separate ranking-evidence forwarding change on main's existing verifier.

The scorer socket must be an absolute Unix socket path in the **worker's
process environment**:

1. `HEIMDALL_RERANK_SOCKET` when the variable is present, even if empty; otherwise
2. `GRAFT_SOCKET`.

An explicitly empty Heimdall value is unconfigured; it never substitutes another socket.

No request field supplies or overrides this path. An invalid/unreachable explicit
Heimdall socket does not cause a fallback to the Graft socket. There is no default
socket probing, `~` expansion, daemon spawning, CLI discovery, or alternative
service. Missing/relative configuration yields `unavailable/unconfigured_socket`.
The worker still returns the frozen hits in their original order.

The native service owns effective rerank/CE disablement, availability, CPU-only
configuration checks (including `cpu_required`), model context limits, and model
inference. The worker honors its validated status; an opt-in does not bypass
those controls or load another encoder/cross-encoder.

## Frozen membership and indexed document source

For `search`, lexical and semantic retrieval, scope filtering, the existing
best-leg path dedupe, sorting, and truncation run **exactly as before**. Default
`n` remains **6**, not 25. For semantic-only `query`, the previous scope filter
and `n` cap also run before ranking. No deeper retrieval, new roots, fan-out,
extra encoder pass, sibling expansion, chunk changes, or target lookup is added.

Only the first `min(25, len(frozen_hits))` hits can be scored. Tails retain their
order and every existing field, including `score`; they receive only additive
request diagnostics and are labeled `outside_window`. A failed window is never
partially reordered.

When a configured scorer is available to attempt, the adapter uses `ei.conn()`
for one bound `SELECT path, title, body, sha1 ... WHERE path IN (...)`, within one
read transaction. This works with a fake EI connection as well as the existing
index; it does not assume a DB filename or import sqlite-vec itself. The read is
nonblocking on a busy index (`busy_timeout=0` on that connection). No index or
configuration write occurs.

The daemon receives the exact current **`cards.title` and `cards.body`**, not the
worker's legacy `"semantic hit [path]"`/`"lexical hit [path]"` display body, a
fresh target-file read, or a title-as-document fallback. The stored `cards.sha1`
is carried as provenance, **not recomputed or claimed to be a target-file hash**.
The stored body may itself be an ingest-time preview; this adapter does not
re-chunk it or truncate it further. `scoring_input_sha256` fingerprints the exact
indexed title/body in memory (version tag plus length-prefixed title), not a
live file. The verifier can compare this with its later indexed-text snapshot
without falsely attaching old scoring evidence to a newly verified card.

Any missing/unreadable card, non-string title/body/sha1, missing sha1, empty body,
generated `[minimal file]` or dataless/name-only preview, or bare filename body
keeps the **entire window's original order**. Oversized, NUL-containing, or
otherwise invalid scorer inputs are explicitly rejected by the client, never
silently shortened. No subset of the usable cards is sent in place of the fixed
window. If no socket is configured, the snapshot is not read; provenance says
`not_read` rather than pretending indexed text was observed. When a whole-stage
ceiling expires before a result is observed, it says `unobserved` instead; an
abandoned read may still finish cleanup.

## Signals, ranks and legacy sorting

Raw semantic cosine is preserved by both existing semantic producers:

- NumPy-result `_semantic_hits`: `s_vec = sim` before rounding;
- `embed-index.query`: `s_vec = 1.0 - distance` before rounding.

Their existing rounded `score` remains intact. The fused worker retains this raw
signal by path before the existing `+3` offset, even if the lexical leg wins that
path's dedupe. It does **not** derive cosine from a lexical ordinal, rounded
legacy score, `+3` offset, or a structural sibling's synthetic zero. Absent or
nonfinite/malformed producer evidence becomes `null` with a missingness reason;
a genuinely observed `0.0` remains zero. Raw producer fields are internal at the
socket boundary; requested evidence is under `signals.s_vec` and false/default
requests do not gain new fields.

`s_lex` is a validated native **query–indexed-title trigram Jaccard**. It is not
BM25, a lexical rank, or a body relevance score. The adapter does not invent a
local proxy when native evidence is absent. `s_ce` is the native normalized model
score, **not a calibrated probability** or a trust verdict.

Only a fully validated v1 applied response can reorder hits. The client checks
input-order IDs, ranks as a permutation, completeness, finite-or-null signals,
document byte counts, CE-primary descending order, and stable original-rank ties.
Evidence is attached to hits in input order before sorting by the returned rank.

For an applied window:

- `retrieval_score` preserves the original generic score;
- `retrieval_rank` preserves the original 1-based position;
- `rank` is the final 1-based position;
- `score_kind` is `"order_key"`;
- legacy `score` becomes a descending **ordinal order key**, not a CE magnitude;
- `ranking_score` and `signals.s_ce` hold the actual CE score.

The ordinal keys are offset above the maximum unchanged tail score. Thus a
legacy downstream descending `score` sort cannot undo the daemon's order or
promote a tail above the window, even when requested `n` exceeds the available
hit count. Ties stay stable. On degradation, original `score` and order remain,
with `score_kind:"retrieval"`. A valid partial CE diagnostic may be exposed as
`ranking_score`/`s_ce`, but is **never used to partially reorder** a failed window.
Path, retrieval title/display body, root/repo metadata, leg, related flags, and
any existing trust verdict are preserved.

## Socket evidence schema

Requested responses include a separate per-request `rerank` object. `search`
still includes its independent `sem_coverage`; ranking availability never changes
that semantic coverage. Semantic-only `query` retains its old envelope without
adding `sem_coverage`.

```json
{
  "version": 1,
  "requested": true,
  "status": "applied",
  "reason": "<validated native reason or safe local code>",
  "applied": true,
  "method": "cross_encoder",
  "candidate_count": 6,
  "scored_count": 6,
  "total_count": 6,
  "tail_count": 0
}
```

Statuses are `applied`, `disabled`, `unavailable`, `failed`, `deadline`, or
`empty`. Only `applied` sets `applied:true`/`method:"cross_encoder"`; all others
use `method:"original_order"`. `candidate_count` describes the capped window,
not a larger retrieval pool. `scored_count` counts validated `ce_status:"ok"`
rows. Empty results need neither a card read nor a scorer connection.

Every requested hit, including degraded hits and untouched tails, gains:

| Field | Meaning |
|---|---|
| `retrieval_score`, `retrieval_rank`, `rank`, `score_kind` | Original evidence and final ordering, as above |
| `ranking_score` | Observed CE magnitude or `null`; never the ordinal key |
| `signals.s_vec` | Real raw semantic cosine or `null` |
| `signals.s_vec_source` | `semantic_cosine` or `missing` |
| `signals.s_vec_missing_reason` | `null`, `not_observed`, `invalid_semantic_signal`, or `nonfinite_semantic_signal` |
| `signals.s_lex`, `signals.s_lex_source` | Native title Jaccard or `null`, labeled `title_trigram_jaccard` |
| `signals.s_lex_missing_reason` | `null` if observed, otherwise `scorer_not_observed`, `not_observed`, or `outside_window` |
| `signals.s_ce`, `signals.ce_status` | Validated native diagnostic; `null`/`not_scored` if no validated native row was observed |
| `signals.document_bytes` | Exact indexed body UTF-8 byte count if observed/usable, otherwise `null` |
| `provenance.document_source`, `title_source` | `cards.body`/`cards.title` when read, otherwise `null` |
| `provenance.card_sha1` | Stored index sha1 when a string, otherwise `null` |
| `provenance.scoring_input_sha256` | Fingerprint of supplied indexed title/body, not a target-file hash; otherwise `null` |
| `provenance.card_status` | `ready`, explicit `card_*` failure, `cards_unreadable`, `not_read`, or `outside_window` |

Examples of local degradation reasons: `unconfigured_socket`, `transport`,
`cards_unreadable`, `card_missing`, `card_nonstring`, `card_empty_body`,
`card_name_only`, `card_missing_sha1`, `card_invalid_utf8`, `card_invalid_path`,
`invalid_candidate_text`, `search_deadline`, or the client's safe
`response_*` validation code. Local transport failures are `unavailable`;
malformed replies/invalid scorer inputs are `failed`; waiting timeout is
`deadline`. No query/document/OS exception text is added to error messages.

Request diagnostics live on list subclasses (`SearchHits` producer metadata,
`RankedHits.rerank`), not a new global status flag. Their attributes are not
serialized as hit fields. The existing legacy coverage flag remains compatible
for direct callers, while socket replies use request-local coverage to avoid
cross-request contamination. A later false/default request has no ranking
metadata.

## Deadline and verification limits

Retrieval keeps its existing search ceiling. After freezing hits, the scorer
client receives `timeout_s = min(8.0, remaining_search_deadline)`, recomputed after
hydration/import. An exhausted budget skips scorer I/O and returns the original
hits with `deadline/search_deadline`. With the search ceiling disabled, scorer
waiting is still capped at eight seconds. The same absolute deadline is propagated into client validation/encoding and
rechecked before socket construction and I/O; preparation cannot start a fresh
waiting budget after the enclosing stage has expired. Adapter import and the
entire optional stage, including card I/O/cleanup and client import, are guarded
at the worker boundary; a stalled read/import returns the frozen original hits
with typed degradation. Daemon threads may finish cleanup later, and recheck the
same deadline before scorer I/O. The client keeps one absolute deadline across
connect/send/receive rather than restarting a timeout per chunk.
Native budget checks happen between pairs. **A timed-out client does not cancel
an in-flight native model pass or lock wait.**

Run the isolated contract tests with:

```sh
node --test tests/warm-daemon-ranking.test.mjs
```

These tests use fixed scores, private sockets, temporary sqlite cards, blocked
real model/package imports, and fake retrieval/encoder/native-service behavior.
They cover membership/depth, default-six behavior, first-25/tails, stable ties
and client rejection, current indexed body/sha1 provenance, name-only rejection,
no target opens, all status classes, partial diagnostics, remaining deadlines,
actual warm-socket JSON, concurrency/no metadata leaks, and legacy sort retention.
The NumPy-result test prescribes kNN output; it does not execute NumPy similarity
math. The embed-index test stubs imports, distance rows and encoder output. These
are **not model tests, real retrieval tests, quality measurements, evaluations,
benchmarks, or evidence of improved relevance**. Native model/config integration
and composed shim/verifier behavior require separate review; no package or model
installation is needed for these contract tests.
