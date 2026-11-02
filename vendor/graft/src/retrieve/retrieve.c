/* mg_op_retrieve: hybrid lexical+semantic retrieval via Reciprocal Rank Fusion.
 *
 * Three ranked lists are fused:
 *   R_vec     = vector top-k on title embedding (cosine)
 *   R_bm25_t  = FTS5 BM25 over title
 *   R_bm25_b  = FTS5 BM25 over body
 *
 * RRF: score(id) = sum_i 1 / (k + rank_i(id)),  rank starts at 1.
 *
 * Result map (handler writes a single mpack VALUE at writer's current position):
 *   {
 *     "results":           [ { "id_hex","title","score","keywords":[...] }, ... ],
 *     "distinct_keywords": [ string, ... ]
 *   }
 */

#include "internal.h"
#include "graft/storage.h"
#include "graft/embed.h"
#include "graft/config.h"
#include "graft/types.h"
#include "graft/error.h"
#include "graft/candidate_scorer.h"
#include "graft/verify.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define MG_RETRIEVE_PER_LIST_K   50
#define MG_RETRIEVE_MAX_CAND    (3 * MG_RETRIEVE_PER_LIST_K)
#define MG_RETRIEVE_MAX_TOP_K    256
#define MG_RETRIEVE_MAX_KW_PER   32
#define MG_RETRIEVE_MAX_DISTINCT_KW 256

typedef struct {
    mg_node_id_t id;
    float        rrf;        /* never overwritten by reranking */
    int          rrf_rank;   /* rank in the frozen RRF list */
    mg_candidate_result_t signals; /* moves WITH the candidate identity */
    const char  *document_source;
    const char  *s_vec_source;
} mg_cand_t;

/* ----- hex helpers ----- */

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
    if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
    return -1;
}

void mg_retrieve_hex_encode(const uint8_t *bytes, size_t len, char *out) {
    static const char digits[] = "0123456789abcdef";
    if (!bytes || !out) return;
    for (size_t i = 0; i < len; i++) {
        out[2 * i]     = digits[(bytes[i] >> 4) & 0xF];
        out[2 * i + 1] = digits[ bytes[i]       & 0xF];
    }
    out[2 * len] = '\0';
}

int mg_retrieve_hex_decode(const char *hex, size_t hex_len,
                           uint8_t *out, size_t out_len) {
    if (!hex || !out) return -1;
    if (hex_len != 2 * out_len) return -1;
    for (size_t i = 0; i < out_len; i++) {
        int hi = hex_nibble(hex[2 * i]);
        int lo = hex_nibble(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 0;
}

/* ----- mpack helpers ----- */

char *mg_retrieve_node_str_dup(mpack_node_t node) {
    /* mpack_node_cstr_alloc allocates and NUL-terminates; rejects nodes
     * containing embedded NULs and non-string types. */
    return mpack_node_cstr_alloc(node, 1u << 20);  /* 1 MiB cap */
}

/* ----- node keyword collection ----- */

mg_err_t mg_retrieve_node_keywords(mg_storage_t *s,
                                   const mg_node_id_t node_id,
                                   mg_keyword_id_t *out_kw,
                                   int *out_n,
                                   int max_kw) {
    if (!s || !out_kw || !out_n || max_kw <= 0) return MG_ERR_INVALID_ARG;
    /* Read the ownership table directly. Walking MG_EDGE_KEYWORD edges only
     * surfaces keywords shared with at least one peer node — a brand-new
     * node with no peers would appear keyword-less, which is wrong. */
    return mg_storage_node_keywords(s, node_id, out_kw, max_kw, out_n);
}

/* ----- RRF fusion ----- */

static int find_or_add_cand(mg_cand_t *cands, int *n,
                            const mg_node_id_t id) {
    for (int i = 0; i < *n; i++) {
        if (memcmp(cands[i].id, id, MG_NODE_ID_BYTES) == 0) return i;
    }
    if (*n >= MG_RETRIEVE_MAX_CAND) return -1;
    memset(&cands[*n], 0, sizeof(cands[*n]));
    memcpy(cands[*n].id, id, MG_NODE_ID_BYTES);
    return (*n)++;
}

static void apply_rrf(mg_cand_t *cands, int *n,
                      const mg_node_score_t *list, int list_n,
                      float k_const) {
    for (int rank = 0; rank < list_n; rank++) {
        int idx = find_or_add_cand(cands, n, list[rank].id);
        if (idx < 0) return;  /* candidate pool full */
        cands[idx].rrf += 1.0f / (k_const + (float)(rank + 1));
    }
}

static int cmp_cand_rrf_desc(const void *a, const void *b) {
    const mg_cand_t *ca = (const mg_cand_t *)a;
    const mg_cand_t *cb = (const mg_cand_t *)b;
    if (ca->rrf > cb->rrf) return -1;
    if (ca->rrf < cb->rrf) return  1;
    return 0;
}

/* ----- core: write { "results", "distinct_keywords" } map ----- */

mg_err_t mg_retrieve_run_rrf(mg_ctx_t *ctx,
                             const char *text,
                             const mg_embedding_t q,
                             int top_k,
                             mpack_writer_t *w) {
    if (!ctx || !ctx->storage || !ctx->config || !text || !w)
        return MG_ERR_INVALID_ARG;

    if (top_k <= 0) top_k = ctx->config->retrieve_top_k;
    if (top_k <= 0) top_k = 25;
    if (top_k > MG_RETRIEVE_MAX_TOP_K) top_k = MG_RETRIEVE_MAX_TOP_K;

    const float k_const = (float)(ctx->config->rrf_k_const > 0
                                  ? ctx->config->rrf_k_const : 60);

    mg_node_score_t r_vec[MG_RETRIEVE_PER_LIST_K];
    mg_node_score_t r_sum[MG_RETRIEVE_PER_LIST_K];
    mg_node_score_t r_det[MG_RETRIEVE_PER_LIST_K];
    int n_vec = 0, n_sum = 0, n_det = 0;

    mg_err_t e;
    e = mg_storage_vector_topk(ctx->storage, q,
                               MG_RETRIEVE_PER_LIST_K, r_vec, &n_vec);
    if (e != MG_OK) { n_vec = 0; }

    e = mg_storage_fts_search(ctx->storage, text, MG_RETRIEVE_PER_LIST_K,
                              true, false, r_sum, &n_sum);
    if (e != MG_OK) { n_sum = 0; }

    e = mg_storage_fts_search(ctx->storage, text, MG_RETRIEVE_PER_LIST_K,
                              false, true, r_det, &n_det);
    if (e != MG_OK) { n_det = 0; }

    mg_cand_t cands[MG_RETRIEVE_MAX_CAND];
    int n_cands = 0;
    apply_rrf(cands, &n_cands, r_vec, n_vec, k_const);
    apply_rrf(cands, &n_cands, r_sum, n_sum, k_const);
    apply_rrf(cands, &n_cands, r_det, n_det, k_const);

    qsort(cands, (size_t)n_cands, sizeof(cands[0]), cmp_cand_rrf_desc);

    int n_keep = n_cands < top_k ? n_cands : top_k;

    /* Freeze membership AND original RRF evidence before any scoring. Nothing
     * beyond min(existing rerank_top_k,25,n_keep) can be reordered. */
    for (int i = 0; i < n_keep; ++i) {
        cands[i].rrf_rank = i + 1;
        cands[i].signals.original_rank = cands[i].signals.rank = i + 1;
        cands[i].signals.ce_status = MG_CE_NOT_SCORED;
        cands[i].document_source = "unavailable";
        cands[i].s_vec_source = "unavailable";
        for (int j = 0; j < n_vec; ++j) {
            if (memcmp(r_vec[j].id, cands[i].id, MG_NODE_ID_BYTES) == 0) {
                if (isfinite(r_vec[j].score)) {
                    cands[i].signals.s_vec = r_vec[j].score;
                    cands[i].signals.has_s_vec = true;
                    cands[i].s_vec_source = "vector_topk";
                }
                break;
            }
        }
    }
    int n_rer = ctx->config->rerank_top_k;
    if (n_rer < 0) n_rer = 0;
    if (n_rer > n_keep) n_rer = n_keep;
    if (n_rer > (int)MG_CANDIDATE_MAX_COUNT) n_rer = (int)MG_CANDIDATE_MAX_COUNT;

    /* Retain at most 25 fetched nodes until serialization. These are indexed
     * by ORIGINAL RRF rank, not the possibly reordered position. This avoids
     * fetching/scoring different versions of a window node and, when disabled,
     * still makes exactly one get_node call per returned candidate. */
    mg_node_t window_nodes[MG_CANDIDATE_MAX_COUNT] = {0};
    bool window_found[MG_CANDIDATE_MAX_COUNT] = {false};
    char ids[MG_CANDIDATE_MAX_COUNT][2 * MG_NODE_ID_BYTES + 1];
    mg_candidate_input_t inputs[MG_CANDIDATE_MAX_COUNT] = {0};
    for (int i = 0; i < n_rer; ++i) {
        mg_retrieve_hex_encode(cands[i].id, MG_NODE_ID_BYTES, ids[i]);
        inputs[i].id = ids[i];
        inputs[i].s_vec = cands[i].signals.s_vec;
        inputs[i].has_s_vec = cands[i].signals.has_s_vec;
        window_found[i] = mg_storage_get_node(ctx->storage, cands[i].id,
                                              &window_nodes[i]) == MG_OK;
        if (window_found[i]) {
            const mg_node_t *node = &window_nodes[i];
            inputs[i].title = node->title;
            inputs[i].document = node->body && node->body[0] ? node->body : node->title;
            cands[i].document_source = node->body && node->body[0]
                                       ? "body" : (node->title ? "title_fallback" : "unavailable");
            cands[i].signals.document_bytes = inputs[i].document ? strlen(inputs[i].document) : 0;
        }
    }

    mg_candidate_batch_t batch;
    mg_err_t score_err = mg_candidate_score((mg_rerank_ctx_t *)ctx->rerank,
                                             text, inputs, (size_t)n_rer,
                                             MG_CANDIDATE_MAX_BUDGET_MS, &batch);
    if (score_err != MG_OK) {
        /* Native nodes can predate the wire byte limits. Never truncate their
         * bodies to manufacture a score: explicit whole-window fallback. */
        memset(&batch, 0, sizeof(batch));
        batch.status = MG_CANDIDATE_FAILED;
        batch.reason = "input_limits";
        batch.candidate_count = (size_t)n_rer;
        for (int i = 0; i < n_rer; ++i) {
            cands[i].signals.ce_status = MG_CE_FAILED;
            if (inputs[i].title) {
                float lex = NAN;
                bool lex_ok = mg_text_trigram_jaccard_checked(text, inputs[i].title, &lex) == MG_OK;
                cands[i].signals.s_lex = lex;
                cands[i].signals.has_s_lex = lex_ok && isfinite(lex);
            }
            batch.results[i] = cands[i].signals;
        }
    } else {
        for (int i = 0; i < n_rer; ++i) cands[i].signals = batch.results[i];
    }
    if (!n_rer && n_keep) {
        batch.status = MG_CANDIDATE_DISABLED;
        batch.reason = "window_disabled";
    }
    if (batch.applied) {
        /* Unique chosen ranks already encode stable CE ties. Move the entire
         * record, including raw RRF, all signals, and provenance, by identity. */
        for (int i = 1; i < n_rer; ++i) {
            mg_cand_t value = cands[i];
            int j = i;
            while (j > 0 && cands[j - 1].signals.rank > value.signals.rank) {
                cands[j] = cands[j - 1];
                --j;
            }
            cands[j] = value;
        }
    }

    /* Distinct keywords accumulator (keyword_id -> text). */
    mg_keyword_id_t distinct_ids[MG_RETRIEVE_MAX_DISTINCT_KW];
    char           *distinct_txt[MG_RETRIEVE_MAX_DISTINCT_KW];
    int             n_distinct = 0;

    /* Existing fields plus additive, explicitly labeled ranking evidence. */
    mpack_build_map(w);

    /* "results" array */
    mpack_write_cstr(w, "results");
    mpack_build_array(w);

    for (int i = 0; i < n_keep; i++) {
        mg_node_t tail_node = {0};
        mg_node_t *node;
        int original = cands[i].rrf_rank - 1;
        bool in_window = original < n_rer;
        if (in_window) {
            if (!window_found[original]) continue; /* existing missing-node behavior */
            node = &window_nodes[original];
        } else {
            if (mg_storage_get_node(ctx->storage, cands[i].id, &tail_node) != MG_OK) {
                mg_node_free(&tail_node);
                continue;
            }
            node = &tail_node;
            if (node->title) {
                float lex = NAN;
                bool lex_ok = mg_text_trigram_jaccard_checked(text, node->title, &lex) == MG_OK;
                cands[i].signals.s_lex = lex;
                cands[i].signals.has_s_lex = lex_ok && isfinite(lex);
            }
            const char *doc = node->body && node->body[0] ? node->body : node->title;
            cands[i].signals.document_bytes = doc ? strlen(doc) : 0;
            cands[i].document_source = node->body && node->body[0]
                                       ? "body" : (node->title ? "title_fallback" : "unavailable");
        }

        char id_hex[2 * MG_NODE_ID_BYTES + 1];
        mg_retrieve_hex_encode(cands[i].id, MG_NODE_ID_BYTES, id_hex);

        mg_keyword_id_t kw_ids[MG_RETRIEVE_MAX_KW_PER];
        int n_kw = 0;
        (void)mg_retrieve_node_keywords(ctx->storage, cands[i].id,
                                         kw_ids, &n_kw,
                                         MG_RETRIEVE_MAX_KW_PER);

        /* per-result map */
        mpack_build_map(w);

        mpack_write_cstr(w, "id_hex");
        mpack_write_cstr(w, id_hex);

        mpack_write_cstr(w, "title");
        mpack_write_cstr(w, node->title ? node->title : "");

        bool ce_ranked = batch.applied && in_window;
        mpack_write_cstr(w, "score");
        mpack_write_float(w, ce_ranked ? cands[i].signals.s_ce : cands[i].rrf);
        mpack_write_cstr(w, "score_kind");
        mpack_write_cstr(w, ce_ranked ? "cross_encoder" : "rrf");
        mpack_write_cstr(w, "rank"); mpack_write_int(w, i + 1);
        mpack_write_cstr(w, "rrf_rank"); mpack_write_int(w, cands[i].rrf_rank);
        mpack_write_cstr(w, "rrf_score"); mpack_write_float(w, cands[i].rrf);
        mpack_write_cstr(w, "signals");
        mpack_build_map(w);
        mg_candidate_write_signal_fields(w, &cands[i].signals);
        mpack_write_cstr(w, "s_vec_source"); mpack_write_cstr(w, cands[i].s_vec_source);
        mpack_write_cstr(w, "document_source"); mpack_write_cstr(w, cands[i].document_source);
        mpack_complete_map(w);

        mpack_write_cstr(w, "keywords");
        mpack_build_array(w);
        for (int j = 0; j < n_kw; j++) {
            char *kw_text = NULL;
            if (mg_storage_get_keyword_text(ctx->storage, kw_ids[j],
                                             &kw_text) == MG_OK
                && kw_text) {
                mpack_write_cstr(w, kw_text);

                /* aggregate distinct keywords */
                bool seen = false;
                for (int d = 0; d < n_distinct; d++) {
                    if (distinct_ids[d] == kw_ids[j]) { seen = true; break; }
                }
                if (!seen && n_distinct < MG_RETRIEVE_MAX_DISTINCT_KW) {
                    distinct_ids[n_distinct] = kw_ids[j];
                    distinct_txt[n_distinct] = kw_text; /* take ownership */
                    n_distinct++;
                } else {
                    free(kw_text);
                }
            }
        }
        mpack_complete_array(w);

        mpack_complete_map(w);

        mg_node_free(&tail_node);
    }
    for (int i = 0; i < n_rer; ++i) mg_node_free(&window_nodes[i]);

    mpack_complete_array(w);

    /* "distinct_keywords" array */
    mpack_write_cstr(w, "distinct_keywords");
    mpack_build_array(w);
    for (int d = 0; d < n_distinct; d++) {
        mpack_write_cstr(w, distinct_txt[d] ? distinct_txt[d] : "");
        free(distinct_txt[d]);
    }
    mpack_complete_array(w);

    mpack_write_cstr(w, "rerank");
    mpack_build_map(w);
    mg_candidate_write_summary_fields(w, &batch);
    mpack_complete_map(w);

    mpack_complete_map(w);
    return MG_OK;
}

/* ----- public op handler ----- */

mg_err_t mg_op_retrieve(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
    if (!ctx || !ctx->storage || !ctx->embed || !ctx->config || !result)
        return MG_ERR_INVALID_ARG;

    char *text = mg_retrieve_node_str_dup(mpack_node_map_cstr(args, "text"));
    if (!text) return MG_ERR_INVALID_ARG;

    int top_k = ctx->config->retrieve_top_k;
    mpack_node_t topk_node = mpack_node_map_cstr_optional(args, "top_k");
    if (!mpack_node_is_missing(topk_node) && !mpack_node_is_nil(topk_node)) {
        int v = (int)mpack_node_int(topk_node);
        if (v > 0) top_k = v;
    }

    mg_embedding_t q;
    mg_err_t e = mg_embed_text(ctx->embed, text, q);
    if (e != MG_OK) { free(text); return e; }

    e = mg_retrieve_run_rrf(ctx, text, q, top_k, result);
    free(text);
    return e;
}
