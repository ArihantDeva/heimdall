#ifndef GRAFT_EMBED_H
#define GRAFT_EMBED_H

#include <stdbool.h>

#include "graft/types.h"
#include "graft/error.h"

typedef struct mg_embed_ctx mg_embed_ctx_t;

/* If hardware_accel is true, all model layers are offloaded to GPU (CUDA on
 * NVIDIA, HIP on ROCm 6/7). Requires llama.cpp to have been built with the
 * matching backend; otherwise init returns MG_ERR_CONFIG with a clear log. */
mg_err_t mg_embed_init(const char *model_path, int threads, int ctx_size,
                       bool hardware_accel, int instances, mg_embed_ctx_t **out);
void     mg_embed_shutdown(mg_embed_ctx_t *ctx);

/* Calcola embedding di testo. out e' L2-normalized. Thread-safe. */
mg_err_t mg_embed_text(mg_embed_ctx_t *ctx, const char *text, mg_embedding_t out);

/* Cosine similarity tra due vettori L2-normalized = dot product */
float mg_cosine(const mg_embedding_t a, const mg_embedding_t b);

#endif
