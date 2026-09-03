#ifndef GRAFT_TYPES_H
#define GRAFT_TYPES_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define MG_EMBEDDING_DIM 1024  /* BGE-M3 */
#define MG_NODE_ID_BYTES 16    /* UUIDv7 */
#define MG_HASH_BYTES    32    /* BLAKE3 */

typedef uint8_t  mg_node_id_t[MG_NODE_ID_BYTES];
typedef uint8_t  mg_hash_t[MG_HASH_BYTES];
typedef int64_t  mg_keyword_id_t;
typedef float    mg_embedding_t[MG_EMBEDDING_DIM];

typedef enum {
  MG_EDGE_KEYWORD     = 0,
  MG_EDGE_SEMANTIC    = 1,
  MG_EDGE_CONTRADICTS = 2,
  MG_EDGE_SUPERSEDES  = 3
} mg_edge_kind_t;

typedef enum {
  MG_NODE_ACTIVE     = 0,
  MG_NODE_STALE      = 1,
  MG_NODE_SUPERSEDED = 2
} mg_node_state_t;

typedef struct {
  mg_node_id_t   id;
  mg_hash_t      content_hash;
  char          *title;          /* short retrieval-anchor line (was: summary) */
  char          *body;           /* long-form Markdown (was: detail) */
  char          *author;         /* "<user>@<host>" or config override; NULL for legacy rows */
  int64_t        created_at;     /* unix ms */
  int64_t        expires_at;     /* unix ms; 0 = no expiration */
  int64_t        last_access;
  int64_t        access_count;
  mg_node_state_t state;
} mg_node_t;

typedef struct {
  mg_node_id_t    src;
  mg_node_id_t    dst;
  mg_edge_kind_t  kind;
  mg_keyword_id_t keyword_id;    /* 0 se non KEYWORD */
  float           weight;
} mg_edge_t;

typedef struct {
  mg_node_id_t id;
  float        score;
} mg_node_score_t;

void mg_node_free(mg_node_t *n);
void mg_uuidv7(mg_node_id_t out);
void mg_blake3(const uint8_t *data, size_t len, mg_hash_t out);

#endif
