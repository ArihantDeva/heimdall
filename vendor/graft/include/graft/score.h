#ifndef GRAFT_SCORE_H
#define GRAFT_SCORE_H

#include <math.h>

/* Weighted fusion shared by the rerank module and the verify fused-gate mode.
 *
 * Inputs are assumed already clamped/bounded [0,1] for non-NaN values. Each
 * signal contributes only when it is non-NaN AND its weight is strictly
 * positive; in that case the signal AND the weight are added to numerator and
 * denominator respectively, so the result stays a true weighted average over
 * the available signals.
 *
 * Returns NaN when no signal contributes (every signal is NaN or every weight
 * is zero). Callers must treat NaN as "no fused score available" and decide
 * how to fall back (e.g. legacy boolean gate, or MG_HIT_NONE). */
static inline float mg_score_fuse(float s_vec, float s_lex,
                                  float s_ce,  float s_nli,
                                  float w_vec, float w_lex,
                                  float w_ce,  float w_nli) {
    float fused = 0.0f, w_sum = 0.0f;
    if (!isnan(s_vec) && w_vec > 0.0f) { fused += w_vec * s_vec; w_sum += w_vec; }
    if (!isnan(s_lex) && w_lex > 0.0f) { fused += w_lex * s_lex; w_sum += w_lex; }
    if (!isnan(s_ce)  && w_ce  > 0.0f) { fused += w_ce  * s_ce ; w_sum += w_ce ; }
    if (!isnan(s_nli) && w_nli > 0.0f) { fused += w_nli * s_nli; w_sum += w_nli; }
    return w_sum > 0.0f ? fused / w_sum : NAN;
}

#endif
