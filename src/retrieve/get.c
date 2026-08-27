/* mg_op_get: fetch a node by hex id, touch access, and serialize.
 *
 * Result map (handler writes a single mpack VALUE):
 *   {
 *     "id_hex":       string (32 hex chars),
 *     "title":        string,
 *     "body":         string,
 *     "author":       string|nil,
 *     "keywords":     [ string, ... ],
 *     "created_at":   int (unix ms),
 *     "expires_at":   int (unix ms; 0 = no expiration),
 *     "access_count": int
 *   }
 */

#include "internal.h"
#include "graft/storage.h"
#include "graft/types.h"
#include "graft/error.h"

#include <stdlib.h>
#include <string.h>

#define MG_GET_MAX_KW 32

mg_err_t mg_op_get(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
    if (!ctx || !ctx->storage || !result) return MG_ERR_INVALID_ARG;

    mpack_node_t id_node = mpack_node_map_cstr(args, "id_hex");
    if (mpack_node_type(id_node) != mpack_type_str) return MG_ERR_INVALID_ARG;
    const char *hex_ptr  = mpack_node_str(id_node);
    size_t      hex_len  = mpack_node_strlen(id_node);
    if (!hex_ptr || hex_len != 2 * MG_NODE_ID_BYTES) return MG_ERR_INVALID_ARG;

    mg_node_id_t id;
    if (mg_retrieve_hex_decode(hex_ptr, hex_len, id, MG_NODE_ID_BYTES) != 0)
        return MG_ERR_INVALID_ARG;

    mg_node_t node = {0};
    mg_err_t e = mg_storage_get_node(ctx->storage, id, &node);
    if (e != MG_OK) return e;

    /* Best-effort: don't fail the GET if access touch fails. */
    (void)mg_storage_touch_access(ctx->storage, id);

    mg_keyword_id_t kw_ids[MG_GET_MAX_KW];
    int n_kw = 0;
    (void)mg_retrieve_node_keywords(ctx->storage, id, kw_ids, &n_kw,
                                    MG_GET_MAX_KW);

    char id_hex[2 * MG_NODE_ID_BYTES + 1];
    mg_retrieve_hex_encode(id, MG_NODE_ID_BYTES, id_hex);

    mpack_build_map(result);

    mpack_write_cstr(result, "id_hex");
    mpack_write_cstr(result, id_hex);

    mpack_write_cstr(result, "title");
    mpack_write_cstr(result, node.title ? node.title : "");

    mpack_write_cstr(result, "body");
    mpack_write_cstr(result, node.body ? node.body : "");

    mpack_write_cstr(result, "author");
    if (node.author) mpack_write_cstr(result, node.author);
    else             mpack_write_nil(result);

    mpack_write_cstr(result, "keywords");
    mpack_build_array(result);
    for (int i = 0; i < n_kw; i++) {
        char *kw_text = NULL;
        if (mg_storage_get_keyword_text(ctx->storage, kw_ids[i], &kw_text) == MG_OK
            && kw_text) {
            mpack_write_cstr(result, kw_text);
            free(kw_text);
        }
    }
    mpack_complete_array(result);

    mpack_write_cstr(result, "created_at");
    mpack_write_int(result, node.created_at);

    mpack_write_cstr(result, "expires_at");
    mpack_write_int(result, node.expires_at);

    mpack_write_cstr(result, "access_count");
    mpack_write_int(result, node.access_count);

    mpack_complete_map(result);

    mg_node_free(&node);
    return MG_OK;
}
