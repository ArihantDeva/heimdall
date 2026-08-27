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
#include "graft/rerank.h"
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
    float        rrf;
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
    memcpy(cands[*n].id, id, MG_NODE_ID_BYTES);
    cands[*n].rrf = 0.0f;
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

    /* Optional second-stage rerank over the first min(n_keep, rerank_top_k)
     * candidates. When rerank is disabled, this block is a no-op and the
     * pipeline output is bit-for-bit identical to the pre-rerank behavior. */
    if (ctx->rerank && mg_rerank_enabled((mg_rerank_ctx_t *)ctx->rerank)) {
        int n_rer = n_keep < ctx->config->rerank_top_k
                    ? n_keep : ctx->config->rerank_top_k;
        if (n_rer < 0) n_rer = 0;
        if (n_rer > MG_RETRIEVE_MAX_TOP_K) n_rer = MG_RETRIEVE_MAX_TOP_K;

        char *rerank_titles[MG_RETRIEVE_MAX_TOP_K];
        int   n_rerank_titles = 0;
        mg_rerank_input_t rer_in[MG_RETRIEVE_MAX_TOP_K];
        mg_rerank_output_t rer_out[MG_RETRIEVE_MAX_TOP_K];

        for (int i = 0; i < n_rer; i++) {
            /* Look up cosine score from the vector candidate list (if the
             * candidate came from FTS only, leave s_vec as NaN). */
            float s_vec = NAN;
            for (int j = 0; j < n_vec; j++) {
                if (memcmp(r_vec[j].id, cands[i].id, MG_NODE_ID_BYTES) == 0) {
                    s_vec = r_vec[j].score;
                    break;
                }
            }

            /* Fetch title for trigram Jaccard + CE prompt. */
            mg_node_t node = {0};
            const char *title = "";
            if (mg_storage_get_node(ctx->storage, cands[i].id, &node) == MG_OK) {
                title = node.title ? node.title : "";
            }
            float s_lex = mg_text_trigram_jaccard(text, title);

            /* Stash a heap-owned copy of the title so it survives past the
             * node free below — rerank may need it for CE. */
            char *title_copy = NULL;
            if (title[0]) {
                size_t tlen = strlen(title);
                title_copy = (char *)malloc(tlen + 1u);
                if (title_copy) memcpy(title_copy, title, tlen + 1u);
            }
            rerank_titles[i] = title_copy;
            n_rerank_titles = i + 1;

            rer_in[i].id = &cands[i].id;
            rer_in[i].candidate_text = title_copy ? title_copy : "";
            rer_in[i].s_vec = s_vec;
            rer_in[i].s_lex = s_lex;

            mg_node_free(&node);
        }

        if (mg_rerank_batch((mg_rerank_ctx_t *)ctx->rerank,
                             text, rer_in, n_rer, rer_out) == MG_OK) {
            /* Replace the rrf score with the fused score for these
             * candidates. NaN (no signal at all) falls back to the original
             * RRF rank by leaving the score untouched. */
            for (int i = 0; i < n_rer; i++) {
                if (!isnan(rer_out[i].fused)) {
                    cands[i].rrf = rer_out[i].fused;
                }
            }
            /* Re-sort only the rerank window; everything past n_rer keeps
             * its RRF rank. The window is at the head of the array so a
             * partial qsort is correct here. */
            qsort(cands, (size_t)n_rer, sizeof(cands[0]), cmp_cand_rrf_desc);
        }

        for (int i = 0; i < n_rerank_titles; i++) {
            free(rerank_titles[i]);
        }
    }

    /* Distinct keywords accumulator (keyword_id -> text). */
    mg_keyword_id_t distinct_ids[MG_RETRIEVE_MAX_DISTINCT_KW];
    char           *distinct_txt[MG_RETRIEVE_MAX_DISTINCT_KW];
    int             n_distinct = 0;

    /* Write the outer map with two keys. */
    mpack_build_map(w);

    /* "results" array */
    mpack_write_cstr(w, "results");
    mpack_build_array(w);

    for (int i = 0; i < n_keep; i++) {
        mg_node_t node = {0};
        if (mg_storage_get_node(ctx->storage, cands[i].id, &node) != MG_OK) {
            continue;
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
        mpack_write_cstr(w, node.title ? node.title : "");

        mpack_write_cstr(w, "score");
        mpack_write_float(w, cands[i].rrf);

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

        mg_node_free(&node);
    }

    mpack_complete_array(w);

    /* "distinct_keywords" array */
    mpack_write_cstr(w, "distinct_keywords");
    mpack_build_array(w);
    for (int d = 0; d < n_distinct; d++) {
        mpack_write_cstr(w, distinct_txt[d] ? distinct_txt[d] : "");
        free(distinct_txt[d]);
    }
    mpack_complete_array(w);

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
