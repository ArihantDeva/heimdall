/* Additive compute-only daemon handler. This TU intentionally has no storage
 * or embedding calls: ctx.storage and ctx.embed may both be NULL. */
#include "graft/candidate_scorer.h"
#include "graft/ops.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

static void write_finite(mpack_writer_t *w, double value, bool present) {
    if (present && isfinite(value)) mpack_write_double(w, value);
    else mpack_write_nil(w);
}

void mg_candidate_write_summary_fields(mpack_writer_t *w,
                                        const mg_candidate_batch_t *batch) {
    mpack_write_cstr(w, "version"); mpack_write_int(w, 1);
    mpack_write_cstr(w, "status");
    mpack_write_cstr(w, mg_candidate_status_name(batch->status));
    mpack_write_cstr(w, "reason"); mpack_write_cstr(w, batch->reason);
    mpack_write_cstr(w, "applied"); mpack_write_bool(w, batch->applied);
    mpack_write_cstr(w, "method");
    mpack_write_cstr(w, batch->applied ? "cross_encoder" : "original_order");
    mpack_write_cstr(w, "candidate_count"); mpack_write_u64(w, batch->candidate_count);
    mpack_write_cstr(w, "scored_count"); mpack_write_u64(w, batch->scored_count);
}

void mg_candidate_write_signal_fields(mpack_writer_t *w,
                                       const mg_candidate_result_t *res) {
    mpack_write_cstr(w, "s_vec"); write_finite(w, res->s_vec, res->has_s_vec);
    mpack_write_cstr(w, "s_lex"); write_finite(w, res->s_lex, res->has_s_lex);
    mpack_write_cstr(w, "s_ce"); write_finite(w, res->s_ce, res->has_s_ce);
    mpack_write_cstr(w, "ce_status");
    mpack_write_cstr(w, mg_candidate_ce_status_name(res->ce_status));
    mpack_write_cstr(w, "s_lex_source");
    mpack_write_cstr(w, "title_trigram_jaccard");
    mpack_write_cstr(w, "document_bytes"); mpack_write_u64(w, res->document_bytes);
}

/* Fixed flat schemas also reject duplicate/unknown/non-string keys without
 * recursing into attacker-controlled containers. MPack lookups alone would
 * not reject an unknown key duplicated somewhere else in the map. */
static bool map_keys(mpack_node_t map, const char *const *keys,
                      size_t key_count, unsigned required) {
    if (mpack_node_type(map) != mpack_type_map ||
        mpack_node_map_count(map) > key_count) return false;
    unsigned seen = 0;
    for (size_t i = 0; i < mpack_node_map_count(map); ++i) {
        mpack_node_t key = mpack_node_map_key_at(map, i);
        if (mpack_node_type(key) != mpack_type_str) return false;
        const char *s = mpack_node_str(key);
        size_t len = mpack_node_strlen(key);
        size_t j;
        for (j = 0; j < key_count; ++j)
            if (len == strlen(keys[j]) && memcmp(s, keys[j], len) == 0) break;
        if (j == key_count || (seen & (1u << j))) return false;
        seen |= 1u << j;
    }
    return (seen & required) == required;
}

static mg_err_t copy_string(mpack_node_t node, size_t max, bool nonempty,
                             bool nonblank, const char **out, size_t *total) {
    if (mpack_node_type(node) != mpack_type_str) return MG_ERR_INVALID_ARG;
    size_t len = mpack_node_strlen(node);
    if (len > max || (nonempty && !len) ||
        !mg_candidate_text_valid(mpack_node_str(node), len, nonblank) ||
        len > MG_CANDIDATE_MAX_REQUEST_BYTES - *total) return MG_ERR_INVALID_ARG;
    *total += len;
    *out = mpack_node_cstr_alloc(node, max + 1u);
    return *out ? MG_OK : MG_ERR_OOM;
}

mg_err_t mg_op_score_candidates(mg_ctx_t *ctx, mpack_node_t args,
                                 mpack_writer_t *result) {
    static const char *const arg_keys[] = {"query", "candidates", "budget_ms"};
    static const char *const cand_keys[] = {"id", "title", "document", "s_vec"};
    if (!ctx || !result || !map_keys(args, arg_keys, 3, 3u)) return MG_ERR_INVALID_ARG;

    int budget_ms = MG_CANDIDATE_MAX_BUDGET_MS;
    mpack_node_t budget = mpack_node_map_cstr_optional(args, "budget_ms");
    if (!mpack_node_is_missing(budget)) {
        if (mpack_node_type(budget) == mpack_type_uint) {
            uint64_t b = mpack_node_u64(budget);
            if (!b || b > MG_CANDIDATE_MAX_BUDGET_MS) return MG_ERR_INVALID_ARG;
            budget_ms = (int)b;
        } else if (mpack_node_type(budget) == mpack_type_int) {
            int64_t b = mpack_node_i64(budget);
            if (b < 1 || b > MG_CANDIDATE_MAX_BUDGET_MS) return MG_ERR_INVALID_ARG;
            budget_ms = (int)b;
        } else return MG_ERR_INVALID_ARG;
    }
    mpack_node_t list = mpack_node_map_cstr(args, "candidates");
    if (mpack_node_type(list) != mpack_type_array) return MG_ERR_INVALID_ARG;
    size_t count = mpack_node_array_length(list);
    if (count > MG_CANDIDATE_MAX_COUNT) return MG_ERR_INVALID_ARG;

    mg_candidate_input_t inputs[MG_CANDIDATE_MAX_COUNT] = {0};
    const char *query = NULL;
    size_t total = 0;
    mg_err_t err = copy_string(mpack_node_map_cstr(args, "query"),
                               MG_CANDIDATE_MAX_QUERY_BYTES, true, true, &query, &total);
    if (err != MG_OK) goto done;
    for (size_t i = 0; i < count; ++i) {
        mpack_node_t cand = mpack_node_array_at(list, i);
        if (!map_keys(cand, cand_keys, 4, 15u)) { err = MG_ERR_INVALID_ARG; goto done; }
        err = copy_string(mpack_node_map_cstr(cand, "id"),
                           MG_CANDIDATE_MAX_ID_BYTES, true, false, &inputs[i].id, &total);
        if (err != MG_OK) goto done;
        for (size_t j = 0; j < i; ++j) {
            if (strcmp(inputs[i].id, inputs[j].id) == 0) { err = MG_ERR_INVALID_ARG; goto done; }
        }
        err = copy_string(mpack_node_map_cstr(cand, "title"),
                           MG_CANDIDATE_MAX_TITLE_BYTES, false, false, &inputs[i].title, &total);
        if (err != MG_OK) goto done;
        err = copy_string(mpack_node_map_cstr(cand, "document"),
                           MG_CANDIDATE_MAX_DOCUMENT_BYTES, false, false, &inputs[i].document, &total);
        if (err != MG_OK) goto done;
        mpack_node_t vec = mpack_node_map_cstr(cand, "s_vec");
        if (mpack_node_type(vec) == mpack_type_nil) continue;
        mpack_type_t type = mpack_node_type(vec);
        if (type != mpack_type_float && type != mpack_type_double &&
            type != mpack_type_int && type != mpack_type_uint) { err = MG_ERR_INVALID_ARG; goto done; }
        inputs[i].s_vec = mpack_node_double(vec);
        inputs[i].has_s_vec = true;
        if (!isfinite(inputs[i].s_vec)) { err = MG_ERR_INVALID_ARG; goto done; }
    }
    if (mpack_node_error(args) != mpack_ok) { err = MG_ERR_INVALID_ARG; goto done; }

    mg_candidate_batch_t batch;
    err = mg_candidate_score((mg_rerank_ctx_t *)ctx->rerank, query, inputs,
                             count, budget_ms, &batch);
    if (err != MG_OK) goto done;
    mpack_build_map(result);
    mg_candidate_write_summary_fields(result, &batch);
    mpack_write_cstr(result, "results");
    mpack_start_array(result, (uint32_t)count);
    for (size_t i = 0; i < count; ++i) {
        mpack_build_map(result);
        mpack_write_cstr(result, "id"); mpack_write_cstr(result, inputs[i].id);
        mpack_write_cstr(result, "original_rank"); mpack_write_int(result, batch.results[i].original_rank);
        mpack_write_cstr(result, "rank"); mpack_write_int(result, batch.results[i].rank);
        mg_candidate_write_signal_fields(result, &batch.results[i]);
        mpack_complete_map(result);
    }
    mpack_finish_array(result);
    mpack_complete_map(result);

done:
    free((void *)query);
    for (size_t i = 0; i < count; ++i) {
        free((void *)inputs[i].id);
        free((void *)inputs[i].title);
        free((void *)inputs[i].document);
    }
    return err;
}
