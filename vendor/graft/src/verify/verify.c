#include "graft/verify_internal.h"
#include "graft/score.h"

#include <ctype.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *mg_verify_strdup(const char *s) {
  size_t len;
  char *out;

  if (!s) {
    return NULL;
  }
  len = strlen(s);
  out = (char *)malloc(len + 1u);
  if (!out) {
    return NULL;
  }
  memcpy(out, s, len + 1u);
  return out;
}

static mg_err_t mg_verify_copy_config(const mg_config_t *src, mg_config_t *dst) {
  if (!src || !dst) {
    return MG_ERR_INVALID_ARG;
  }

  *dst = *src;
  dst->socket_path = mg_verify_strdup(src->socket_path);
  dst->db_path = mg_verify_strdup(src->db_path);
  dst->embed_model_path = mg_verify_strdup(src->embed_model_path);
  dst->cross_encoder_model_path = mg_verify_strdup(src->cross_encoder_model_path);
  dst->nli_prompt_template = mg_verify_strdup(src->nli_prompt_template);
  dst->http_bind = mg_verify_strdup(src->http_bind);
  dst->http_auth_token = mg_verify_strdup(src->http_auth_token);
  dst->http_readonly_token = mg_verify_strdup(src->http_readonly_token);
  dst->http_view_keyword_scope = mg_verify_strdup(src->http_view_keyword_scope);
  dst->http_viewer_path = mg_verify_strdup(src->http_viewer_path);

  if ((src->socket_path && !dst->socket_path) ||
      (src->db_path && !dst->db_path) ||
      (src->embed_model_path && !dst->embed_model_path) ||
      (src->cross_encoder_model_path && !dst->cross_encoder_model_path) ||
      (src->nli_prompt_template && !dst->nli_prompt_template) ||
      (src->http_bind && !dst->http_bind) ||
      (src->http_auth_token && !dst->http_auth_token) ||
      (src->http_readonly_token && !dst->http_readonly_token) ||
      (src->http_view_keyword_scope && !dst->http_view_keyword_scope) ||
      (src->http_viewer_path && !dst->http_viewer_path)) {
    mg_config_free(dst);
    return MG_ERR_OOM;
  }

  return MG_OK;
}

mg_err_t mg_verify_init(const mg_config_t *cfg, mg_verify_ctx_t **out) {
  mg_verify_ctx_t *ctx;
  mg_err_t err;

  if (!cfg || !out) {
    return MG_ERR_INVALID_ARG;
  }
  *out = NULL;

  ctx = (mg_verify_ctx_t *)calloc(1, sizeof(*ctx));
  if (!ctx) {
    return MG_ERR_OOM;
  }

  err = mg_verify_copy_config(cfg, &ctx->cfg);
  if (err != MG_OK) {
    free(ctx);
    return err;
  }

  ctx->ce_runtime_enabled = false;
  if (ctx->cfg.cross_encoder_enabled) {
    ctx->ce_runtime_enabled = mg_ce_try_enable(ctx) == 0;
    if (!ctx->ce_runtime_enabled) {
      fprintf(stderr, "graft: cross-encoder unavailable; continuing with CE disabled\n");
    }
  }

  *out = ctx;
  return MG_OK;
}

void mg_verify_shutdown(mg_verify_ctx_t *ctx) {
  if (!ctx) {
    return;
  }
  mg_ce_shutdown(ctx);
  mg_config_free(&ctx->cfg);
  free(ctx);
}

static int mg_cmp_u32(const void *a, const void *b) {
  const uint32_t av = *(const uint32_t *)a;
  const uint32_t bv = *(const uint32_t *)b;
  return (av > bv) - (av < bv);
}

static uint32_t mg_tri_code(unsigned char a, unsigned char b, unsigned char c) {
  return ((uint32_t)a << 16) | ((uint32_t)b << 8) | (uint32_t)c;
}

static uint32_t *mg_make_trigrams(const char *s, size_t *out_count) {
  size_t len;
  size_t raw_count;
  unsigned char *buf;
  uint32_t *grams;
  size_t unique = 0;

  if (!s || !out_count) {
    return NULL;
  }
  *out_count = 0;
  len = strlen(s);
  if (len == 0u) {
    return NULL;
  }

  raw_count = len + 2u;
  buf = (unsigned char *)calloc(len + 4u, sizeof(*buf));
  grams = (uint32_t *)calloc(raw_count, sizeof(*grams));
  if (!buf || !grams) {
    free(buf);
    free(grams);
    return NULL;
  }

  buf[0] = ' ';
  buf[1] = ' ';
  for (size_t i = 0; i < len; i++) {
    unsigned char ch = (unsigned char)s[i];
    buf[i + 2u] = (unsigned char)tolower(ch);
  }
  buf[len + 2u] = ' ';
  buf[len + 3u] = ' ';

  for (size_t i = 0; i < raw_count; i++) {
    grams[i] = mg_tri_code(buf[i], buf[i + 1u], buf[i + 2u]);
  }
  free(buf);

  qsort(grams, raw_count, sizeof(*grams), mg_cmp_u32);
  for (size_t i = 0; i < raw_count; i++) {
    if (i == 0u || grams[i] != grams[i - 1u]) {
      grams[unique++] = grams[i];
    }
  }

  *out_count = unique;
  return grams;
}

float mg_text_trigram_jaccard(const char *a, const char *b) {
  uint32_t *ga;
  uint32_t *gb;
  size_t na = 0;
  size_t nb = 0;
  size_t ia = 0;
  size_t ib = 0;
  size_t intersection = 0;
  size_t uni;

  if (!a || !b) {
    return 0.0f;
  }

  ga = mg_make_trigrams(a, &na);
  gb = mg_make_trigrams(b, &nb);
  if (na == 0u && nb == 0u) {
    free(ga);
    free(gb);
    return 0.0f;
  }
  if ((na > 0u && !ga) || (nb > 0u && !gb)) {
    free(ga);
    free(gb);
    return 0.0f;
  }

  while (ia < na && ib < nb) {
    if (ga[ia] == gb[ib]) {
      intersection++;
      ia++;
      ib++;
    } else if (ga[ia] < gb[ib]) {
      ia++;
    } else {
      ib++;
    }
  }

  uni = na + nb - intersection;
  free(ga);
  free(gb);
  return uni == 0u ? 0.0f : (float)intersection / (float)uni;
}

mg_err_t mg_verify_score(mg_verify_ctx_t *ctx,
                         const char *query_text,
                         const char *candidate_title,
                         float pre_computed_s_vec,
                         float pre_computed_s_lex,
                         mg_verify_signals_t *out) {
  bool has_ce;
  bool ce_ok;
  bool lexical_strong;
  bool semantic_strong;
  bool strong;
  bool weak;

  if (!ctx || !query_text || !candidate_title || !out) {
    return MG_ERR_INVALID_ARG;
  }

  out->s_vec = pre_computed_s_vec;
  if (out->s_vec < 0.0f) out->s_vec = 0.0f;
  if (out->s_vec > 1.0f) out->s_vec = 1.0f;
  out->s_lex = pre_computed_s_lex;
  out->s_jaccard = out->s_lex;
  out->s_ce = NAN;
  out->s_nli = NAN;

  if (ctx->ce_runtime_enabled) {
    float ce = NAN;
    if (mg_ce_score_pair(ctx, query_text, candidate_title, &ce) == 0) {
      out->s_ce = ce;
    }
    if (ctx->cfg.nli_enabled) {
      float nli = NAN;
      if (mg_ce_score_nli(ctx, query_text, candidate_title, &nli) == 0) {
        out->s_nli = nli;
      }
    }
  }

  if (ctx->cfg.verify_use_fused_gate) {
    /* Alternative gate: decide STRONG/WEAK/NONE from the fused score using
     * the same weights as the rerank module. NaN fused (no signal at all)
     * collapses to MG_HIT_NONE. The legacy boolean rules below are skipped. */
    float fused = mg_score_fuse(out->s_vec, out->s_lex,
                                out->s_ce,  out->s_nli,
                                ctx->cfg.rerank_w_vec, ctx->cfg.rerank_w_lex,
                                ctx->cfg.rerank_w_ce,  ctx->cfg.rerank_w_nli);
    if (!isnan(fused) && fused >= ctx->cfg.verify_strong_min_fused) {
      out->hit_level = MG_HIT_STRONG;
    } else if (!isnan(fused) && fused >= ctx->cfg.verify_weak_min_fused) {
      out->hit_level = MG_HIT_WEAK;
    } else {
      out->hit_level = MG_HIT_NONE;
    }
    return MG_OK;
  }

  has_ce = !isnan(out->s_ce);
  ce_ok = has_ce ? out->s_ce >= ctx->cfg.strong_hit_min_ce : true;
  /* If CE is disabled or failed gracefully, strong hits fall back to local
   * signals. The lexical path is strict and preserves the old behavior. The
   * semantic path catches cross-language cache hits where BGE-M3 aligns the
   * query but trigram overlap is naturally low; it still requires the minimum
   * lexical overlap so unrelated high-vector neighbors do not become hits. */
  lexical_strong = out->s_lex >= ctx->cfg.strong_hit_min_lex &&
                   out->s_vec >= ctx->cfg.verify_lex_strong_min_vec;
  semantic_strong = out->s_vec >= ctx->cfg.verify_sem_strong_min_vec &&
                    out->s_lex >= ctx->cfg.min_lex_overlap + ctx->cfg.verify_sem_strong_lex_margin;
  strong = ce_ok && (lexical_strong || semantic_strong);
  weak = !strong &&
         out->s_vec >= ctx->cfg.weak_hit_min_vec &&
         out->s_lex >= ctx->cfg.min_lex_overlap;

  if (strong) {
    out->hit_level = MG_HIT_STRONG;
  } else if (weak) {
    out->hit_level = MG_HIT_WEAK;
  } else {
    out->hit_level = MG_HIT_NONE;
  }

  return MG_OK;
}
