#ifndef GRAFT_VERIFY_INTERNAL_H
#define GRAFT_VERIFY_INTERNAL_H

#include "graft/verify.h"

#include <stdbool.h>
#include <stdint.h>

#if defined(_WIN32) && !defined(__MINGW32__) && !defined(__MINGW64__)
#include <windows.h>
typedef SRWLOCK mg_ce_mutex_t;
#else
#include <pthread.h>
typedef pthread_mutex_t mg_ce_mutex_t;
#endif

struct llama_model;
struct llama_context;

typedef struct {
  struct llama_model   *model;
  struct llama_context *ctx;
  mg_ce_mutex_t         lock;
  int                   backend_acquired;
  int                   lock_initialized;
  int                   n_ctx;
  uint32_t              n_cls_out;
  int                   positive_index;
  char                 *rerank_template;
} mg_ce_runtime_t;

struct mg_verify_ctx {
  mg_config_t cfg;
  bool ce_runtime_enabled;
  mg_ce_runtime_t ce;
};

int  mg_ce_try_enable(mg_verify_ctx_t *ctx);
int  mg_ce_score_pair(mg_verify_ctx_t *ctx, const char *query, const char *candidate, float *out);
/* Score the same pair through the CE but using an entailment-flavored prompt
 * template (cfg.nli_prompt_template). The model is identical — the score is
 * "relevance under a different framing". Returns 0 on success, -1 otherwise. */
int  mg_ce_score_nli(mg_verify_ctx_t *ctx, const char *query, const char *candidate, float *out);
void mg_ce_shutdown(mg_verify_ctx_t *ctx);

#endif
