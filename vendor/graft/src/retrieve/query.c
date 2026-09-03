/* mg_op_query: cache lookup with multi-signal gating.
 *
 * Decision flow:
 *   1. Embed query text -> q.
 *   2. vector_topk(q, 1) -> top1.
 *   3. Sanity floor: if no candidate or s_vec < 0.3 -> MISS + fallback retrieve.
 *   4. Get candidate node, compute s_lex via trigram Jaccard.
 *   5. mg_verify_score() fills s_jaccard, s_ce, hit_level.
 *   6. STRONG -> touch_access, return title+body.
 *      WEAK   -> return title only (no body).
 *      NONE   -> MISS + fallback retrieve.
 *
 * Side effects:
 *   - On STRONG hit: mg_storage_touch_access(top1.id).
 *   - On any non-empty top1 (HIT or MISS): record_sample(kind=1, s_vec).
 *   - signals_only=true suppresses BOTH side effects (read-only inspection).
 *
 * Result map (handler writes a single mpack VALUE):
 *
 *  HIT (STRONG | WEAK):
 *   { "hit": "STRONG"|"WEAK", "id_hex", "title",
 *     "body": string|nil,
 *     "signals": { s_vec, s_lex, s_jaccard, s_ce|nil } }
 *
 *  MISS:
 *   { "hit": "MISS",
 *     "fallback_retrieve": { results, distinct_keywords },
 *     "signals": { ... } }
 */

#include "internal.h"
#include "graft/storage.h"
#include "graft/embed.h"
#include "graft/verify.h"
#include "graft/config.h"
#include "graft/types.h"
#include "graft/error.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#define MG_QUERY_VEC_SANITY_FLOOR 0.3f
#define MG_QUERY_SAMPLE_KIND      1   /* "query_top1" */

static const char *hit_label(mg_hit_t h) {
    switch (h) {
        case MG_HIT_STRONG: return "STRONG";
        case MG_HIT_WEAK:   return "WEAK";
        default:            return "NONE";
    }
}

static void write_signals_map(mpack_writer_t *w,
                              const mg_verify_signals_t *sig) {
    mpack_build_map(w);
    mpack_write_cstr(w, "s_vec");     mpack_write_float(w, sig->s_vec);
    mpack_write_cstr(w, "s_lex");     mpack_write_float(w, sig->s_lex);
    mpack_write_cstr(w, "s_jaccard"); mpack_write_float(w, sig->s_jaccard);
    mpack_write_cstr(w, "s_ce");
    if (!isnan(sig->s_ce)) mpack_write_float(w, sig->s_ce);
    else                   mpack_write_nil(w);
    mpack_complete_map(w);
}

static void write_miss(mg_ctx_t *ctx,
                       const char *text,
                       const mg_embedding_t q,
                       const mg_verify_signals_t *sig,
                       mpack_writer_t *result) {
    mpack_build_map(result);

    mpack_write_cstr(result, "hit");
    mpack_write_cstr(result, "MISS");

    mpack_write_cstr(result, "fallback_retrieve");
    /* Run RRF; if it fails internally we still want a map placeholder.
     * Use a tighter cap than the standalone retrieve op: a MISS fallback is a
     * "by the way" hint, not the answer, and a wide list of neighbors can blow
     * the agent's context on broad queries (e.g. single-keyword lookups). */
    int fallback_k = ctx->config->query_fallback_top_k;
    if (fallback_k <= 0) fallback_k = 5;
    if (fallback_k > ctx->config->retrieve_top_k && ctx->config->retrieve_top_k > 0)
        fallback_k = ctx->config->retrieve_top_k;
    if (mg_retrieve_run_rrf(ctx, text, q,
                            fallback_k, result) != MG_OK) {
        /* run_rrf may have left writer in error state. Best-effort: write nil. */
        mpack_write_nil(result);
    }

    mpack_write_cstr(result, "signals");
    write_signals_map(result, sig);

    mpack_complete_map(result);
}

static float query_verification_rank(const mg_verify_signals_t *sig) {
    float ce = !isnan(sig->s_ce) ? sig->s_ce : 0.0f;
    float level = 0.0f;

    if (sig->hit_level == MG_HIT_STRONG) {
        level = 2.0f;
    } else if (sig->hit_level == MG_HIT_WEAK) {
        level = 1.0f;
    }

    return level +
           (0.45f * ce) +
           (0.25f * sig->s_lex) +
           (0.20f * sig->s_jaccard) +
           (0.10f * sig->s_vec);
}

mg_err_t mg_op_query(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
    enum { QUERY_VERIFY_TOP_K = 10 };

    if (!ctx || !ctx->storage || !ctx->embed || !ctx->config || !result)
        return MG_ERR_INVALID_ARG;

    char *text = mg_retrieve_node_str_dup(mpack_node_map_cstr(args, "text"));
    if (!text) return MG_ERR_INVALID_ARG;

    bool signals_only = false;
    mpack_node_t so_node = mpack_node_map_cstr_optional(args, "signals_only");
    if (!mpack_node_is_missing(so_node) && !mpack_node_is_nil(so_node)) {
        if (mpack_node_type(so_node) != mpack_type_bool) {
            free(text);
            return MG_ERR_INVALID_ARG;
        }
        signals_only = mpack_node_bool(so_node);
    }

    mg_embedding_t q;
    mg_err_t e = mg_embed_text(ctx->embed, text, q);
    if (e != MG_OK) { free(text); return e; }

    mg_node_score_t candidates[QUERY_VERIFY_TOP_K];
    int n_candidates = 0;
    e = mg_storage_vector_topk(ctx->storage, q, QUERY_VERIFY_TOP_K,
                               candidates, &n_candidates);
    if (e != MG_OK) { free(text); return e; }

    /* No candidate at all: pure MISS, no signals available. */
    if (n_candidates == 0) {
        mg_verify_signals_t empty = {0};
        empty.s_ce = NAN;
        empty.hit_level = MG_HIT_NONE;
        write_miss(ctx, text, q, &empty, result);
        free(text);
        return MG_OK;
    }

    if (!signals_only) {
        (void)mg_storage_record_sample(ctx->storage,
                                       MG_QUERY_SAMPLE_KIND,
                                       candidates[0].score);
    }

    /* Sanity floor before paying for verify: definite MISS. Vector results are
     * sorted descending, so if top-1 is below floor every later candidate is too. */
    if (candidates[0].score < MG_QUERY_VEC_SANITY_FLOOR) {
        mg_verify_signals_t sig = {0};
        sig.s_vec = candidates[0].score;
        sig.s_ce = NAN;
        sig.hit_level = MG_HIT_NONE;
        write_miss(ctx, text, q, &sig, result);
        free(text);
        return MG_OK;
    }

    mg_node_t best_node = {0};
    mg_node_id_t best_id = {0};
    mg_verify_signals_t best_sig = {0};
    best_sig.s_ce = NAN;
    best_sig.hit_level = MG_HIT_NONE;
    float best_rank = -1.0f;
    bool have_best_hit = false;

    mg_verify_signals_t best_miss_sig = {0};
    best_miss_sig.s_ce = NAN;
    best_miss_sig.hit_level = MG_HIT_NONE;
    float best_miss_rank = -1.0f;

    for (int i = 0; i < n_candidates; ++i) {
        if (candidates[i].score < MG_QUERY_VEC_SANITY_FLOOR) {
            continue;
        }

        mg_node_t cand = {0};
        e = mg_storage_get_node(ctx->storage, candidates[i].id, &cand);
        if (e != MG_OK) {
            mg_node_free(&best_node);
            free(text);
            return e;
        }

        /* MVP s_lex proxy: trigram Jaccard between query text and candidate
         * title (BM25 scores aren't directly comparable across queries
         * without per-query normalization, and Jaccard is bounded in [0,1]). */
        float s_lex = mg_text_trigram_jaccard(text,
                                              cand.title ? cand.title : "");

        mg_verify_signals_t sig = {0};
        sig.s_ce = NAN;
        e = mg_verify_score((mg_verify_ctx_t *)ctx->verify,
                            text, cand.title ? cand.title : "",
                            candidates[i].score, s_lex, &sig);
        if (e != MG_OK) {
            mg_node_free(&cand);
            mg_node_free(&best_node);
            free(text);
            return e;
        }

        float rank = query_verification_rank(&sig);
        if (sig.hit_level == MG_HIT_STRONG || sig.hit_level == MG_HIT_WEAK) {
            if (!have_best_hit || rank > best_rank) {
                mg_node_free(&best_node);
                best_node = cand;
                cand = (mg_node_t){0};
                memcpy(best_id, candidates[i].id, MG_NODE_ID_BYTES);
                best_sig = sig;
                best_rank = rank;
                have_best_hit = true;
            }
        } else if (rank > best_miss_rank) {
            best_miss_sig = sig;
            best_miss_rank = rank;
        }

        mg_node_free(&cand);
    }

    if (have_best_hit) {
        if (!signals_only && best_sig.hit_level == MG_HIT_STRONG) {
            (void)mg_storage_touch_access(ctx->storage, best_id);
        }

        char id_hex[2 * MG_NODE_ID_BYTES + 1];
        mg_retrieve_hex_encode(best_id, MG_NODE_ID_BYTES, id_hex);

        mpack_build_map(result);

        mpack_write_cstr(result, "hit");
        mpack_write_cstr(result, hit_label(best_sig.hit_level));

        mpack_write_cstr(result, "id_hex");
        mpack_write_cstr(result, id_hex);

        mpack_write_cstr(result, "title");
        mpack_write_cstr(result, best_node.title ? best_node.title : "");

        mpack_write_cstr(result, "body");
        if (best_sig.hit_level == MG_HIT_STRONG) {
            mpack_write_cstr(result, best_node.body ? best_node.body : "");
        } else {
            mpack_write_nil(result);
        }

        mpack_write_cstr(result, "signals");
        write_signals_map(result, &best_sig);

        mpack_complete_map(result);

        mg_node_free(&best_node);
        free(text);
        return MG_OK;
    }

    /* MG_HIT_NONE: MISS with fallback, carrying the strongest verified miss. */
    mg_node_free(&best_node);
    write_miss(ctx, text, q, &best_miss_sig, result);
    free(text);
    return MG_OK;
}
