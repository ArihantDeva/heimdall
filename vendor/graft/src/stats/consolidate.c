/* mg_op_consolidate: safe storage consolidation.
 *
 * The pass improves retrieval/traversal efficiency without destructively
 * merging semantic content:
 *   - prunes expired nodes,
 *   - removes legacy orphan/duplicate/invalid graph rows,
 *   - refreshes SQLite planner statistics,
 *   - reports graph-health signals for future/manual consolidation.
 */

#include "graft/ops.h"
#include "graft/error.h"
#include "mpack.h"

mg_err_t mg_op_consolidate(mg_ctx_t *ctx, mpack_node_t args,
                           mpack_writer_t *result) {
    (void)args;
    if (!ctx || !ctx->storage || !result) return MG_ERR_INVALID_ARG;

    mg_storage_consolidate_report_t report;
    mg_err_t err = mg_storage_consolidate(ctx->storage, &report);
    if (err != MG_OK) return err;

    mpack_build_map(result);

    mpack_write_cstr(result, "deduped");
    mpack_write_int(result, report.duplicate_edges_deleted);

    mpack_write_cstr(result, "contradictions_found");
    mpack_write_int(result, report.contradictions_found);

    mpack_write_cstr(result, "stale_marked");
    mpack_write_int(result, 0);

    mpack_write_cstr(result, "maintenance");
    mpack_build_map(result);
    mpack_write_cstr(result, "expired_deleted");
    mpack_write_int(result, report.expired_deleted);
    mpack_write_cstr(result, "duplicate_edges_deleted");
    mpack_write_int(result, report.duplicate_edges_deleted);
    mpack_write_cstr(result, "orphan_edges_deleted");
    mpack_write_int(result, report.orphan_edges_deleted);
    mpack_write_cstr(result, "orphan_node_keywords_deleted");
    mpack_write_int(result, report.orphan_node_keywords_deleted);
    mpack_write_cstr(result, "invalid_edges_deleted");
    mpack_write_int(result, report.invalid_edges_deleted);
    mpack_write_cstr(result, "sqlite_analyzed");
    mpack_write_bool(result, true);
    mpack_complete_map(result);

    mpack_write_cstr(result, "graph");
    mpack_build_map(result);
    mpack_write_cstr(result, "n_nodes");
    mpack_write_int(result, report.n_nodes);
    mpack_write_cstr(result, "n_edges");
    mpack_write_int(result, report.n_edges);
    mpack_write_cstr(result, "n_keywords");
    mpack_write_int(result, report.n_keywords);
    mpack_write_cstr(result, "isolated_nodes");
    mpack_write_int(result, report.isolated_nodes);
    mpack_write_cstr(result, "physical_bidirectional_pairs");
    mpack_write_int(result, report.physical_bidirectional_pairs);
    mpack_complete_map(result);

    mpack_write_cstr(result, "recommendations");
    mpack_build_array(result);
    if (report.isolated_nodes > 0) {
        mpack_write_cstr(result, "isolated nodes found: consider adding keywords or linking them through future consolidation passes");
    }
    if (report.physical_bidirectional_pairs > 0) {
        mpack_write_cstr(result, "physical reciprocal keyword/semantic edges exist; traversal is already bidirectional, so future storage compaction can remove redundant pairs");
    }
    if (report.contradictions_found > 0) {
        mpack_write_cstr(result, "contradiction edges found: review whether supersession or deletion should resolve them");
    }
    mpack_complete_array(result);

    mpack_write_cstr(result, "note");
    mpack_write_cstr(result, "consolidate completed safe maintenance and graph-health analysis; semantic content merges are intentionally not destructive");

    mpack_complete_map(result);
    return MG_OK;
}
