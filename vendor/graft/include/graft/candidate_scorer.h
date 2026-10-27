#ifndef GRAFT_CANDIDATE_SCORER_H
#define GRAFT_CANDIDATE_SCORER_H

#include "graft/rerank.h"
#include "mpack.h"

#include <stddef.h>
#include <stdint.h>

#define MG_CANDIDATE_MAX_COUNT          25u
#define MG_CANDIDATE_MAX_ID_BYTES       4096u
#define MG_CANDIDATE_MAX_QUERY_BYTES    16384u
#define MG_CANDIDATE_MAX_TITLE_BYTES    16384u
#define MG_CANDIDATE_MAX_DOCUMENT_BYTES 131072u
#define MG_CANDIDATE_MAX_REQUEST_BYTES  (4u * 1024u * 1024u)
#define MG_CANDIDATE_MAX_BUDGET_MS      8000

/* All strings are borrowed, NUL-terminated UTF-8. The wire handler rejects
 * embedded NULs before creating C strings. NULL title/document are permitted
 * only for native retrieval's missing-text diagnostics, never on the wire.
 * s_vec is raw cosine (including negative values), not an offset or RRF score.
 * Missingness is explicit; a genuine zero must set has_s_vec=true. */
typedef struct {
    const char *id;
    const char *title;
    const char *document;
    double s_vec;
    bool has_s_vec;
} mg_candidate_input_t;

typedef enum {
    MG_CANDIDATE_APPLIED,
    MG_CANDIDATE_DISABLED,
    MG_CANDIDATE_UNAVAILABLE,
    MG_CANDIDATE_FAILED,
    MG_CANDIDATE_DEADLINE,
    MG_CANDIDATE_EMPTY
} mg_candidate_status_t;

typedef enum {
    MG_CE_OK,
    MG_CE_DISABLED,
    MG_CE_UNAVAILABLE,
    MG_CE_FAILED,
    MG_CE_DEADLINE,
    MG_CE_NOT_SCORED
} mg_candidate_ce_status_t;

typedef struct {
    int original_rank;
    int rank;
    double s_vec;
    double s_lex;
    float s_ce;
    bool has_s_vec;
    bool has_s_lex;
    bool has_s_ce;
    mg_candidate_ce_status_t ce_status;
    size_t document_bytes;
} mg_candidate_result_t;

typedef struct {
    mg_candidate_status_t status;
    const char *reason; /* static diagnostic code; never contains input text */
    bool applied;
    size_t candidate_count;
    size_t scored_count;
    /* Always INPUT order. rank is a stable 1-based permutation only on applied.
     * Any missing/invalid CE score or expired budget keeps ALL original ranks. */
    mg_candidate_result_t results[MG_CANDIDATE_MAX_COUNT];
} mg_candidate_batch_t;

/* Compute-only. No storage, embedding, writer, model load, or ownership transfer.
 * Borrows the existing rerank/verify CE runtime. NULL r means disabled. No NLI
 * or weighted fusion is used. A monotonic budget is checked between pairs; an
 * individual inference OR CE mutex acquisition cannot be preempted here.
 * budget_ms must be 1..8000 (the wire handler supplies the default).
 * Invalid/oversized C input returns MG_ERR_INVALID_ARG without any CE calls. */
mg_err_t mg_candidate_score(mg_rerank_ctx_t *r, const char *query,
                            const mg_candidate_input_t *inputs, size_t count,
                            int budget_ms, mg_candidate_batch_t *out);

/* Strict UTF-8, no NUL. nonblank also rejects Unicode whitespace-only text. */
bool mg_candidate_text_valid(const char *text, size_t bytes, bool nonblank);
const char *mg_candidate_status_name(mg_candidate_status_t status);
const char *mg_candidate_ce_status_name(mg_candidate_ce_status_t status);

/* Serializers append fields inside an OPEN map; floats are finite-or-nil.
 * Summary fields: version/status/reason/applied/method/candidate_count/scored_count.
 * Signal fields: s_vec/s_lex/s_ce/ce_status/s_lex_source/document_bytes. */
void mg_candidate_write_summary_fields(mpack_writer_t *w,
                                        const mg_candidate_batch_t *batch);
void mg_candidate_write_signal_fields(mpack_writer_t *w,
                                       const mg_candidate_result_t *result);

#endif
