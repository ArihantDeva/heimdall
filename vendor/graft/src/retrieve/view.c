/* mg_op_view: full-graph dump for the 3D viewer.
 *
 * Returns every node with id_hex, title, state, and a 3D position derived
 * from the embedding via deterministic random projection (Achlioptas-style
 * Rademacher matrix with a fixed seed). This avoids the cost of full PCA
 * (eigendecomposition of a 1024×1024 matrix) while still preserving
 * pairwise distances reasonably well per Johnson-Lindenstrauss.
 *
 * Embeddings are L2-normalized, so projected coordinates land in roughly
 * [-1, 1] per axis with the chosen scale (1/sqrt(D)).
 *
 * Edges include kind (semantic | keyword | supersedes | contradicts),
 * weight, and the keyword text when applicable.
 *
 * Result map:
 *   {
 *     "graph_version": <int>,                 (n_nodes * 1e9 + n_edges; cheap diff signal)
 *     "nodes": [
 *       { "id_hex": ..., "title": ..., "state": "active"|"superseded"|"stale",
 *         "x": float, "y": float, "z": float }
 *     ],
 *     "edges": [
 *       { "src": ..., "dst": ..., "kind": "semantic"|"keyword"|"supersedes"|"contradicts",
 *         "weight": float, "keyword"?: string }
 *     ]
 *   }
 */

#include "graft/ops.h"
#include "graft/storage.h"
#include "graft/types.h"
#include "graft/error.h"
#include "internal.h"

#include <sqlite3.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Forward to the SQLite handle that mg_storage_t holds. We need raw access
 * for the view dump (multi-row iteration), which the public storage API
 * doesn't expose. The struct is opaque — we redeclare it here in a way
 * binary-compatible with src/storage/storage.c. */
struct mg_storage { sqlite3 *db; };

/* Deterministic Rademacher random projection: each entry of the 3xD matrix
 * is +1 or -1 picked from a fixed-seed xorshift, scaled by 1/sqrt(D). */
static void build_proj_matrix(float R[3 * MG_EMBEDDING_DIM]) {
  uint32_t s = 0xCAFEBABEu;
  const float scale = 1.0f / sqrtf((float)MG_EMBEDDING_DIM);
  size_t i;
  for (i = 0; i < 3 * MG_EMBEDDING_DIM; ++i) {
    /* xorshift32 */
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    R[i] = (s & 1u) ? scale : -scale;
  }
}

static void project(const float *R, const float *embedding, float xyz[3]) {
  int d, i;
  for (d = 0; d < 3; ++d) {
    float sum = 0.0f;
    const float *row = R + (size_t)d * MG_EMBEDDING_DIM;
    for (i = 0; i < MG_EMBEDDING_DIM; ++i) sum += row[i] * embedding[i];
    xyz[d] = sum;
  }
}

static const char *state_to_string(int s) {
  switch (s) {
    case 0: return "active";
    case 1: return "stale";
    case 2: return "superseded";
    default: return "unknown";
  }
}

static const char *edge_kind_to_string(int k) {
  switch (k) {
    case 0: return "keyword";
    case 1: return "semantic";
    case 2: return "contradicts";
    case 3: return "supersedes";
    default: return "unknown";
  }
}

/* Use the existing helper from src/retrieve/util.c. */
extern void mg_retrieve_hex_encode(const uint8_t *bytes, size_t len, char *out);

mg_err_t mg_op_view(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
  sqlite3_stmt *stmt = NULL;
  sqlite3 *db;
  float R[3 * MG_EMBEDDING_DIM];
  int n_nodes = 0, n_edges = 0;
  int rc;

  (void)args;
  if (!ctx || !ctx->storage || !result) return MG_ERR_INVALID_ARG;
  db = ctx->storage->db;

  build_proj_matrix(R);

  /* Optional RBAC-lite scope: only expose nodes tagged with this keyword.
   * Edges are also filtered to those whose src AND dst both pass the scope.
   * NULL/empty scope = expose everything (legacy behaviour). */
  const char *scope_kw = ctx->config ? ctx->config->http_view_keyword_scope : NULL;
  if (scope_kw && !*scope_kw) scope_kw = NULL;

  /* Count once for the version + array sizing. */
  if (scope_kw) {
    if (sqlite3_prepare_v2(db,
        "SELECT COUNT(*) FROM nodes n "
        "WHERE EXISTS (SELECT 1 FROM node_keywords nk "
        "              JOIN keywords k ON k.id = nk.keyword_id "
        "              WHERE nk.node_id = n.id AND k.text = ?);",
        -1, &stmt, NULL) != SQLITE_OK) return MG_ERR_STORAGE;
    sqlite3_bind_text(stmt, 1, scope_kw, -1, SQLITE_STATIC);
  } else {
    if (sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM nodes;", -1, &stmt, NULL) != SQLITE_OK)
      return MG_ERR_STORAGE;
  }
  if (sqlite3_step(stmt) == SQLITE_ROW) n_nodes = sqlite3_column_int(stmt, 0);
  sqlite3_finalize(stmt);

  if (scope_kw) {
    if (sqlite3_prepare_v2(db,
        "SELECT COUNT(*) FROM edges e "
        "WHERE EXISTS (SELECT 1 FROM node_keywords nk JOIN keywords k ON k.id = nk.keyword_id "
        "              WHERE nk.node_id = e.src AND k.text = ?) "
        "  AND EXISTS (SELECT 1 FROM node_keywords nk JOIN keywords k ON k.id = nk.keyword_id "
        "              WHERE nk.node_id = e.dst AND k.text = ?);",
        -1, &stmt, NULL) != SQLITE_OK) return MG_ERR_STORAGE;
    sqlite3_bind_text(stmt, 1, scope_kw, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 2, scope_kw, -1, SQLITE_STATIC);
  } else {
    if (sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM edges;", -1, &stmt, NULL) != SQLITE_OK)
      return MG_ERR_STORAGE;
  }
  if (sqlite3_step(stmt) == SQLITE_ROW) n_edges = sqlite3_column_int(stmt, 0);
  sqlite3_finalize(stmt);

  mpack_build_map(result);
  mpack_write_cstr(result, "graph_version");
  mpack_write_i64(result, (int64_t)n_nodes * 1000000000LL + (int64_t)n_edges);

  /* --------- nodes --------- */
  mpack_write_cstr(result, "nodes");
  mpack_build_array(result);
  /* The first keyword (lowest id alphabetically — see the LIMIT 1) acts as
   * the "primary tag" used by the viewer to color-code nodes. We also
   * surface body length so the client can size nodes proportionally. */
  if (scope_kw) {
    rc = sqlite3_prepare_v2(db,
      "SELECT n.id, n.title, n.state, length(n.body), v.embedding, "
      "       (SELECT k.text FROM node_keywords nk "
      "          JOIN keywords k ON k.id = nk.keyword_id "
      "          WHERE nk.node_id = n.id "
      "          ORDER BY k.text COLLATE NOCASE ASC LIMIT 1) "
      "FROM nodes n JOIN node_vec v ON v.id = n.id "
      "WHERE EXISTS (SELECT 1 FROM node_keywords nk "
      "              JOIN keywords k ON k.id = nk.keyword_id "
      "              WHERE nk.node_id = n.id AND k.text = ?);", -1, &stmt, NULL);
    if (rc == SQLITE_OK) sqlite3_bind_text(stmt, 1, scope_kw, -1, SQLITE_STATIC);
  } else {
    rc = sqlite3_prepare_v2(db,
      "SELECT n.id, n.title, n.state, length(n.body), v.embedding, "
      "       (SELECT k.text FROM node_keywords nk "
      "          JOIN keywords k ON k.id = nk.keyword_id "
      "          WHERE nk.node_id = n.id "
      "          ORDER BY k.text COLLATE NOCASE ASC LIMIT 1) "
      "FROM nodes n JOIN node_vec v ON v.id = n.id;", -1, &stmt, NULL);
  }
  if (rc != SQLITE_OK) {
    mpack_complete_array(result);
    mpack_complete_map(result);
    return MG_ERR_STORAGE;
  }
  /* When http.view_anonymize is on, strip titles and primary_keyword so the
   * client gets topology only (graph shape, edges, coords) without content.
   * Useful for sharing a graph layout without leaking what the nodes ARE. */
  bool anonymize = ctx->config && ctx->config->http_view_anonymize;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    const uint8_t *id    = (const uint8_t *)sqlite3_column_blob(stmt, 0);
    const char    *title = (const char *)sqlite3_column_text(stmt, 1);
    int            state = sqlite3_column_int(stmt, 2);
    int            body_len = sqlite3_column_int(stmt, 3);
    const void    *eb    = sqlite3_column_blob(stmt, 4);
    int            ebn   = sqlite3_column_bytes(stmt, 4);
    const char    *primary_kw = (const char *)sqlite3_column_text(stmt, 5);
    char id_hex[2 * MG_NODE_ID_BYTES + 1];
    float xyz[3] = {0, 0, 0};
    if (!id || !eb || ebn != (int)sizeof(mg_embedding_t)) continue;
    mg_retrieve_hex_encode(id, MG_NODE_ID_BYTES, id_hex);
    project(R, (const float *)eb, xyz);
    mpack_build_map(result);
    mpack_write_cstr(result, "id_hex");  mpack_write_cstr(result, id_hex);
    mpack_write_cstr(result, "title");   mpack_write_cstr(result, anonymize ? "" : (title ? title : ""));
    mpack_write_cstr(result, "state");   mpack_write_cstr(result, state_to_string(state));
    mpack_write_cstr(result, "body_len"); mpack_write_int(result, body_len);
    mpack_write_cstr(result, "primary_keyword");
    if (primary_kw && !anonymize) mpack_write_cstr(result, primary_kw);
    else                          mpack_write_nil(result);
    mpack_write_cstr(result, "x");       mpack_write_float(result, xyz[0]);
    mpack_write_cstr(result, "y");       mpack_write_float(result, xyz[1]);
    mpack_write_cstr(result, "z");       mpack_write_float(result, xyz[2]);
    mpack_complete_map(result);
  }
  sqlite3_finalize(stmt);
  mpack_complete_array(result);

  /* --------- edges --------- */
  mpack_write_cstr(result, "edges");
  mpack_build_array(result);
  if (scope_kw) {
    rc = sqlite3_prepare_v2(db,
      "SELECT e.src, e.dst, e.kind, e.keyword_id, e.weight, k.text "
      "FROM edges e LEFT JOIN keywords k ON k.id = e.keyword_id "
      "WHERE EXISTS (SELECT 1 FROM node_keywords nk JOIN keywords kk ON kk.id = nk.keyword_id "
      "              WHERE nk.node_id = e.src AND kk.text = ?) "
      "  AND EXISTS (SELECT 1 FROM node_keywords nk JOIN keywords kk ON kk.id = nk.keyword_id "
      "              WHERE nk.node_id = e.dst AND kk.text = ?);",
      -1, &stmt, NULL);
    if (rc == SQLITE_OK) {
      sqlite3_bind_text(stmt, 1, scope_kw, -1, SQLITE_STATIC);
      sqlite3_bind_text(stmt, 2, scope_kw, -1, SQLITE_STATIC);
    }
  } else {
    rc = sqlite3_prepare_v2(db,
      "SELECT e.src, e.dst, e.kind, e.keyword_id, e.weight, k.text "
      "FROM edges e LEFT JOIN keywords k ON k.id = e.keyword_id;",
      -1, &stmt, NULL);
  }
  if (rc != SQLITE_OK) {
    mpack_complete_array(result);
    mpack_complete_map(result);
    return MG_ERR_STORAGE;
  }
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    const uint8_t *src  = (const uint8_t *)sqlite3_column_blob(stmt, 0);
    const uint8_t *dst  = (const uint8_t *)sqlite3_column_blob(stmt, 1);
    int            kind = sqlite3_column_int(stmt, 2);
    int            has_kw = sqlite3_column_type(stmt, 3) != SQLITE_NULL;
    double         weight = sqlite3_column_double(stmt, 4);
    const char    *kw_text = has_kw ? (const char *)sqlite3_column_text(stmt, 5) : NULL;
    char src_hex[2 * MG_NODE_ID_BYTES + 1];
    char dst_hex[2 * MG_NODE_ID_BYTES + 1];
    if (!src || !dst) continue;
    mg_retrieve_hex_encode(src, MG_NODE_ID_BYTES, src_hex);
    mg_retrieve_hex_encode(dst, MG_NODE_ID_BYTES, dst_hex);
    mpack_build_map(result);
    mpack_write_cstr(result, "src");    mpack_write_cstr(result, src_hex);
    mpack_write_cstr(result, "dst");    mpack_write_cstr(result, dst_hex);
    mpack_write_cstr(result, "kind");   mpack_write_cstr(result, edge_kind_to_string(kind));
    mpack_write_cstr(result, "weight"); mpack_write_float(result, (float)weight);
    if (kw_text) {
      mpack_write_cstr(result, "keyword");
      mpack_write_cstr(result, kw_text);
    }
    mpack_complete_map(result);
  }
  sqlite3_finalize(stmt);
  mpack_complete_array(result);

  mpack_complete_map(result);
  return MG_OK;
}
