/* mg_op_stats — runtime metrics & similarity distribution percentiles.
 *
 * Result map (handler writes a single mpack VALUE):
 *   {
 *     "n_nodes":    int,
 *     "n_edges":    int,
 *     "n_keywords": int,
 *     "distributions": {
 *       "insert_topk": { p25, p50, p75, p90, p95, p99 },
 *       "query_top1":  { p25, p50, p75, p90, p95, p99 }
 *     }
 *   }
 *
 * Sample kind convention (matches insert/query handlers):
 *   kind=0  "insert_topk"   (cosine of edge candidates at insert time)
 *   kind=1  "query_top1"    (cosine of best candidate at query time)
 */

#include "graft/ops.h"
#include "graft/storage.h"
#include "graft/error.h"
#include "mpack.h"

#define MG_STATS_KIND_INSERT_TOPK 0
#define MG_STATS_KIND_QUERY_TOP1  1

static void write_pct_map(mpack_writer_t *w, const float pct[6]) {
    static const char *const labels[6] = {
        "p25", "p50", "p75", "p90", "p95", "p99"
    };
    mpack_build_map(w);
    for (int i = 0; i < 6; i++) {
        mpack_write_cstr(w, labels[i]);
        mpack_write_float(w, pct[i]);
    }
    mpack_complete_map(w);
}

mg_err_t mg_op_stats(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
    (void)args;
    if (!ctx || !ctx->storage || !result) return MG_ERR_INVALID_ARG;

    float pct_insert[6] = {0};
    float pct_query [6] = {0};

    /* Best-effort: missing samples produce zeros without failing the call. */
    (void)mg_storage_distribution_percentiles(ctx->storage,
                                              MG_STATS_KIND_INSERT_TOPK,
                                              pct_insert);
    (void)mg_storage_distribution_percentiles(ctx->storage,
                                              MG_STATS_KIND_QUERY_TOP1,
                                              pct_query);

    int64_t n_nodes = 0, n_edges = 0, n_keywords = 0;
    /* Best-effort: a count failure (corrupt DB, locked) is not fatal — we
     * still want the percentile portion of the report. */
    (void)mg_storage_count(ctx->storage, MG_STORAGE_COUNT_NODES,    &n_nodes);
    (void)mg_storage_count(ctx->storage, MG_STORAGE_COUNT_EDGES,    &n_edges);
    (void)mg_storage_count(ctx->storage, MG_STORAGE_COUNT_KEYWORDS, &n_keywords);

    mpack_build_map(result);

    mpack_write_cstr(result, "n_nodes");    mpack_write_int(result, n_nodes);
    mpack_write_cstr(result, "n_edges");    mpack_write_int(result, n_edges);
    mpack_write_cstr(result, "n_keywords"); mpack_write_int(result, n_keywords);

    mpack_write_cstr(result, "distributions");
    mpack_build_map(result);

    mpack_write_cstr(result, "insert_topk");
    write_pct_map(result, pct_insert);

    mpack_write_cstr(result, "query_top1");
    write_pct_map(result, pct_query);

    mpack_complete_map(result);  /* distributions */
    mpack_complete_map(result);  /* root          */

    return MG_OK;
}
