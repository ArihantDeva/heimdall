/* requires llama built */
#include "graft/embed.h"
#include "graft/llama_backend.h"

#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <string.h>

#if defined(_WIN32) && !defined(__MINGW32__) && !defined(__MINGW64__)
#include <windows.h>
#else
#include <pthread.h>
#endif

#include <llama.h>
#include <ggml-backend.h>

#if defined(_WIN32) && !defined(__MINGW32__) && !defined(__MINGW64__)
typedef SRWLOCK mg_mutex_t;
#define MG_MUTEX_INITIALIZER SRWLOCK_INIT
static int mg_mutex_init(mg_mutex_t *lock) {
  InitializeSRWLock(lock);
  return 0;
}
static int mg_mutex_destroy(mg_mutex_t *lock) {
  (void)lock;
  return 0;
}
static int mg_mutex_lock(mg_mutex_t *lock) {
  AcquireSRWLockExclusive(lock);
  return 0;
}
static int mg_mutex_unlock(mg_mutex_t *lock) {
  ReleaseSRWLockExclusive(lock);
  return 0;
}
#else
typedef pthread_mutex_t mg_mutex_t;
#define MG_MUTEX_INITIALIZER PTHREAD_MUTEX_INITIALIZER
static int mg_mutex_init(mg_mutex_t *lock) {
  return pthread_mutex_init(lock, NULL);
}
static int mg_mutex_destroy(mg_mutex_t *lock) {
  return pthread_mutex_destroy(lock);
}
static int mg_mutex_lock(mg_mutex_t *lock) {
  return pthread_mutex_lock(lock);
}
static int mg_mutex_unlock(mg_mutex_t *lock) {
  return pthread_mutex_unlock(lock);
}
#endif

struct mg_embed_instance {
  struct llama_context *ctx;
  mg_mutex_t            lock;
  int                   n_ctx;
};

struct mg_embed_ctx {
  struct llama_model       *model;
  struct mg_embed_instance *inst;
  int                       n_inst;
  int                       locks_init;
  atomic_uint               pick;
};

static void mg_embed_ctx_free_partial(mg_embed_ctx_t *ctx, int lock_initialized) {
  if (!ctx) {
    return;
  }
  if (ctx->inst) {
    for (int i = 0; i < ctx->n_inst; i++) {
      struct mg_embed_instance *it = &ctx->inst[i];
      if (it->ctx) {
        llama_free(it->ctx);
      }
      if (lock_initialized && i < ctx->locks_init) {
        (void)mg_mutex_destroy(&it->lock);
      }
    }
    free(ctx->inst);
  }
  if (ctx->model) {
    llama_model_free(ctx->model);
  }
  free(ctx);
}

static mg_err_t mg_normalize(const float *src, int dim, mg_embedding_t out) {
  double sum = 0.0;

  if (!src || !out || dim != MG_EMBEDDING_DIM) {
    return MG_ERR_INVALID_ARG;
  }

  for (int i = 0; i < dim; i++) {
    sum += (double)src[i] * (double)src[i];
  }

  if (sum <= 0.0) {
    return MG_ERR_EMBED;
  }

  const float inv_norm = (float)(1.0 / sqrt(sum));
  for (int i = 0; i < dim; i++) {
    out[i] = src[i] * inv_norm;
  }

  return MG_OK;
}

mg_err_t mg_embed_init(const char *model_path, int threads, int ctx_size,
                       bool hardware_accel, int instances, mg_embed_ctx_t **out) {
  mg_err_t err;
  mg_embed_ctx_t *ctx;
  struct llama_model_params model_params;
  struct llama_context_params ctx_params;
  int n_embd;

  if (!model_path || !out || threads <= 0 || ctx_size <= 0 || instances <= 0) {
    return MG_ERR_INVALID_ARG;
  }

  *out = NULL;

  err = mg_llama_backend_acquire();
  if (err != MG_OK) {
    return err;
  }

  if (hardware_accel) {
    /* Enumerate ggml devices and require at least one real accelerator (GPU,
     * iGPU, or ACCEL). llama_supports_gpu_offload() is too permissive — it
     * can return true on CPU-only builds — so we check the device list
     * directly. */
    ggml_backend_dev_t accel_dev = NULL;
    size_t n_devs = ggml_backend_dev_count();
    for (size_t i = 0; i < n_devs; ++i) {
      ggml_backend_dev_t d = ggml_backend_dev_get(i);
      enum ggml_backend_dev_type t = ggml_backend_dev_type(d);
      if (t == GGML_BACKEND_DEVICE_TYPE_GPU ||
          t == GGML_BACKEND_DEVICE_TYPE_IGPU ||
          t == GGML_BACKEND_DEVICE_TYPE_ACCEL) {
        accel_dev = d;
        break;
      }
    }
    if (!accel_dev) {
      fprintf(stderr,
              "embed: hardware_accel=true but no GPU/accelerator device is "
              "available. Rebuild llama.cpp with -DGGML_CUDA=ON (NVIDIA) or "
              "-DGGML_HIP=ON (ROCm 6/7), or set hardware_accel: false.\n");
      mg_llama_backend_release();
      return MG_ERR_CONFIG;
    }
    fprintf(stderr, "embed: hardware_accel=true, using device '%s'\n",
            ggml_backend_dev_name(accel_dev));
  }

  ctx = (mg_embed_ctx_t *)calloc(1, sizeof(*ctx));
  if (!ctx) {
    mg_llama_backend_release();
    return MG_ERR_OOM;
  }
  ctx->n_inst = instances;
  ctx->inst = (struct mg_embed_instance *)calloc((size_t)instances,
                                                 sizeof(*ctx->inst));
  if (!ctx->inst) {
    free(ctx);
    mg_llama_backend_release();
    return MG_ERR_OOM;
  }

  model_params = llama_model_default_params();
  /* Negative n_gpu_layers means "all layers". 0 forces CPU even if a GPU
   * backend is compiled in, which is the safer default for users who don't
   * opt in. */
  model_params.n_gpu_layers = hardware_accel ? -1 : 0;
  ctx->model = llama_model_load_from_file(model_path, model_params);
  if (!ctx->model) {
    mg_embed_ctx_free_partial(ctx, 1);
    mg_llama_backend_release();
    return MG_ERR_EMBED;
  }

  n_embd = llama_model_n_embd_out(ctx->model);
  if (n_embd <= 0) {
    n_embd = llama_model_n_embd(ctx->model);
  }
  if (n_embd != MG_EMBEDDING_DIM) {
    mg_embed_ctx_free_partial(ctx, 1);
    mg_llama_backend_release();
    return MG_ERR_EMBED;
  }

  ctx_params = llama_context_default_params();
  ctx_params.embeddings = true;
  ctx_params.pooling_type = LLAMA_POOLING_TYPE_MEAN;
  ctx_params.n_ctx = (uint32_t)ctx_size;
  ctx_params.n_batch = (uint32_t)ctx_size;
  ctx_params.n_ubatch = (uint32_t)ctx_size;
  ctx_params.n_seq_max = 1;
  ctx_params.n_threads = threads;
  ctx_params.n_threads_batch = threads;

  /* Pool: N independent contexts sharing one model — concurrent decode is
   * safe (weights are read-only); each instance serializes its own decode. */
  for (int i = 0; i < ctx->n_inst; i++) {
    struct mg_embed_instance *it = &ctx->inst[i];
    it->n_ctx = ctx_size;
    if (mg_mutex_init(&it->lock) != 0) {
      mg_embed_ctx_free_partial(ctx, 1);
      mg_llama_backend_release();
      return MG_ERR_INTERNAL;
    }
    ctx->locks_init++;
    it->ctx = llama_init_from_model(ctx->model, ctx_params);
    if (!it->ctx) {
      mg_embed_ctx_free_partial(ctx, 1);
      mg_llama_backend_release();
      return MG_ERR_EMBED;
    }
  }

  atomic_init(&ctx->pick, 0u);
  *out = ctx;
  return MG_OK;
}

void mg_embed_shutdown(mg_embed_ctx_t *ctx) {
  if (!ctx) {
    return;
  }

  mg_embed_ctx_free_partial(ctx, 1);
  mg_llama_backend_release();
}

static mg_err_t embed_instance_text(struct mg_embed_instance *inst,
                                    struct llama_model *model,
                                    const char *text, mg_embedding_t out) {
  const struct llama_vocab *vocab;
  llama_token *tokens;
  int32_t text_len;
  int32_t n_tokens;
  struct llama_batch batch;
  float *embedding;
  mg_err_t err = MG_OK;

  if (!inst || !model || !text || !out) {
    return MG_ERR_INVALID_ARG;
  }

  if (strlen(text) > (size_t)INT32_MAX) {
    return MG_ERR_INVALID_ARG;
  }
  text_len = (int32_t)strlen(text);

  tokens = (llama_token *)calloc((size_t)inst->n_ctx, sizeof(*tokens));
  if (!tokens) {
    return MG_ERR_OOM;
  }

  if (mg_mutex_lock(&inst->lock) != 0) {
    free(tokens);
    return MG_ERR_INTERNAL;
  }

  llama_memory_clear(llama_get_memory(inst->ctx), true);

  vocab = llama_model_get_vocab(model);
  n_tokens = llama_tokenize(vocab, text, text_len, tokens, inst->n_ctx, true, false);
  if (n_tokens > inst->n_ctx) {
    /* Config documents longer inputs as truncated ("longer inputs get
     * truncated, hurting recall"). Honor that: clamp to the context
     * window instead of failing the whole insert — a truncated embedding
     * beats a lost node. */
    n_tokens = inst->n_ctx;
  }
  if (n_tokens < 0) {
    err = MG_ERR_EMBED;
    goto done;
  }
  if (n_tokens == 0) {
    err = MG_ERR_INVALID_ARG;
    goto done;
  }

  batch = llama_batch_get_one(tokens, n_tokens);
  if (llama_model_has_encoder(model)) {
    if (llama_encode(inst->ctx, batch) != 0) {
      err = MG_ERR_EMBED;
      goto done;
    }
  } else if (llama_decode(inst->ctx, batch) != 0) {
    err = MG_ERR_EMBED;
    goto done;
  }

  embedding = llama_get_embeddings_seq(inst->ctx, 0);
  if (!embedding) {
    err = MG_ERR_EMBED;
    goto done;
  }

  err = mg_normalize(embedding, MG_EMBEDDING_DIM, out);

done:
  if (mg_mutex_unlock(&inst->lock) != 0 && err == MG_OK) {
    err = MG_ERR_INTERNAL;
  }
  free(tokens);
  return err;
}

/* Round-robin over the instance pool. Each instance owns its llama context
 * and lock, so concurrent callers embed in parallel. */
mg_err_t mg_embed_text(mg_embed_ctx_t *ctx, const char *text, mg_embedding_t out) {
  if (!ctx || !ctx->inst || !text || !out || ctx->n_inst <= 0) {
    return MG_ERR_INVALID_ARG;
  }
  unsigned idx = atomic_fetch_add_explicit(&ctx->pick, 1u, memory_order_relaxed);
  struct mg_embed_instance *it = &ctx->inst[idx % (unsigned)ctx->n_inst];
  return embed_instance_text(it, ctx->model, text, out);
}

float mg_cosine(const mg_embedding_t a, const mg_embedding_t b) {
  float sum = 0.0f;

  if (!a || !b) {
    return 0.0f;
  }

  for (int i = 0; i < MG_EMBEDDING_DIM; i++) {
    sum += a[i] * b[i];
  }

  return sum;
}
