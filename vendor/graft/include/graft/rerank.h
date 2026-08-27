#ifndef GRAFT_RERANK_H
#define GRAFT_RERANK_H

#include "graft/config.h"
#include "graft/error.h"
#include "graft/types.h"

#include <stdbool.h>

/* Forward declarations: the rerank module borrows the CE runtime from a
 * verify context but does not load its own model. */
struct mg_verify_ctx;

typedef struct mg_rerank_ctx mg_rerank_ctx_t;

typedef struct {
    const mg_node_id_t *id;     /* borrowed */
    const char *candidate_text; /* borrowed (title) */
    float s_vec;                /* [0,1] or NAN */
    float s_lex;                /* [0,1] or NAN */
} mg_rerank_input_t;

typedef struct {
    float s_ce;     /* computed; NAN if CE unavailable */
    float s_nli;    /* computed via CE+nli template; NAN if NLI disabled or unavailable */
    float fused;    /* final weighted score; NAN if no signal available */
} mg_rerank_output_t;

/* Initialize the rerank context. If cfg->rerank_enabled is false, sets
 * *out = NULL and returns MG_OK (callers should treat NULL as disabled
 * via mg_rerank_enabled). When enabled, borrows verify_ctx_for_ce for CE
 * scoring — does NOT take ownership and does NOT load its own CE model. */
mg_err_t mg_rerank_init(const mg_config_t *cfg,
                        struct mg_verify_ctx *verify_ctx_for_ce,
                        mg_rerank_ctx_t **out);

void     mg_rerank_shutdown(mg_rerank_ctx_t *r);

/* Returns false when r is NULL or rerank is disabled in config. */
bool     mg_rerank_enabled(const mg_rerank_ctx_t *r);

/* Score n candidates against query_text. Writes out[i].s_ce and out[i].fused
 * for each i in [0,n). Sequential CE calls — true batch decoding is a future
 * optimization (see internal.h). */
mg_err_t mg_rerank_batch(mg_rerank_ctx_t *r,
                         const char *query_text,
                         const mg_rerank_input_t *cands, int n,
                         mg_rerank_output_t *out);

#endif
