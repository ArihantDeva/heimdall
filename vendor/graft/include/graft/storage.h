#ifndef GRAFT_STORAGE_H
#define GRAFT_STORAGE_H

#include "graft/types.h"
#include "graft/error.h"

typedef struct mg_storage mg_storage_t;

typedef struct {
  int64_t n_nodes;
  int64_t n_edges;
  int64_t n_keywords;
  int64_t expired_deleted;
  int64_t duplicate_edges_deleted;
  int64_t orphan_edges_deleted;
  int64_t orphan_node_keywords_deleted;
  int64_t invalid_edges_deleted;
  int64_t isolated_nodes;
  int64_t physical_bidirectional_pairs;
  int64_t contradictions_found;
} mg_storage_consolidate_report_t;

mg_err_t mg_storage_open(const char *db_path, mg_storage_t **out);
void     mg_storage_close(mg_storage_t *s);

/* Schema: idempotent, applica migrations all'apertura */
mg_err_t mg_storage_apply_schema(mg_storage_t *s);

/* === Nodi === */
/* Inserisce nodo + embedding. La transazione include anche gli archi
 * passati in input (per atomicita'). edges puo' essere NULL/0 se non si vogliono archi.
 *
 * If supersedes_id is non-NULL, the same transaction also marks that node
 * as MG_NODE_SUPERSEDED and adds a SUPERSEDES edge from the new node to it.
 * Atomicity ensures the graph is never observed in an inconsistent state
 * (i.e. the SUPERSEDES edge always agrees with the old node's state). */
mg_err_t mg_storage_insert_node_with_edges(
  mg_storage_t *s,
  const mg_node_t *node,
  const mg_embedding_t embedding,
  const mg_keyword_id_t *keyword_ids, size_t n_keywords,
  const mg_edge_t *edges, size_t n_edges,
  const mg_node_id_t *supersedes_id
);

/* Recupera nodo. Il chiamante deve fare mg_node_free su out->summary/detail. */
mg_err_t mg_storage_get_node(mg_storage_t *s, const mg_node_id_t id, mg_node_t *out);

/* Cancella un nodo e tutto il contenuto associato. Cascades:
 *   - node_keywords (FK ON DELETE CASCADE)
 *   - edges (FK ON DELETE CASCADE su src e dst)
 *   - node_fts (trigger nodes_ad)
 *   - node_vec (manuale, virtual table senza FK)
 * Returns MG_ERR_NOT_FOUND se l'id non esiste. */
mg_err_t mg_storage_delete_node(mg_storage_t *s, const mg_node_id_t id);
mg_err_t mg_storage_prune_expired(mg_storage_t *s, int64_t *out_deleted);

/* Lookup idempotenza */
mg_err_t mg_storage_node_id_by_hash(mg_storage_t *s, const mg_hash_t h, mg_node_id_t out);

mg_err_t mg_storage_touch_access(mg_storage_t *s, const mg_node_id_t id);

/* === Keywords === */
/* Upsert. Se esiste ritorna id esistente. Se nuova: calcola embedding (chiamando mg_embed)
 * - per la fase 1 puoi passare un embedding pre-calcolato dal chiamante via *opt_embedding. */
mg_err_t mg_storage_upsert_keyword(
  mg_storage_t *s,
  const char *text,
  const float *opt_embedding,    /* puo' essere NULL */
  mg_keyword_id_t *out_id
);

mg_err_t mg_storage_get_keyword_text(mg_storage_t *s, mg_keyword_id_t id, char **out);

/* === Vector search === */
/* Top-k cosine. Risultati ordinati DESC per score. out_count <= k. */
mg_err_t mg_storage_vector_topk(
  mg_storage_t *s,
  const mg_embedding_t query,
  int k,
  mg_node_score_t *out, int *out_count
);

/* Top-k cosine vincolato a nodi che hanno una specifica keyword */
mg_err_t mg_storage_vector_topk_by_keyword(
  mg_storage_t *s,
  const mg_embedding_t query,
  mg_keyword_id_t kw_id,
  int k,
  mg_node_score_t *out, int *out_count
);

/* === FTS (BM25) === */
mg_err_t mg_storage_fts_search(
  mg_storage_t *s,
  const char *query_text,
  int k,
  bool match_title, bool match_body,
  mg_node_score_t *out, int *out_count
);

/* === Grafo === */
/* Vicini di un nodo per kind specifico (o tutti se kind=-1).
 * KEYWORD e SEMANTIC sono relazioni non direzionali a traversal-time:
 * gli archi incoming vengono restituiti normalizzati come src=node, dst=vicino.
 * Gli altri kind mantengono la direzione salvata. */
mg_err_t mg_storage_neighbors(
  mg_storage_t *s,
  const mg_node_id_t src,
  int kind_filter,                  /* -1 = tutti */
  const mg_keyword_id_t *kw_filter, /* NULL = nessun filtro keyword */
  size_t n_kw,
  mg_edge_t *out, int max_out, int *out_count
);

/* === Sample distribuzione (per stats) === */
mg_err_t mg_storage_record_sample(mg_storage_t *s, int kind, float cosine);

/* Percentili approssimati: out[0]=p25, out[1]=p50, out[2]=p75, out[3]=p90, out[4]=p95, out[5]=p99 */
mg_err_t mg_storage_distribution_percentiles(mg_storage_t *s, int kind, float out[6]);

/* === Embedding accessor === */
mg_err_t mg_storage_get_embedding(mg_storage_t *s, const mg_node_id_t id, mg_embedding_t out);

/* === Counts (per stats) === */
/* kind: 0=nodes, 1=edges, 2=keywords. Other kinds return MG_ERR_INVALID_ARG. */
#define MG_STORAGE_COUNT_NODES    0
#define MG_STORAGE_COUNT_EDGES    1
#define MG_STORAGE_COUNT_KEYWORDS 2
mg_err_t mg_storage_count(mg_storage_t *s, int kind, int64_t *out);

/* Safe maintenance pass for consolidate:
 * - prunes expired nodes,
 * - removes legacy orphan/duplicate/invalid graph rows,
 * - refreshes SQLite planner statistics,
 * - reports graph-health signals without merging content destructively. */
mg_err_t mg_storage_consolidate(mg_storage_t *s, mg_storage_consolidate_report_t *out);

/* === Per-node keyword ownership === */
/* Reads the node_keywords link table directly (NOT the graph edges).
 * Use this to answer "which keywords does this node carry" — orthogonal
 * from the keyword-edge graph relation. */
mg_err_t mg_storage_node_keywords(
  mg_storage_t *s,
  const mg_node_id_t node_id,
  mg_keyword_id_t *out_ids, int max_out, int *out_count
);

/* === Merge another profile's DB into this one === */
/* Imports nodes / keywords / edges from `source_path` (a SQLite file from
 * `graft profile export`) into the connected DB. Idempotent on
 * content_hash: nodes already in the target are skipped (overwrite=0) or
 * replaced (overwrite=1). Keyword ids are remapped by text (keywords.text
 * is UNIQUE COLLATE NOCASE), so the source's auto-increment ids don't
 * leak into the target. */
mg_err_t mg_storage_merge_from(mg_storage_t *s, const char *source_path,
                               int overwrite);

/* Remote-profile file sync helpers.
 *
 * pull_remote_file: imports remote-only nodes (origin=REMOTE) and applies
 *   delete-wins-remote for rows that are not LOCAL. Uses the existing
 *   connection so WAL serialises the writes against other daemon threads.
 *
 * push_to_remote_file: copies only LOCAL nodes (origin=0) to the remote
 *   file and marks them PUSHED (origin=2) in the same transaction, so the
 *   mark is atomic with the push. The remote is opened via ATTACH on the
 *   same connection — no second open of the local WAL file. */
mg_err_t mg_storage_pull_remote_file(mg_storage_t *s, const char *source_path,
                                     int64_t *inserted, int64_t *deleted);
mg_err_t mg_storage_push_to_remote_file(mg_storage_t *s, const char *dest_path,
                                        int64_t *pushed);
/* Marks all LOCAL (origin=0) nodes as PUSHED (origin=2). Used before a pull
 * so that pulled deletes of already-pushed nodes are not misapplied locally.
 * *updated receives the count of rows changed. */
mg_err_t mg_storage_mark_local_pushed(mg_storage_t *s, int64_t *updated);

#endif
