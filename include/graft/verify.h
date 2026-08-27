#ifndef GRAFT_VERIFY_H
#define GRAFT_VERIFY_H

#include "graft/error.h"
#include "graft/types.h"
#include "graft/config.h"

typedef struct mg_verify_ctx mg_verify_ctx_t;

typedef enum {
  MG_HIT_NONE   = 0,
  MG_HIT_WEAK   = 1,
  MG_HIT_STRONG = 2
} mg_hit_t;

typedef struct {
  float    s_vec;       /* cosine similarity */
  float    s_lex;       /* alias of s_jaccard for now (trigram Jaccard) */
  float    s_jaccard;   /* trigram overlap [0,1] */
  float    s_ce;        /* cross-encoder, NaN se disabilitato */
  float    s_nli;       /* entailment via CE with nli template, NaN se disabilitato */
  mg_hit_t hit_level;
} mg_verify_signals_t;

mg_err_t mg_verify_init(const mg_config_t *cfg, mg_verify_ctx_t **out);
void     mg_verify_shutdown(mg_verify_ctx_t *ctx);

/* Calcola tutti i segnali. Se cross-encoder e' disabilitato in config, s_ce=NaN.
 * Riempie hit_level secondo la logica di gating. */
mg_err_t mg_verify_score(
  mg_verify_ctx_t *ctx,
  const char *query_text,
  const char *candidate_title,
  float pre_computed_s_vec,
  float pre_computed_s_lex,
  mg_verify_signals_t *out
);

/* Jaccard su trigram di caratteri normalizzati (utility) */
float mg_text_trigram_jaccard(const char *a, const char *b);

#endif
