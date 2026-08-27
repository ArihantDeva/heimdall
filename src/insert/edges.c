#include "graft/config.h"
#include "graft/embed.h"
#include "graft/storage.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
  mg_node_id_t id;
  float score;
  mg_embedding_t emb;
} semantic_candidate_t;

static int ids_equal(const mg_node_id_t a, const mg_node_id_t b) {
  return memcmp(a, b, MG_NODE_ID_BYTES) == 0;
}

static mg_err_t append_edge(mg_edge_t **edges, size_t *count, size_t *cap, const mg_edge_t *edge) {
  if (*count == *cap) {
    size_t new_cap = (*cap == 0u) ? 16u : (*cap * 2u);
    mg_edge_t *new_edges = (mg_edge_t *)realloc(*edges, new_cap * sizeof(**edges));
    if (!new_edges) {
      return MG_ERR_OOM;
    }
    *edges = new_edges;
    *cap = new_cap;
  }

  (*edges)[*count] = *edge;
  (*count)++;
  return MG_OK;
}

static float max_redundancy(const semantic_candidate_t *selected, size_t n_selected, const mg_embedding_t emb) {
  float max = 0.0f;
  for (size_t i = 0u; i < n_selected; ++i) {
    float cosine = mg_cosine(emb, selected[i].emb);
    if (cosine > max) {
      max = cosine;
    }
  }
  return max;
}

mg_err_t mg_insert_build_edges_from_embedding(
  mg_storage_t *s,
  const mg_config_t *cfg,
  const mg_node_id_t src,
  const mg_embedding_t q,
  const mg_keyword_id_t *kw_ids,
  size_t n_kw,
  mg_edge_t **out_edges,
  size_t *out_n_edges,
  size_t *out_n_kw_edges,
  size_t *out_n_sem_edges
) {
  if (!s || !cfg || !src || !q || (!kw_ids && n_kw > 0u) || !out_edges || !out_n_edges ||
      !out_n_kw_edges || !out_n_sem_edges) {
    return MG_ERR_INVALID_ARG;
  }

  *out_edges = NULL;
  *out_n_edges = 0u;
  *out_n_kw_edges = 0u;
  *out_n_sem_edges = 0u;

  mg_edge_t *edges = NULL;
  size_t n_edges = 0u;
  size_t cap_edges = 0u;

  int keyword_topk = cfg->edge_keyword_topk > 0 ? cfg->edge_keyword_topk : 5;
  int semantic_topk = cfg->edge_semantic_topk > 0 ? cfg->edge_semantic_topk : 20;

  for (size_t i = 0u; i < n_kw; ++i) {
    mg_node_score_t *scored = (mg_node_score_t *)calloc((size_t)keyword_topk, sizeof(*scored));
    if (!scored) {
      free(edges);
      return MG_ERR_OOM;
    }

    int n_scored = 0;
    mg_err_t err = mg_storage_vector_topk_by_keyword(s, q, kw_ids[i], keyword_topk, scored, &n_scored);
    if (err != MG_OK) {
      free(scored);
      free(edges);
      return err;
    }

    for (int j = 0; j < n_scored; ++j) {
      if (ids_equal(src, scored[j].id) || scored[j].score < cfg->edge_keyword_min) {
        continue;
      }

      mg_edge_t edge;
      memcpy(edge.src, src, MG_NODE_ID_BYTES);
      memcpy(edge.dst, scored[j].id, MG_NODE_ID_BYTES);
      edge.kind = MG_EDGE_KEYWORD;
      edge.keyword_id = kw_ids[i];
      edge.weight = scored[j].score;

      err = append_edge(&edges, &n_edges, &cap_edges, &edge);
      if (err != MG_OK) {
        free(scored);
        free(edges);
        return err;
      }
      (*out_n_kw_edges)++;
      err = mg_storage_record_sample(s, 0, scored[j].score);
      if (err != MG_OK) {
        free(scored);
        free(edges);
        return err;
      }
    }
    free(scored);
  }

  mg_node_score_t *top = (mg_node_score_t *)calloc((size_t)semantic_topk, sizeof(*top));
  semantic_candidate_t *pool = (semantic_candidate_t *)calloc((size_t)semantic_topk, sizeof(*pool));
  semantic_candidate_t *selected = (semantic_candidate_t *)calloc((size_t)semantic_topk, sizeof(*selected));
  if (!top || !pool || !selected) {
    free(top);
    free(pool);
    free(selected);
    free(edges);
    return MG_ERR_OOM;
  }

  int n_top = 0;
  mg_err_t err = mg_storage_vector_topk(s, q, semantic_topk, top, &n_top);
  if (err != MG_OK) {
    free(top);
    free(pool);
    free(selected);
    free(edges);
    return err;
  }

  size_t n_pool = 0u;
  for (int i = 0; i < n_top; ++i) {
    if (ids_equal(src, top[i].id)) {
      continue;
    }

    memcpy(pool[n_pool].id, top[i].id, MG_NODE_ID_BYTES);
    pool[n_pool].score = top[i].score;
    err = mg_storage_get_embedding(s, top[i].id, pool[n_pool].emb);
    if (err != MG_OK) {
      free(top);
      free(pool);
      free(selected);
      free(edges);
      return err;
    }
    n_pool++;
  }

  size_t n_selected = 0u;
  float lambda = cfg->mmr_lambda;
  if (lambda < 0.0f) {
    lambda = 0.0f;
  } else if (lambda > 1.0f) {
    lambda = 1.0f;
  }

  while (n_selected < (size_t)semantic_topk && n_pool > 0u) {
    size_t best = 0u;
    float best_mmr = lambda * pool[0].score - (1.0f - lambda) * max_redundancy(selected, n_selected, pool[0].emb);

    for (size_t i = 1u; i < n_pool; ++i) {
      float redundancy = max_redundancy(selected, n_selected, pool[i].emb);
      float mmr = lambda * pool[i].score - (1.0f - lambda) * redundancy;
      if (mmr > best_mmr) {
        best_mmr = mmr;
        best = i;
      }
    }

    if (pool[best].score < cfg->edge_semantic_min) {
      break;
    }

    selected[n_selected++] = pool[best];
    pool[best] = pool[n_pool - 1u];
    n_pool--;
  }

  for (size_t i = 0u; i < n_selected; ++i) {
    mg_edge_t edge;
    memcpy(edge.src, src, MG_NODE_ID_BYTES);
    memcpy(edge.dst, selected[i].id, MG_NODE_ID_BYTES);
    edge.kind = MG_EDGE_SEMANTIC;
    edge.keyword_id = 0;
    edge.weight = selected[i].score;

    err = append_edge(&edges, &n_edges, &cap_edges, &edge);
    if (err != MG_OK) {
      free(top);
      free(pool);
      free(selected);
      free(edges);
      return err;
    }
    (*out_n_sem_edges)++;
    err = mg_storage_record_sample(s, 0, selected[i].score);
    if (err != MG_OK) {
      free(top);
      free(pool);
      free(selected);
      free(edges);
      return err;
    }
  }

  free(top);
  free(pool);
  free(selected);

  *out_edges = edges;
  *out_n_edges = n_edges;
  return MG_OK;
}
