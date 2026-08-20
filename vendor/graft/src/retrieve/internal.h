#ifndef MG_RETRIEVE_INTERNAL_H
#define MG_RETRIEVE_INTERNAL_H

#include "graft/ops.h"
#include "graft/types.h"
#include "graft/error.h"
#include "mpack.h"

/* Hex helpers (lowercase). out buffer must hold 2*len + 1 bytes. */
void mg_retrieve_hex_encode(const uint8_t *bytes, size_t len, char *out_hex_zterm);

/* Returns 0 on success, -1 on invalid hex or length mismatch. */
int  mg_retrieve_hex_decode(const char *hex, size_t hex_len,
                            uint8_t *out, size_t out_len);

/* Run RRF retrieval and write a single mpack VALUE — a map with
 *   { "results": [...], "distinct_keywords": [...] }
 * onto `w` at the current writer position. The query embedding is
 * already computed; `text` is used for FTS lookups. */
mg_err_t mg_retrieve_run_rrf(mg_ctx_t *ctx,
                             const char *text,
                             const mg_embedding_t q,
                             int top_k,
                             mpack_writer_t *w);

/* Collect distinct keyword_ids associated with a node via KEYWORD edges
 * outgoing from it. *out_n filled with count (<=max_kw). */
mg_err_t mg_retrieve_node_keywords(mg_storage_t *s,
                                   const mg_node_id_t node_id,
                                   mg_keyword_id_t *out_kw,
                                   int *out_n,
                                   int max_kw);

/* Extract a heap-allocated NUL-terminated copy of a string node.
 * Returns NULL on failure / non-string. Caller frees with free(). */
char *mg_retrieve_node_str_dup(mpack_node_t node);

#endif
