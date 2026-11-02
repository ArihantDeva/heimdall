# Shared daemon candidate scorer — native v1

`score_candidates` is an **additive, compute-only MessagePack daemon operation**.
It ranks a caller's frozen candidate window; it does not discover candidates,
retrieve nodes, embed text, touch access times, prune, insert, or write an index.
`mg_ctx_t.storage` and `.embed` may both be NULL for this operation. No additional
model is loaded: the scorer borrows the existing rerank context's verify-owned
GGUF cross-encoder (CE), including its existing inference mutex.

This is ranking evidence, not a trust verdict. No score grants STRONG, bypasses
identity/coverage/regular-file checks, or changes query/cache verification gates.
The genuine CE/model runtime remains **unverified** in this implementation's unit
test environment. Fixed CE/storage/embedding stubs test mechanics, not model
quality, calibration, speed, or retrieval quality.

## Existing configuration and opt-in

No configuration defaults, model, provider, fusion weights, or model paths are
added or changed. The existing daemon initialization still owns model loading.
For CE-primary scoring to be usable, the existing configuration/runtime must have:

- `rerank.enabled: true` and a live `mg_rerank_ctx_t` (the existing all-zero-weight
  effective-disable sentinel remains NULL);
- `rerank.top_k > 0`;
- verification `cross_encoder_enabled: true`, including in the borrowed verify
  context's effective configuration;
- a finite, strictly positive existing `rerank.w_ce` (zero/negative/nonfinite does
  not opt into CE; no other weight is substituted);
- `hardware_accel: false` in both effective contexts; otherwise the new scorer
  reports `unavailable` / `cpu_required` without a CE call; and
- an already-enabled CE runtime on the borrowed verify context.

The operation does not try to enable, reload, or replace an unavailable runtime.
Other configured fusion/NLI weights are **not** used for this CE-primary path.
The legacy public `mg_rerank_batch()` API remains available for compatibility;
native retrieve no longer calls it. Query's existing verification/gating code is
unchanged. The new operation has no HTTP endpoint, listener, authentication
policy, socket probing, or daemon-spawn behavior.

`rerank.top_k` bounds native retrieve's window, not the supplied nonzero operation
window (which is independently limited to 25). A nonpositive top_k effectively
disables scoring. Request-level warm-client opt-in/transport is outside this
native API; calling the operation does not override disabled daemon config.

## Wire request

Use the existing socket protocol: **4-byte unsigned LITTLE-ENDIAN** payload length,
then exactly one MessagePack payload. The server's existing 16 MiB framing cap is
unchanged. This particular operation additionally rejects a request payload over
4 MiB. There is no JSON or host-endian framing variant.

```text
{
  op: 'score_candidates',
  args: {
    query: STRING,
    budget_ms: INTEGER,                 # optional; default 8000
    candidates: [
      {id: STRING, title: STRING, document: STRING, s_vec: NUMBER_OR_NIL},
      ...
    ]
  }
}
```

| Field | v1 limit / meaning |
| --- | --- |
| candidates | 0..25; zero is a successful `empty` result |
| id | nonempty, unique, opaque, at most 4096 UTF-8 bytes; not interpreted as a node UUID or path |
| query | nonblank, at most 16384 UTF-8 bytes; whitespace-only (including Unicode whitespace) rejected |
| title | at most 16384 UTF-8 bytes; empty allowed |
| document | at most 131072 UTF-8 bytes; exact supplied indexed body, empty allowed |
| s_vec | finite raw cosine, including negative or genuine zero, or nil when absent; no offset, clamp, or RRF substitution |
| budget_ms | integer 1..8000, default 8000; nil, floats, bools, or out-of-range integers rejected |

Every candidate must include all four keys. Root/args/candidate schemas reject
unknown, duplicate, missing, or non-string map keys, wrong types, duplicate IDs,
nonfinite numeric input, invalid UTF-8, embedded NULs, and trailing MessagePack
values. Strings are validated before creating C strings; embedded NULs are never
scored as prefixes. Byte limits are inclusive, not character counts. No string or
document is silently truncated. Bad requests return a nonzero standard outer
status with `result: nil`; errors never echo query/document contents.

`s_vec` is diagnostic input, not a CE tie-breaker. The caller is responsible for
supplying a true cosine rather than a rounded/offset/order-key score. `s_lex` is
the existing query–**title** character-trigram Jaccard implementation, not BM25,
body relevance, or an embedding score. Its explicit provenance is
`title_trigram_jaccard`. The checked form of the existing utility distinguishes
allocation/input failure from genuine zero overlap; scorer diagnostics use nil
on that error. The legacy wrapper retains its original zero-on-error behavior,
so query/cache gate semantics are unchanged.

## Wire result

The existing outer envelope is preserved:

```text
{
  status: 0,
  result: {
    version: 1,
    status: 'applied|disabled|unavailable|failed|deadline|empty',
    reason: STRING,
    applied: BOOL,
    method: 'cross_encoder|original_order',
    candidate_count: INTEGER,
    scored_count: INTEGER,
    results: [
      {
        id: STRING,
        original_rank: INTEGER,
        rank: INTEGER,
        s_vec: NUMBER_OR_NIL,
        s_lex: NUMBER_OR_NIL,
        s_ce: NUMBER_OR_NIL,
        ce_status: 'ok|disabled|unavailable|failed|deadline|not_scored',
        s_lex_source: 'title_trigram_jaccard',
        document_bytes: INTEGER
      }, ...
    ]
  }
}
```

`results` always stays in **input order**, preserving IDs verbatim. The chosen
`rank` is a 1-based permutation. Only if *all* candidates have valid finite
normalized CE scores within the best-effort budget is the window ordered by
CE descending. CE ties keep original rank, independently of cosine/Jaccard/RRF.
An applied window may happen to keep the same order. `s_ce` is the existing
classifier's normalized model score in [0,1], **not a calibrated probability**.
Out-of-range/nonfinite CE results are treated as failed evidence, not clamped.

On any missing or failed CE score, the **entire window** retains original ranks;
there is no partial fusion of CE and RRF magnitudes. Successful scores are kept
as diagnostics even when they cannot be applied. Missing evidence is nil, never
an invented zero. Serialization defensively emits only finite numbers or nil.
`scored_count` counts successfully observed CE results, not reorderings or
attempts. `document_bytes` describes the exact supplied scoring document.

| Batch status | Typical reason | Behavior |
| --- | --- | --- |
| applied | `all_scored` | all CE results valid; `applied: true`, method `cross_encoder` |
| disabled | `rerank_disabled`, `window_disabled`, `cross_encoder_disabled`, `ce_weight_disabled` | no CE calls; real cheap signals retained |
| unavailable | `cpu_required`, `ce_runtime_unavailable` | no CE calls; real cheap signals retained |
| failed | `ce_failed`, `ce_invalid_score`, `document_unavailable`, `clock_unavailable` | original order; successful CE diagnostics retained |
| deadline | `budget_exhausted` | original order; unattempted pairs marked deadline |
| empty | `no_candidates` | empty results, no CE calls, original_order |

A semantic CE failure/disable/deadline is a successful protocol response
(`outer status: 0`), distinguished by the inner status. Malformed/oversized
requests instead use the existing nonzero `mg_err_t` error envelope.

### Budget is not preemption

The core uses an OS monotonic clock, checked before each pair and after the last
pair. Cheap-signal computation counts toward the inference budget. A completed
pair that overruns the budget is retained as diagnostic evidence, but the batch
reports deadline and is not applied; even `scored_count == candidate_count` can
therefore accompany deadline. Previously observed failures keep their per-ID CE
statuses if a later budget boundary prevents completion.

**The core cannot preempt one inference or one CE mutex/lock acquisition.** The
request budget is best-effort between pairs, not a hard runtime/cancellation
promise. A caller's absolute socket I/O deadline bounds *waiting*, not backend
work already in progress. No new inference worker, second runtime, or cancellation
thread is created here.

## Native retrieve evidence

Native `mg_retrieve_run_rrf()` still uses its existing three lists, 50 candidates
per list, the same RRF formula, existing returned membership/top_k, and existing
missing-node behavior. It never expands the pool or reranks beyond
`min(existing rerank_top_k, 25, n_keep)`. Candidates past that window stay in
exactly their original RRF order; they are not rescored or compared with CE.

Each returned candidate keeps its original `id_hex`, `title`, `keywords`, and
`score`, with additive fields:

- `rank`: selected 1-based position in the frozen result set;
- `rrf_rank`, `rrf_score`: untouched original RRF evidence;
- `score_kind: 'cross_encoder'|'rrf'`: identifies the actual scalar in `score`;
  CE only for an applied window, otherwise RRF, including all untouched tails;
- `signals`: `s_vec`, `s_lex`, `s_ce`, `ce_status`, `s_lex_source`,
  `document_bytes`, plus `s_vec_source` (`vector_topk` or `unavailable`) and
  `document_source` (`body`, `title_fallback`, or `unavailable`).

A top-level `rerank` map supplies the seven v1 summary fields (everything above
except `results`); its candidate_count is the **window** size, not total results.
`ce_status: not_scored` identifies tails, not fabricated failure/zero evidence.
Native `score` magnitudes from different windows/kinds are not globally
comparable; returned order/rank is authoritative. Do not re-sort mixed-kind
results by scalar magnitude.

Raw vector-list cosine is attached by node ID. Lexical-only/not-in-list or
nonfinite vector evidence is nil, with unavailable provenance, not zero. BM25
scores and RRF magnitudes never masquerade as cosine or title Jaccard. The
complete candidate record (RRF, signals, provenance) moves with identity through
sorting, not with array position.

For the native window, the scorer receives the actual node **body**. Only a NULL
or empty body permits an explicit title fallback. Nodes fetched for the window
are retained by original RRF rank until serialization, so ranking evidence and
returned identity/title use that same fetched node version without a second
get_node call. Tail nodes keep existing fetch behavior. At most 25 nodes are
retained for the scoring window. No target-file opens, chunk changes, or writes
are introduced. A native document/query/title beyond v1 input limits yields
`failed` / `input_limits` and whole-window original order; it is never truncated
to obtain a score. Missing native nodes cannot be scored as empty prefixes.
Legacy missing-node omissions can leave gaps in native rank fields; the scorer
never fills gaps by retrieving replacements.

## C API and unit verification

`include/graft/candidate_scorer.h` adds:

- `mg_candidate_score(r, query, inputs, count, budget_ms, &batch)` — compute-only,
  borrowed strings/runtime, explicit presence flags, bounded fixed-size result
  array, no MessagePack/storage/embedding side effects;
- `mg_candidate_text_valid()` — strict UTF-8/NUL/nonblank validation;
- status-name helpers and the two `mg_candidate_write_*_fields()` serializers;
- `verify.h` additionally exposes `mg_text_trigram_jaccard_checked()` for the
  exact existing overlap with explicit error/missingness reporting;
- `mg_op_score_candidates()` is declared with the existing op handlers and
  dispatched through the existing wire enum (appended, preserving old values).

The handler validates full wire shapes before invoking the core. Native C callers
supply NUL-terminated strings; only native missing-text diagnostics may use
NULL title/document. Missing native documents fail the whole window. Invalid C
input returns `MG_ERR_INVALID_ARG` without any CE calls. The public legacy
`mg_rerank_batch()` signature and ownership rules are unchanged.

Run just the deterministic native unit suite (no model/runtime dependencies):

```sh
node --test tests/native-candidate-scorer.test.mjs
```

The test runner uses a system cc/gcc/clang, libc/libm/pthread, vendored MPack, and
actual production core/handler/retrieve/dispatch/wire plus the real existing
trigram utility. Strict CE/storage/embed/unused-operation stubs assert zero
storage/embed/writer/model-load calls for the pure operation. A fake monotonic
clock makes boundary/deadline cases deterministic; the production monotonic
branch is also compiled separately without that seam. No CMake invocation,
package install, download, or llama/sqlite/yaml link is involved. Fixtures test
fixed IDs and mock values only: schema/limits, order/ties, missing versus zero,
failures, CPU/disabled/unavailable states, body forwarding, identity-attached RRF
and signals, tails, finite-or-null serialization, malformed requests, dispatch,
and little-endian framing over an unnamed private socketpair.

**When no system compiler is available, the native fixture tests explicitly
skip; source-boundary checks still run. A skip is not compilation or native test
execution. Genuine model inference, model quality, and runtime behavior remain
unverified.** Full dependency/model builds and external CI execution are separate
from these deterministic unit mechanics.
