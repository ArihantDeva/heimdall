#include "graft/ops.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  mg_keyword_id_t id;
  int count;
  char *text;
} keyword_count_t;

static mg_err_t copy_title(mpack_node_t args, char **out) {
  if (!out) {
    return MG_ERR_INVALID_ARG;
  }

  mpack_node_t node = mpack_node_map_cstr(args, "title");
  if (mpack_node_type(node) != mpack_type_str) {
    return MG_ERR_INVALID_ARG;
  }

  size_t len = mpack_node_strlen(node);
  if (len == 0u) {
    return MG_ERR_INVALID_ARG;
  }

  char *copy = (char *)malloc(len + 1u);
  if (!copy) {
    return MG_ERR_OOM;
  }

  memcpy(copy, mpack_node_str(node), len);
  copy[len] = '\0';
  *out = copy;
  return MG_OK;
}

static int find_keyword(keyword_count_t *items, size_t count, mg_keyword_id_t id) {
  for (size_t i = 0u; i < count; ++i) {
    if (items[i].id == id) {
      return (int)i;
    }
  }
  return -1;
}

static mg_err_t add_keyword_count(keyword_count_t **items, size_t *count, size_t *cap, mg_keyword_id_t id) {
  int pos = find_keyword(*items, *count, id);
  if (pos >= 0) {
    (*items)[pos].count++;
    return MG_OK;
  }

  if (*count == *cap) {
    size_t new_cap = (*cap == 0u) ? 16u : (*cap * 2u);
    keyword_count_t *new_items = (keyword_count_t *)realloc(*items, new_cap * sizeof(**items));
    if (!new_items) {
      return MG_ERR_OOM;
    }
    *items = new_items;
    *cap = new_cap;
  }

  (*items)[*count].id = id;
  (*items)[*count].count = 1;
  (*items)[*count].text = NULL;
  (*count)++;
  return MG_OK;
}

static int cmp_keyword_count_desc(const void *a, const void *b) {
  const keyword_count_t *ka = (const keyword_count_t *)a;
  const keyword_count_t *kb = (const keyword_count_t *)b;
  if (ka->count != kb->count) {
    return kb->count - ka->count;
  }
  if (!ka->text && !kb->text) {
    return 0;
  }
  if (!ka->text) {
    return 1;
  }
  if (!kb->text) {
    return -1;
  }
  return strcmp(ka->text, kb->text);
}

mg_err_t mg_op_classify(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
  if (!ctx || !ctx->storage || !ctx->embed || !result) {
    return MG_ERR_INVALID_ARG;
  }

  char *title = NULL;
  mg_err_t err = copy_title(args, &title);
  if (err != MG_OK) {
    return err;
  }

  mg_embedding_t q;
  err = mg_embed_text(ctx->embed, title, q);
  free(title);
  if (err != MG_OK) {
    return err;
  }

  mg_node_score_t scored[50];
  int n_scored = 0;
  err = mg_storage_vector_topk(ctx->storage, q, 50, scored, &n_scored);
  if (err != MG_OK) {
    return err;
  }

  keyword_count_t *items = NULL;
  size_t count = 0u;
  size_t cap = 0u;

  for (int i = 0; i < n_scored; ++i) {
    mg_edge_t neighbors[128];
    int n_neighbors = 0;
    err = mg_storage_neighbors(
      ctx->storage,
      scored[i].id,
      MG_EDGE_KEYWORD,
      NULL,
      0u,
      neighbors,
      (int)(sizeof(neighbors) / sizeof(neighbors[0])),
      &n_neighbors
    );
    if (err != MG_OK) {
      free(items);
      return err;
    }

    for (int j = 0; j < n_neighbors; ++j) {
      mg_keyword_id_t kw_id = neighbors[j].keyword_id;
      if (kw_id == 0) {
        /* Neighbor has no real keyword id — skip it. The previous code
         * memcpy'd the first sizeof(kw_id) bytes of the destination UUID
         * into kw_id, which is garbage that fails later lookup and aborts
         * classify. Counting only makes sense for edges with a real
         * keyword id. */
        continue;
      }
      err = add_keyword_count(&items, &count, &cap, kw_id);
      if (err != MG_OK) {
        free(items);
        return err;
      }
    }
  }

  for (size_t i = 0u; i < count; ++i) {
    err = mg_storage_get_keyword_text(ctx->storage, items[i].id, &items[i].text);
    if (err != MG_OK) {
      for (size_t j = 0u; j < i; ++j) {
        free(items[j].text);
      }
      free(items);
      return err;
    }
  }

  qsort(items, count, sizeof(*items), cmp_keyword_count_desc);
  size_t out_count = (count < 15u) ? count : 15u;

  mpack_start_map(result, 1);
  mpack_write_cstr(result, "suggested_keywords");
  mpack_start_array(result, (uint32_t)out_count);
  for (size_t i = 0u; i < out_count; ++i) {
    mpack_write_cstr(result, items[i].text ? items[i].text : "");
  }
  mpack_finish_array(result);
  mpack_finish_map(result);

  for (size_t i = 0u; i < count; ++i) {
    free(items[i].text);
  }
  free(items);
  return MG_OK;
}
