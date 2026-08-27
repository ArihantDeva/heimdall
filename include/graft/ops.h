#ifndef GRAFT_OPS_H
#define GRAFT_OPS_H

#include "graft/storage.h"
#include "graft/embed.h"
#include "graft/config.h"
#include "graft/wire.h"
#include "mpack.h"

typedef struct {
  mg_storage_t   *storage;
  mg_embed_ctx_t *embed;
  void           *verify;    /* mg_verify_ctx_t* opaque */
  void           *rerank;    /* mg_rerank_ctx_t* opaque, NULL when disabled */
  mg_config_t    *config;
} mg_ctx_t;

/* Ogni op handler legge args dalla mappa MessagePack del request,
 * scrive 'result' nella mappa MessagePack della response.
 * Ritorna mg_err_t. Se non MG_OK, il dispatch wrapper imposta status+error. */

mg_err_t mg_op_classify(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_insert(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_query(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_retrieve(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_explore(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_get(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_stats(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_consolidate(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_delete(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_view(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);
mg_err_t mg_op_remote_sync(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result);

/* Dispatch: legge "op" dal frame, instrada all'handler giusto. */
mg_err_t mg_dispatch(mg_ctx_t *ctx, const void *req_payload, size_t req_len,
                     void **resp_payload, size_t *resp_len);

#endif
