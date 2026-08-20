#ifndef MG_RERANK_INTERNAL_H
#define MG_RERANK_INTERNAL_H

#include "graft/rerank.h"
#include "graft/config.h"

#include <stdbool.h>

/* Rerank context layout. The struct is opaque to callers; only this TU and
 * the public init/shutdown/enabled/batch entry points touch its fields.
 *
 * NOTE: mg_rerank_batch performs CE forward passes sequentially. True
 * multi-pair batch decoding (multiple llama batches packed together) is a
 * future optimization — the call loop in mg_rerank_batch IS the hotspot. */
struct mg_rerank_ctx {
    mg_config_t cfg;          /* shallow copy of the relevant scalars only */
    struct mg_verify_ctx *verify_ctx_for_ce;  /* borrowed, NOT owned */
    bool enabled;
};

#endif
