/* Bounded CE-primary scoring shared by score_candidates and native retrieve.
 * The legacy weighted mg_rerank_batch API is deliberately separate. */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "internal.h"
#include "graft/candidate_scorer.h"
#include "graft/verify_internal.h"

#include <math.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#endif

/* Only the deterministic unit fixture defines this seam. Production always
 * uses a monotonic OS clock; no wall clock or caller-controlled clock. */
#ifdef MG_CANDIDATE_TEST_CLOCK
extern int mg_candidate_test_now_ms(uint64_t *out);
#endif
static int now_ms(uint64_t *out) {
#ifdef MG_CANDIDATE_TEST_CLOCK
    return mg_candidate_test_now_ms(out);
#elif defined(_WIN32)
    *out = (uint64_t)GetTickCount64();
    return 0;
#else
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return -1;
    *out = (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
    return 0;
#endif
}

static size_t bounded_len(const char *s, size_t max) {
    size_t n = 0;
    if (!s) return 0;
    while (n <= max && s[n]) ++n;
    return n;
}

static bool whitespace(uint32_t c) {
    return (c >= 9u && c <= 13u) || (c >= 0x1cu && c <= 0x20u) ||
           c == 0x85u || c == 0xa0u || c == 0x1680u ||
           (c >= 0x2000u && c <= 0x200au) || c == 0x2028u ||
           c == 0x2029u || c == 0x202fu || c == 0x205fu || c == 0x3000u;
}

bool mg_candidate_text_valid(const char *text, size_t bytes, bool nonblank) {
    size_t i = 0;
    bool has_text = false;
    if (!text) return false;
    while (i < bytes) {
        uint32_t c = (unsigned char)text[i++];
        uint32_t min = 0;
        unsigned more = 0;
        if (c == 0) return false;
        if (c < 0x80u) { /* ASCII */ }
        else if (c >= 0xc2u && c <= 0xdfu) { c &= 0x1fu; more = 1; min = 0x80u; }
        else if (c >= 0xe0u && c <= 0xefu) { c &= 0x0fu; more = 2; min = 0x800u; }
        else if (c >= 0xf0u && c <= 0xf4u) { c &= 7u; more = 3; min = 0x10000u; }
        else return false;
        if (bytes - i < more) return false;
        for (unsigned j = 0; j < more; ++j) {
            unsigned char b = (unsigned char)text[i++];
            if ((b & 0xc0u) != 0x80u) return false;
            c = (c << 6) | (uint32_t)(b & 0x3fu);
        }
        if (c < min || c > 0x10ffffu || (c >= 0xd800u && c <= 0xdfffu)) return false;
        if (!whitespace(c)) has_text = true;
    }
    return !nonblank || has_text;
}

const char *mg_candidate_status_name(mg_candidate_status_t status) {
    switch (status) {
        case MG_CANDIDATE_APPLIED:     return "applied";
        case MG_CANDIDATE_DISABLED:    return "disabled";
        case MG_CANDIDATE_UNAVAILABLE: return "unavailable";
        case MG_CANDIDATE_FAILED:      return "failed";
        case MG_CANDIDATE_DEADLINE:    return "deadline";
        case MG_CANDIDATE_EMPTY:       return "empty";
    }
    return "failed";
}

const char *mg_candidate_ce_status_name(mg_candidate_ce_status_t status) {
    switch (status) {
        case MG_CE_OK:         return "ok";
        case MG_CE_DISABLED:   return "disabled";
        case MG_CE_UNAVAILABLE:return "unavailable";
        case MG_CE_FAILED:     return "failed";
        case MG_CE_DEADLINE:   return "deadline";
        case MG_CE_NOT_SCORED: return "not_scored";
    }
    return "failed";
}

static void unavailable(mg_candidate_batch_t *out, mg_candidate_status_t status,
                         mg_candidate_ce_status_t ce_status, const char *reason) {
    out->status = status;
    out->reason = reason;
    for (size_t i = 0; i < out->candidate_count; ++i)
        out->results[i].ce_status = ce_status;
}

mg_err_t mg_candidate_score(mg_rerank_ctx_t *r, const char *query,
                            const mg_candidate_input_t *inputs, size_t count,
                            int budget_ms, mg_candidate_batch_t *out) {
    if (!out || !query || (count && !inputs) || count > MG_CANDIDATE_MAX_COUNT ||
        budget_ms < 1 || budget_ms > MG_CANDIDATE_MAX_BUDGET_MS)
        return MG_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));
    out->status = MG_CANDIDATE_FAILED;
    out->reason = "invalid_input";
    out->candidate_count = count;

    size_t qlen = bounded_len(query, MG_CANDIDATE_MAX_QUERY_BYTES);
    if (qlen > MG_CANDIDATE_MAX_QUERY_BYTES || !mg_candidate_text_valid(query, qlen, true))
        return MG_ERR_INVALID_ARG;

    /* Validate the entire frozen window BEFORE any inference. In particular,
     * never replace a too-large document with a silently truncated prefix. */
    for (size_t i = 0; i < count; ++i) {
        const mg_candidate_input_t *in = &inputs[i];
        size_t idlen = bounded_len(in->id, MG_CANDIDATE_MAX_ID_BYTES);
        size_t tlen = bounded_len(in->title, MG_CANDIDATE_MAX_TITLE_BYTES);
        size_t dlen = bounded_len(in->document, MG_CANDIDATE_MAX_DOCUMENT_BYTES);
        if (!in->id || !idlen || idlen > MG_CANDIDATE_MAX_ID_BYTES ||
            !mg_candidate_text_valid(in->id, idlen, false) ||
            tlen > MG_CANDIDATE_MAX_TITLE_BYTES || dlen > MG_CANDIDATE_MAX_DOCUMENT_BYTES ||
            (in->title && !mg_candidate_text_valid(in->title, tlen, false)) ||
            (in->document && !mg_candidate_text_valid(in->document, dlen, false)) ||
            (in->has_s_vec && !isfinite(in->s_vec)))
            return MG_ERR_INVALID_ARG;
        for (size_t j = 0; j < i; ++j)
            if (strcmp(in->id, inputs[j].id) == 0) return MG_ERR_INVALID_ARG;
        mg_candidate_result_t *res = &out->results[i];
        res->original_rank = res->rank = (int)i + 1;
        res->s_vec = in->s_vec;
        res->has_s_vec = in->has_s_vec;
        res->document_bytes = dlen;
        res->ce_status = MG_CE_NOT_SCORED;
    }
    if (!count) {
        out->status = MG_CANDIDATE_EMPTY;
        out->reason = "no_candidates";
        return MG_OK;
    }

    uint64_t start = 0;
    bool clock_ok = now_ms(&start) == 0;
    for (size_t i = 0; i < count; ++i) {
        if (inputs[i].title) {
            float lex = NAN;
            bool lex_ok = mg_text_trigram_jaccard_checked(query, inputs[i].title, &lex) == MG_OK;
            out->results[i].has_s_lex = lex_ok && isfinite(lex);
            out->results[i].s_lex = lex;
        }
    }

    if (!mg_rerank_enabled(r) || !r->cfg.rerank_enabled) {
        unavailable(out, MG_CANDIDATE_DISABLED, MG_CE_DISABLED, "rerank_disabled");
        return MG_OK;
    }
    if (r->cfg.rerank_top_k <= 0) {
        unavailable(out, MG_CANDIDATE_DISABLED, MG_CE_DISABLED, "window_disabled");
        return MG_OK;
    }
    if (!r->cfg.cross_encoder_enabled ||
        (r->verify_ctx_for_ce && !r->verify_ctx_for_ce->cfg.cross_encoder_enabled)) {
        unavailable(out, MG_CANDIDATE_DISABLED, MG_CE_DISABLED, "cross_encoder_disabled");
        return MG_OK;
    }
    if (!isfinite(r->cfg.rerank_w_ce) || r->cfg.rerank_w_ce <= 0.0f) {
        unavailable(out, MG_CANDIDATE_DISABLED, MG_CE_DISABLED, "ce_weight_disabled");
        return MG_OK;
    }
    if (r->cfg.hardware_accel ||
        (r->verify_ctx_for_ce && r->verify_ctx_for_ce->cfg.hardware_accel)) {
        unavailable(out, MG_CANDIDATE_UNAVAILABLE, MG_CE_UNAVAILABLE, "cpu_required");
        return MG_OK;
    }
    if (!r->verify_ctx_for_ce || !r->verify_ctx_for_ce->ce_runtime_enabled) {
        unavailable(out, MG_CANDIDATE_UNAVAILABLE, MG_CE_UNAVAILABLE, "ce_runtime_unavailable");
        return MG_OK;
    }
    if (!clock_ok) {
        unavailable(out, MG_CANDIDATE_FAILED, MG_CE_FAILED, "clock_unavailable");
        return MG_OK;
    }
    const uint64_t deadline = start > UINT64_MAX - (uint64_t)budget_ms
                              ? UINT64_MAX : start + (uint64_t)budget_ms;
    bool failed = false;
    const char *failure_reason = "ce_failed";
    for (size_t i = 0; i < count; ++i) {
        uint64_t now = 0;
        if (now_ms(&now) != 0) {
            out->status = MG_CANDIDATE_FAILED;
            out->reason = "clock_unavailable";
            for (size_t j = i; j < count; ++j) out->results[j].ce_status = MG_CE_FAILED;
            return MG_OK;
        }
        if (now >= deadline) {
            out->status = MG_CANDIDATE_DEADLINE;
            out->reason = "budget_exhausted";
            for (size_t j = i; j < count; ++j) out->results[j].ce_status = MG_CE_DEADLINE;
            return MG_OK;
        }
        mg_candidate_result_t *res = &out->results[i];
        float ce = NAN;
        if (!inputs[i].document) {
            res->ce_status = MG_CE_FAILED;
            failed = true;
            failure_reason = "document_unavailable";
        } else if (mg_ce_score_pair(r->verify_ctx_for_ce, query, inputs[i].document, &ce) != 0) {
            res->ce_status = MG_CE_FAILED;
            failed = true;
        } else if (!isfinite(ce) || ce < 0.0f || ce > 1.0f) {
            res->ce_status = MG_CE_FAILED;
            failed = true;
            failure_reason = "ce_invalid_score";
        } else {
            res->s_ce = ce;
            res->has_s_ce = true;
            res->ce_status = MG_CE_OK;
            out->scored_count++;
        }
    }
    /* Include an overrun on the LAST pair, too. Successfully observed scores
     * remain diagnostic evidence, but a late batch is not applied. */
    uint64_t finish = 0;
    if (now_ms(&finish) != 0) {
        out->status = MG_CANDIDATE_FAILED;
        out->reason = "clock_unavailable";
        return MG_OK;
    }
    if (finish >= deadline) {
        out->status = MG_CANDIDATE_DEADLINE;
        out->reason = "budget_exhausted";
        return MG_OK;
    }
    if (failed) {
        out->status = MG_CANDIDATE_FAILED;
        out->reason = failure_reason;
        return MG_OK;
    }

    /* Stable insertion sort of INDICES. Evidence stays in input/identity order.
     * Ties keep original ranks; neither cosine nor RRF breaks a CE tie. */
    size_t order[MG_CANDIDATE_MAX_COUNT];
    for (size_t i = 0; i < count; ++i) {
        size_t j = i;
        while (j && out->results[i].s_ce > out->results[order[j - 1]].s_ce) {
            order[j] = order[j - 1];
            --j;
        }
        order[j] = i;
    }
    for (size_t i = 0; i < count; ++i) out->results[order[i]].rank = (int)i + 1;
    out->status = MG_CANDIDATE_APPLIED;
    out->reason = "all_scored";
    out->applied = true;
    return MG_OK;
}
