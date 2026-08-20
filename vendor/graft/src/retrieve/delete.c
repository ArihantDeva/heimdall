/* mg_op_delete: remove a node by hex id.
 *
 * Args map:
 *   { "id_hex": "<32 hex chars>" }
 *
 * Result map:
 *   { "deleted": true,  "id_hex": "..." }     // node existed and was removed
 *
 * Errors:
 *   MG_ERR_INVALID_ARG  — missing/malformed id
 *   MG_ERR_NOT_FOUND    — id was not in the graph
 *
 * The storage layer cascades: node_keywords and edges are removed via
 * ON DELETE CASCADE, the FTS row by trigger; node_vec is cleared
 * explicitly. The agent flow that "modifies" a node is just
 *   delete + classify + insert
 * — content_hash dedup makes re-insertion safe and idempotent, and the
 * insert pipeline rebuilds embedding + edges from scratch.
 */

#include "internal.h"
#include "graft/storage.h"
#include "graft/types.h"
#include "graft/error.h"

#include <string.h>

mg_err_t mg_op_delete(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
    if (!ctx || !ctx->storage || !result) return MG_ERR_INVALID_ARG;

    mpack_node_t id_node = mpack_node_map_cstr(args, "id_hex");
    if (mpack_node_type(id_node) != mpack_type_str) return MG_ERR_INVALID_ARG;
    const char *hex_ptr  = mpack_node_str(id_node);
    size_t      hex_len  = mpack_node_strlen(id_node);
    if (!hex_ptr || hex_len != 2 * MG_NODE_ID_BYTES) return MG_ERR_INVALID_ARG;

    mg_node_id_t id;
    if (mg_retrieve_hex_decode(hex_ptr, hex_len, id, MG_NODE_ID_BYTES) != 0)
        return MG_ERR_INVALID_ARG;

    mg_err_t e = mg_storage_delete_node(ctx->storage, id);
    if (e != MG_OK) return e;

    char id_hex[2 * MG_NODE_ID_BYTES + 1];
    mg_retrieve_hex_encode(id, MG_NODE_ID_BYTES, id_hex);

    mpack_build_map(result);
    mpack_write_cstr(result, "deleted");
    mpack_write_bool(result, true);
    mpack_write_cstr(result, "id_hex");
    mpack_write_cstr(result, id_hex);
    mpack_complete_map(result);

    return MG_OK;
}
