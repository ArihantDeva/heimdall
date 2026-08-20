#include "graft/verify_internal.h"
#include "graft/llama_backend.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <ggml-backend.h>
#include <llama.h>

#if defined(_WIN32) && !defined(__MINGW32__) && !defined(__MINGW64__)
static int mg_ce_mutex_init(mg_ce_mutex_t *lock) {
  InitializeSRWLock(lock);
  return 0;
}
static int mg_ce_mutex_destroy(mg_ce_mutex_t *lock) {
  (void)lock;
  return 0;
}
static int mg_ce_mutex_lock(mg_ce_mutex_t *lock) {
  AcquireSRWLockExclusive(lock);
  return 0;
}
static int mg_ce_mutex_unlock(mg_ce_mutex_t *lock) {
  ReleaseSRWLockExclusive(lock);
  return 0;
}
#else
static int mg_ce_mutex_init(mg_ce_mutex_t *lock) {
  return pthread_mutex_init(lock, NULL);
}
static int mg_ce_mutex_destroy(mg_ce_mutex_t *lock) {
  return pthread_mutex_destroy(lock);
}
static int mg_ce_mutex_lock(mg_ce_mutex_t *lock) {
  return pthread_mutex_lock(lock);
}
static int mg_ce_mutex_unlock(mg_ce_mutex_t *lock) {
  return pthread_mutex_unlock(lock);
}
#endif

static char *mg_ce_strdup(const char *s) {
  size_t n;
  char *out;
  if (!s) return NULL;
  n = strlen(s);
  out = (char *)malloc(n + 1u);
  if (!out) return NULL;
  memcpy(out, s, n + 1u);
  return out;
}

static int mg_ce_contains_ci(const char *s, const char *needle) {
  size_t n;
  if (!s || !needle) return 0;
  n = strlen(needle);
  if (n == 0u) return 1;
  for (; *s; ++s) {
    size_t i = 0u;
    while (i < n && s[i] &&
           tolower((unsigned char)s[i]) == tolower((unsigned char)needle[i])) {
      i++;
    }
    if (i == n) return 1;
  }
  return 0;
}

static int mg_ce_positive_label_index(struct llama_model *model) {
  uint32_t n = llama_model_n_cls_out(model);
  if (n == 0u) return 0;
  for (uint32_t i = 0; i < n; ++i) {
    const char *label = llama_model_cls_label(model, i);
    if (mg_ce_contains_ci(label, "relevant") ||
        mg_ce_contains_ci(label, "positive") ||
        mg_ce_contains_ci(label, "true") ||
        mg_ce_contains_ci(label, "yes") ||
        mg_ce_contains_ci(label, "entail")) {
      return (int)i;
    }
  }
  return n > 1u ? (int)(n - 1u) : 0;
}

static int mg_ce_has_accelerator(void) {
  size_t n_devs = ggml_backend_dev_count();
  for (size_t i = 0; i < n_devs; ++i) {
    ggml_backend_dev_t d = ggml_backend_dev_get(i);
    enum ggml_backend_dev_type t = ggml_backend_dev_type(d);
    if (t == GGML_BACKEND_DEVICE_TYPE_GPU ||
        t == GGML_BACKEND_DEVICE_TYPE_IGPU ||
        t == GGML_BACKEND_DEVICE_TYPE_ACCEL) {
      return 1;
    }
  }
  return 0;
}

static char *mg_ce_replace_pair_template(const char *tmpl,
                                         const char *query,
                                         const char *candidate) {
  const char *q_pat = "{query}";
  const char *d_pat = "{document}";
  const char *p;
  size_t out_len = 0u;
  char *out;
  char *dst;

  if (!tmpl || !query || !candidate) return NULL;

  for (p = tmpl; *p;) {
    if (strncmp(p, q_pat, strlen(q_pat)) == 0) {
      out_len += strlen(query);
      p += strlen(q_pat);
    } else if (strncmp(p, d_pat, strlen(d_pat)) == 0) {
      out_len += strlen(candidate);
      p += strlen(d_pat);
    } else {
      out_len++;
      p++;
    }
  }

  out = (char *)malloc(out_len + 1u);
  if (!out) return NULL;

  dst = out;
  for (p = tmpl; *p;) {
    if (strncmp(p, q_pat, strlen(q_pat)) == 0) {
      size_t n = strlen(query);
      memcpy(dst, query, n);
      dst += n;
      p += strlen(q_pat);
    } else if (strncmp(p, d_pat, strlen(d_pat)) == 0) {
      size_t n = strlen(candidate);
      memcpy(dst, candidate, n);
      dst += n;
      p += strlen(d_pat);
    } else {
      *dst++ = *p++;
    }
  }
  *dst = '\0';
  return out;
}

static char *mg_ce_build_fallback_prompt(struct llama_model *model,
                                         const char *query,
                                         const char *candidate) {
  const struct llama_vocab *vocab = llama_model_get_vocab(model);
  const char *sep = "";
  const char *eos = "";
  size_t len;
  char *out;

  if (vocab) {
    if (llama_vocab_get_add_eos(vocab)) {
      eos = llama_vocab_get_text(vocab, llama_vocab_eos(vocab));
      if (!eos) eos = "";
    }
    if (llama_vocab_get_add_sep(vocab)) {
      sep = llama_vocab_get_text(vocab, llama_vocab_sep(vocab));
      if (!sep) sep = "";
    }
  }
  if (sep[0] == '\0') sep = eos;

  len = strlen(query) + strlen(candidate) + strlen(sep) + strlen(eos) + 1u;
  out = (char *)malloc(len + 1u);
  if (!out) return NULL;
  snprintf(out, len + 1u, "%s%s%s%s", query, sep, candidate, eos);
  return out;
}

static char *mg_ce_build_prompt(mg_verify_ctx_t *ctx,
                                const char *query,
                                const char *candidate,
                                const char *template_override) {
  const char *tmpl = template_override ? template_override
                                       : ctx->ce.rerank_template;
  if (tmpl && tmpl[0]) {
    char *templated = mg_ce_replace_pair_template(tmpl, query, candidate);
    if (templated) return templated;
  }
  return mg_ce_build_fallback_prompt(ctx->ce.model, query, candidate);
}

static float mg_ce_sigmoid(float x) {
  if (x >= 0.0f) {
    float z = expf(-x);
    return 1.0f / (1.0f + z);
  }
  {
    float z = expf(x);
    return z / (1.0f + z);
  }
}

static float mg_ce_softmax_pick(const float *scores, uint32_t n, int pick) {
  float max_v = scores[0];
  double denom = 0.0;
  for (uint32_t i = 1; i < n; ++i) {
    if (scores[i] > max_v) max_v = scores[i];
  }
  for (uint32_t i = 0; i < n; ++i) {
    denom += exp((double)scores[i] - (double)max_v);
  }
  if (denom <= 0.0) return 0.0f;
  return (float)(exp((double)scores[pick] - (double)max_v) / denom);
}

static float mg_ce_normalize_score(mg_verify_ctx_t *ctx, const float *scores) {
  uint32_t n = ctx->ce.n_cls_out;
  if (n <= 1u) {
    return mg_ce_sigmoid(scores[0]);
  }
  if (ctx->ce.positive_index < 0 || (uint32_t)ctx->ce.positive_index >= n) {
    return mg_ce_softmax_pick(scores, n, (int)(n - 1u));
  }
  return mg_ce_softmax_pick(scores, n, ctx->ce.positive_index);
}

int mg_ce_try_enable(mg_verify_ctx_t *ctx) {
  struct llama_model_params model_params;
  struct llama_context_params ctx_params;
  const char *tmpl;
  mg_err_t err;

  if (!ctx || !ctx->cfg.cross_encoder_model_path ||
      ctx->cfg.cross_encoder_model_path[0] == '\0') {
    return -1;
  }

  err = mg_llama_backend_acquire();
  if (err != MG_OK) {
    return -1;
  }
  ctx->ce.backend_acquired = 1;

  if (ctx->cfg.hardware_accel && !mg_ce_has_accelerator()) {
    fprintf(stderr,
            "cross-encoder: hardware_accel=true but no GPU/accelerator "
            "device is available; CE disabled\n");
    mg_ce_shutdown(ctx);
    return -1;
  }

  if (mg_ce_mutex_init(&ctx->ce.lock) != 0) {
    mg_ce_shutdown(ctx);
    return -1;
  }
  ctx->ce.lock_initialized = 1;

  model_params = llama_model_default_params();
  model_params.n_gpu_layers = ctx->cfg.hardware_accel ? -1 : 0;
  ctx->ce.model = llama_model_load_from_file(ctx->cfg.cross_encoder_model_path,
                                             model_params);
  if (!ctx->ce.model) {
    mg_ce_shutdown(ctx);
    return -1;
  }

  ctx->ce.n_cls_out = llama_model_n_cls_out(ctx->ce.model);
  if (ctx->ce.n_cls_out == 0u) {
    fprintf(stderr, "cross-encoder: model has no classifier outputs\n");
    mg_ce_shutdown(ctx);
    return -1;
  }
  ctx->ce.positive_index = mg_ce_positive_label_index(ctx->ce.model);

  ctx_params = llama_context_default_params();
  ctx_params.embeddings = true;
  ctx_params.pooling_type = LLAMA_POOLING_TYPE_RANK;
  ctx_params.n_ctx = (uint32_t)ctx->cfg.embed_ctx_size;
  ctx_params.n_batch = (uint32_t)ctx->cfg.embed_ctx_size;
  ctx_params.n_ubatch = (uint32_t)ctx->cfg.embed_ctx_size;
  ctx_params.n_seq_max = 1;
  ctx_params.n_threads = ctx->cfg.embed_threads;
  ctx_params.n_threads_batch = ctx->cfg.embed_threads;

  ctx->ce.ctx = llama_init_from_model(ctx->ce.model, ctx_params);
  if (!ctx->ce.ctx) {
    mg_ce_shutdown(ctx);
    return -1;
  }
  ctx->ce.n_ctx = ctx->cfg.embed_ctx_size;

  tmpl = llama_model_chat_template(ctx->ce.model, "rerank");
  if (tmpl) {
    ctx->ce.rerank_template = mg_ce_strdup(tmpl);
    if (!ctx->ce.rerank_template) {
      mg_ce_shutdown(ctx);
      return -1;
    }
  }

  return 0;
}

static int mg_ce_score_with_template(mg_verify_ctx_t *ctx,
                                     const char *query,
                                     const char *candidate,
                                     const char *template_override,
                                     float *out) {
  const struct llama_vocab *vocab;
  llama_token *tokens = NULL;
  char *prompt = NULL;
  int32_t prompt_len;
  int32_t n_tokens;
  struct llama_batch batch;
  float *scores;
  int rc = -1;

  if (!ctx || !ctx->ce.ctx || !ctx->ce.model || !query || !candidate || !out) {
    return -1;
  }
  *out = NAN;

  prompt = mg_ce_build_prompt(ctx, query, candidate, template_override);
  if (!prompt) {
    return -1;
  }
  if (strlen(prompt) > (size_t)INT32_MAX) {
    free(prompt);
    return -1;
  }
  prompt_len = (int32_t)strlen(prompt);

  tokens = (llama_token *)calloc((size_t)ctx->ce.n_ctx, sizeof(*tokens));
  if (!tokens) {
    free(prompt);
    return -1;
  }

  if (mg_ce_mutex_lock(&ctx->ce.lock) != 0) {
    goto done;
  }

  llama_memory_clear(llama_get_memory(ctx->ce.ctx), true);

  vocab = llama_model_get_vocab(ctx->ce.model);
  n_tokens = llama_tokenize(vocab, prompt, prompt_len, tokens,
                            ctx->ce.n_ctx, true, true);
  if (n_tokens <= 0 || n_tokens > ctx->ce.n_ctx) {
    (void)mg_ce_mutex_unlock(&ctx->ce.lock);
    goto done;
  }

  batch = llama_batch_get_one(tokens, n_tokens);
  if (llama_model_has_encoder(ctx->ce.model)) {
    if (llama_encode(ctx->ce.ctx, batch) != 0) {
      (void)mg_ce_mutex_unlock(&ctx->ce.lock);
      goto done;
    }
  } else if (llama_decode(ctx->ce.ctx, batch) != 0) {
    (void)mg_ce_mutex_unlock(&ctx->ce.lock);
    goto done;
  }

  scores = llama_get_embeddings_seq(ctx->ce.ctx, 0);
  if (!scores) {
    (void)mg_ce_mutex_unlock(&ctx->ce.lock);
    goto done;
  }

  *out = mg_ce_normalize_score(ctx, scores);
  rc = 0;

  if (mg_ce_mutex_unlock(&ctx->ce.lock) != 0) {
    rc = -1;
    *out = NAN;
  }

done:
  free(tokens);
  free(prompt);
  return rc;
}

int mg_ce_score_pair(mg_verify_ctx_t *ctx, const char *query, const char *candidate, float *out) {
  return mg_ce_score_with_template(ctx, query, candidate, NULL, out);
}

int mg_ce_score_nli(mg_verify_ctx_t *ctx, const char *query, const char *candidate, float *out) {
  if (!ctx) {
    if (out) *out = NAN;
    return -1;
  }
  /* When the template is missing/empty, fall back to the default rerank
   * prompt — caller still gets a usable score, just without entailment
   * framing. */
  return mg_ce_score_with_template(ctx, query, candidate,
                                   ctx->cfg.nli_prompt_template, out);
}

void mg_ce_shutdown(mg_verify_ctx_t *ctx) {
  if (!ctx) return;
  if (ctx->ce.ctx) {
    llama_free(ctx->ce.ctx);
    ctx->ce.ctx = NULL;
  }
  if (ctx->ce.model) {
    llama_model_free(ctx->ce.model);
    ctx->ce.model = NULL;
  }
  free(ctx->ce.rerank_template);
  ctx->ce.rerank_template = NULL;
  if (ctx->ce.lock_initialized) {
    (void)mg_ce_mutex_destroy(&ctx->ce.lock);
    ctx->ce.lock_initialized = 0;
  }
  ctx->ce.n_ctx = 0;
  ctx->ce.n_cls_out = 0;
  ctx->ce.positive_index = -1;
  if (ctx->ce.backend_acquired) {
    mg_llama_backend_release();
    ctx->ce.backend_acquired = 0;
  }
}
