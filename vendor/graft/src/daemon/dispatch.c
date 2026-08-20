/* mg_dispatch — read op + args from request payload, route to handler,
 * wrap handler output in the standard envelope:
 *
 *   { "status": int, "result": <handler value | nil>, "error": <str?> }
 *
 * Two-pass strategy:
 *   1. Run the handler against a growable writer ("body") to produce the
 *      raw "result" mpack value.
 *   2. Build the envelope into a second growable writer ("env"), embedding
 *      the body via mpack_write_object_bytes().
 *
 * On any failure (parse error, unknown op, handler error, internal mpack
 * error), the envelope still carries status != MG_OK and an error string;
 * the result field is nil. Callers should always look at "status".
 */

#include "graft/ops.h"
#include "graft/wire.h"
#include "graft/error.h"
#include "mpack.h"

#include <stdlib.h>
#include <string.h>

static mg_err_t build_envelope(mg_err_t status, const char *err_msg,
                               const char *body, size_t body_len,
                               void **out_payload, size_t *out_len) {
    char  *buf  = NULL;
    size_t size = 0;
    mpack_writer_t w;
    mpack_writer_init_growable(&w, &buf, &size);

    int n_keys = (status == MG_OK) ? 2 : 3;
    mpack_start_map(&w, (uint32_t)n_keys);

    mpack_write_cstr(&w, "status");
    mpack_write_int(&w, (int)status);

    if (status != MG_OK) {
        mpack_write_cstr(&w, "error");
        mpack_write_cstr(&w, err_msg ? err_msg : mg_strerror(status));
    }

    mpack_write_cstr(&w, "result");
    if (status == MG_OK && body && body_len > 0) {
        mpack_write_object_bytes(&w, body, body_len);
    } else {
        mpack_write_nil(&w);
    }

    mpack_finish_map(&w);

    mpack_error_t we = mpack_writer_destroy(&w);
    if (we != mpack_ok) {
        free(buf);
        *out_payload = NULL;
        *out_len = 0;
        return MG_ERR_WIRE;
    }
    *out_payload = buf;
    *out_len = size;
    return MG_OK;
}

mg_err_t mg_dispatch(mg_ctx_t *ctx, const void *req_payload, size_t req_len,
                     void **resp_payload, size_t *resp_len) {
    if (!ctx || !req_payload || !resp_payload || !resp_len)
        return MG_ERR_INVALID_ARG;

    *resp_payload = NULL;
    *resp_len     = 0;

    /* ---- parse request envelope ---- */
    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char *)req_payload, req_len);
    mpack_tree_parse(&tree);
    if (mpack_tree_error(&tree) != mpack_ok) {
        mpack_tree_destroy(&tree);
        return build_envelope(MG_ERR_WIRE, "invalid mpack request",
                              NULL, 0, resp_payload, resp_len);
    }

    mpack_node_t root = mpack_tree_root(&tree);

    char *op_str = mpack_node_cstr_alloc(mpack_node_map_cstr(root, "op"), 64);
    mg_op_t op;
    if (!op_str || mg_wire_op_from_string(op_str, &op) != MG_OK) {
        free(op_str);
        mpack_tree_destroy(&tree);
        return build_envelope(MG_ERR_WIRE, "missing or unknown op",
                              NULL, 0, resp_payload, resp_len);
    }
    free(op_str);

    /* args is optional; handlers receive a (possibly missing) node. When
     * present, it MUST be a map — handlers all assume a {key:value} shape
     * and feeding them an int/string/array could trip mpack assertions or
     * cause OOB reads in op_* code. */
    mpack_node_t args = mpack_node_map_cstr_optional(root, "args");
    if (!mpack_node_is_missing(args) && !mpack_node_is_nil(args)
        && mpack_node_type(args) != mpack_type_map) {
        mpack_tree_destroy(&tree);
        return build_envelope(MG_ERR_INVALID_ARG, "args must be a map",
                              NULL, 0, resp_payload, resp_len);
    }

    /* ---- run handler into body buffer ---- */
    char  *body_buf  = NULL;
    size_t body_size = 0;
    mpack_writer_t body;
    mpack_writer_init_growable(&body, &body_buf, &body_size);

    mg_err_t herr = MG_OK;
    switch (op) {
        case MG_OP_CLASSIFY:    herr = mg_op_classify   (ctx, args, &body); break;
        case MG_OP_INSERT:      herr = mg_op_insert     (ctx, args, &body); break;
        case MG_OP_QUERY:       herr = mg_op_query      (ctx, args, &body); break;
        case MG_OP_RETRIEVE:    herr = mg_op_retrieve   (ctx, args, &body); break;
        case MG_OP_EXPLORE:     herr = mg_op_explore    (ctx, args, &body); break;
        case MG_OP_GET:         herr = mg_op_get        (ctx, args, &body); break;
        case MG_OP_STATS:       herr = mg_op_stats      (ctx, args, &body); break;
        case MG_OP_CONSOLIDATE: herr = mg_op_consolidate(ctx, args, &body); break;
        case MG_OP_DELETE:      herr = mg_op_delete     (ctx, args, &body); break;
        case MG_OP_VIEW:        herr = mg_op_view       (ctx, args, &body); break;
        case MG_OP_REMOTE_SYNC: herr = mg_op_remote_sync(ctx, args, &body); break;
        default:                herr = MG_ERR_INVALID_ARG;                  break;
    }

    mpack_error_t we = mpack_writer_destroy(&body);
    mpack_tree_destroy(&tree);

    if (we != mpack_ok && herr == MG_OK) herr = MG_ERR_WIRE;

    mg_err_t e = build_envelope(herr,
                                 herr != MG_OK ? mg_strerror(herr) : NULL,
                                 herr == MG_OK ? body_buf : NULL,
                                 herr == MG_OK ? body_size : 0,
                                 resp_payload, resp_len);
    free(body_buf);
    return e;
}
