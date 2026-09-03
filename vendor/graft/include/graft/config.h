#ifndef GRAFT_CONFIG_H
#define GRAFT_CONFIG_H

#include "graft/error.h"
#include <stdbool.h>

typedef struct {
  /* daemon */
  char *socket_path;
  char *db_path;

  /* embedding */
  char *embed_model_path;
  int   embed_threads;
  int   embed_ctx_size;
  int   embed_instances;
  bool  hardware_accel;          /* offload model to GPU (CUDA/ROCm) — requires llama.cpp built with the matching backend */

  /* verification (feature flags) */
  bool  cross_encoder_enabled;
  char *cross_encoder_model_path;
  bool  nli_enabled;
  char *nli_prompt_template;     /* CE template repurposed for entailment when nli_enabled */

  /* gating thresholds */
  float strong_hit_min_ce;
  float weak_hit_min_vec;
  float min_lex_overlap;
  float strong_hit_min_lex;
  float verify_lex_strong_min_vec;     /* min s_vec for lexical_strong path */
  float verify_sem_strong_min_vec;     /* min s_vec for semantic_strong path */
  float verify_sem_strong_lex_margin;  /* margin above min_lex_overlap for semantic_strong */
  bool  verify_use_fused_gate;         /* if true, gate STRONG/WEAK on fused score instead of boolean rules */
  float verify_strong_min_fused;       /* fused-score floor for STRONG when use_fused_gate */
  float verify_weak_min_fused;         /* fused-score floor for WEAK when use_fused_gate */

  /* retrieval */
  int   retrieve_top_k;
  int   rrf_k_const;
  int   query_fallback_top_k;   /* cap on results returned in query MISS fallback_retrieve */

  /* rerank — second-stage reranker over RRF output */
  bool  rerank_enabled;         /* default false; when false retrieve output is RRF-ordered */
  int   rerank_top_k;           /* number of top RRF candidates to actually rerank */
  float rerank_w_vec;           /* weight on s_vec in fusion */
  float rerank_w_lex;           /* weight on s_lex in fusion */
  float rerank_w_ce;            /* weight on s_ce in fusion */
  float rerank_w_nli;           /* weight on s_nli in fusion (requires nli_enabled) */

  /* edges */
  float edge_keyword_min;
  float edge_semantic_min;
  int   edge_keyword_topk;
  int   edge_semantic_topk;
  float mmr_lambda;

  /* explore */
  int   explore_default_beam;
  int   explore_default_depth;
  float explore_decay_gamma;
  float explore_alpha;          /* peso semantic vs edge */

  /* http (REST + viewer; off by default) */
  bool   http_enabled;
  char  *http_bind;             /* default "127.0.0.1" — local-first */
  int    http_port;             /* default 9977 */
  bool   http_allow_remote;     /* default false — must be set to bind a non-loopback address */
  bool   http_tls_terminated_externally; /* operator attestation that a TLS terminator (caddy/nginx/stunnel) fronts the daemon */
  char  *http_auth_token;       /* if non-NULL, /v1/... requires Authorization: Bearer <token>. Env GRAFT_HTTP_AUTH_TOKEN overrides. */
  char  *http_readonly_token;   /* optional second token. When matched, ONLY read endpoints (match/search/explore/classify/view) are allowed; writes get 403. */
  bool   http_view_anonymize;   /* when true, /v1/view strips titles and primary_keyword (topology only) */
  char  *http_view_keyword_scope; /* when set, /v1/view returns only nodes tagged with this keyword (RBAC-lite) */
  bool   http_ep_match;
  bool   http_ep_search;
  bool   http_ep_explore;
  bool   http_ep_classify;
  bool   http_ep_insert;
  bool   http_ep_delete;        /* default false — sensitive */
  bool   http_ep_view;
  char  *http_viewer_path;       /* directory of the static SPA bundle (index.html, assets/) */
} mg_config_t;

mg_err_t mg_config_load(const char *path, mg_config_t *out);
void     mg_config_free(mg_config_t *cfg);

/* Default values quando una chiave manca */
void     mg_config_defaults(mg_config_t *cfg);

#endif
