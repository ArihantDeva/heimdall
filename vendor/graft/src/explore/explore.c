/* mg_op_explore — keyword-conditioned beam search over the memory graph.
 *
 * Algorithm:
 *  1. Embed query text -> q.
 *  2. Resolve `keywords` arg into a set of keyword_ids via upsert
 *     (orphan keywords are acceptable for MVP).
 *  3. Seed: vector_topk(q, 2*beam_width). If a keyword filter is provided,
 *     drop seeds whose KEYWORD-edges share no keyword with it.
 *  4. Initialize beams from accepted seeds (path = [seed],
 *     score = log(normalized cosine)).
 *  5. For step in 1..depth:
 *       - For each beam, expand via mg_storage_neighbors(.., kw_filter):
 *           skip dst already in path
 *           sem_score = clamp((cosine(q, dst_emb) + 1) * 0.5, eps, 1)
 *           edge_score = clamp(edge.weight, eps, 1)
 *           base = beam.score + log(edge_score) + alpha*log(sem_score)
 *                  - depth_penalty * step
 *           mmr    = max cosine(dst_emb, m_emb) for m in beam.path
 *           score' = base - mmr_lambda * redundancy
 *       - Greedy MMR beam selection across all candidates until beam_width.
 *  6. Output:
 *       nodes = visited nodes (best score per id), top target_count by score
 *       edges = all traversed edges (deduped by src,dst,kind,keyword_id)
 *
 * Result map (single mpack VALUE at writer position):
 *   {
 *     "nodes": [ { id_hex, title, score, depth_reached } , ... ],
 *     "edges": [ { src_hex, dst_hex, kind, weight }       , ... ]
 *   }
 */

#include "graft/ops.h"
#include "graft/storage.h"
#include "graft/embed.h"
#include "graft/config.h"
#include "graft/types.h"
#include "graft/error.h"
#include "mpack.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#define MG_EXPLORE_MAX_DEPTH       8
#define MG_EXPLORE_MAX_BEAM        32
#define MG_EXPLORE_MAX_KW_FILTER   16
#define MG_EXPLORE_MAX_SEEDS       64
#define MG_EXPLORE_MAX_NEIGHBORS   64
#define MG_EXPLORE_MAX_VISITED     256
#define MG_EXPLORE_MAX_EDGES       512
#define MG_EXPLORE_MAX_CANDIDATES  256
#define MG_EXPLORE_EMBED_CACHE     256
#define MG_EXPLORE_PATH_CAP        (MG_EXPLORE_MAX_DEPTH + 1)
#define MG_EXPLORE_DEFAULT_TARGET  12
#define MG_EXPLORE_LOG_EPS         1e-6

/* ---------------- types ---------------- */

typedef struct {
    mg_node_id_t path[MG_EXPLORE_PATH_CAP];
    int          path_len;
    float        score;
    int          depth;
} mg_beam_t;

typedef struct {
    mg_node_id_t   id;
    mg_embedding_t emb;
    bool           valid;
} mg_emb_entry_t;

typedef struct {
    mg_emb_entry_t *e;
    int n;
    int cap;
} mg_emb_cache_t;

typedef struct {
    mg_node_id_t id;
    float        score;
    int          depth_reached;
} mg_visited_t;

typedef struct {
    mg_node_id_t    src;
    mg_node_id_t    dst;
    mg_edge_kind_t  kind;
    mg_keyword_id_t keyword_id;
    float           weight;
} mg_trav_edge_t;

/* ---------------- small helpers ---------------- */

static void hex_encode(const uint8_t *bytes, size_t len, char *out) {
    static const char d[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2 * i]     = d[(bytes[i] >> 4) & 0xF];
        out[2 * i + 1] = d[ bytes[i]       & 0xF];
    }
    out[2 * len] = '\0';
}

static int read_optional_int(mpack_node_t map, const char *key, int dflt) {
    mpack_node_t n = mpack_node_map_cstr_optional(map, key);
    if (mpack_node_is_missing(n) || mpack_node_is_nil(n)) return dflt;
    return (int)mpack_node_int(n);
}

static float clamp_float(float x, float lo, float hi) {
    if (!isfinite(x)) return lo;
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
}

static float explore_semantic_score(float cosine) {
    return clamp_float((cosine + 1.0f) * 0.5f,
                       (float)MG_EXPLORE_LOG_EPS, 1.0f);
}

static float explore_edge_score(float weight) {
    return clamp_float(weight, (float)MG_EXPLORE_LOG_EPS, 1.0f);
}

static float explore_redundancy_score(float cosine) {
    return clamp_float(cosine, 0.0f, 1.0f);
}

static float explore_depth_penalty(float decay_gamma) {
    float gamma = clamp_float(decay_gamma, (float)MG_EXPLORE_LOG_EPS, 1.0f);
    return (float)-log((double)gamma);
}

/* ---------------- embedding cache (linear, O(n)) ---------------- */

static mg_err_t cache_lookup(mg_emb_cache_t *c, mg_storage_t *s,
                             const mg_node_id_t id,
                             const float **out_ptr) {
    for (int i = 0; i < c->n; i++) {
        if (c->e[i].valid &&
            memcmp(c->e[i].id, id, MG_NODE_ID_BYTES) == 0) {
            *out_ptr = c->e[i].emb;
            return MG_OK;
        }
    }
    int slot;
    if (c->n < c->cap) {
        slot = c->n++;
    } else {
        /* Simple eviction: reuse the last slot. */
        slot = c->cap - 1;
    }
    mg_err_t e = mg_storage_get_embedding(s, id, c->e[slot].emb);
    if (e != MG_OK) {
        c->e[slot].valid = false;
        return e;
    }
    memcpy(c->e[slot].id, id, MG_NODE_ID_BYTES);
    c->e[slot].valid = true;
    *out_ptr = c->e[slot].emb;
    return MG_OK;
}

/* ---------------- visited / edges accumulators ---------------- */

static void visited_upsert(mg_visited_t *arr, int *n, int max,
                           const mg_node_id_t id, float score, int depth) {
    for (int i = 0; i < *n; i++) {
        if (memcmp(arr[i].id, id, MG_NODE_ID_BYTES) == 0) {
            if (score > arr[i].score) {
                arr[i].score = score;
                arr[i].depth_reached = depth;
            }
            return;
        }
    }
    if (*n >= max) return;
    memcpy(arr[*n].id, id, MG_NODE_ID_BYTES);
    arr[*n].score = score;
    arr[*n].depth_reached = depth;
    (*n)++;
}

static int cmp_visited_desc(const void *a, const void *b) {
    const mg_visited_t *va = (const mg_visited_t *)a;
    const mg_visited_t *vb = (const mg_visited_t *)b;
    if (va->score > vb->score) return -1;
    if (va->score < vb->score) return  1;
    return 0;
}

static void edge_add_unique(mg_trav_edge_t *arr, int *n, int max,
                            const mg_trav_edge_t *e) {
    for (int i = 0; i < *n; i++) {
        if (arr[i].kind == e->kind &&
            arr[i].keyword_id == e->keyword_id &&
            memcmp(arr[i].src, e->src, MG_NODE_ID_BYTES) == 0 &&
            memcmp(arr[i].dst, e->dst, MG_NODE_ID_BYTES) == 0) {
            return;
        }
    }
    if (*n >= max) return;
    arr[(*n)++] = *e;
}

/* True if seed shares at least one keyword with the filter set. */
static bool seed_matches_kw_filter(mg_storage_t *s,
                                   const mg_node_id_t seed,
                                   const mg_keyword_id_t *filter,
                                   size_t n_filter) {
    if (n_filter == 0) return true;
    mg_edge_t buf[MG_EXPLORE_MAX_NEIGHBORS];
    int n = 0;
    if (mg_storage_neighbors(s, seed, MG_EDGE_KEYWORD, NULL, 0,
                              buf, MG_EXPLORE_MAX_NEIGHBORS, &n) != MG_OK)
        return false;
    for (int i = 0; i < n; i++) {
        for (size_t k = 0; k < n_filter; k++) {
            if (buf[i].keyword_id == filter[k]) return true;
        }
    }
    return false;
}

/* ---------------- main handler ---------------- */

mg_err_t mg_op_explore(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
    if (!ctx || !ctx->storage || !ctx->embed || !ctx->config || !result)
        return MG_ERR_INVALID_ARG;

    mg_storage_t       *s   = ctx->storage;
    const mg_config_t  *cfg = ctx->config;

    /* ---- args ---- */
    char *text = mpack_node_cstr_alloc(mpack_node_map_cstr(args, "text"),
                                        1u << 20);
    if (!text) return MG_ERR_INVALID_ARG;

    int depth        = read_optional_int(args, "depth",
                                         cfg->explore_default_depth);
    int beam_width   = read_optional_int(args, "beam_width",
                                         cfg->explore_default_beam);
    int target_count = read_optional_int(args, "target_count",
                                         MG_EXPLORE_DEFAULT_TARGET);

    if (depth < 0)                        depth = 0;
    if (depth > MG_EXPLORE_MAX_DEPTH)     depth = MG_EXPLORE_MAX_DEPTH;
    if (beam_width <= 0)                  beam_width = 1;
    if (beam_width > MG_EXPLORE_MAX_BEAM) beam_width = MG_EXPLORE_MAX_BEAM;
    if (target_count <= 0) target_count = MG_EXPLORE_DEFAULT_TARGET;
    if (target_count > MG_EXPLORE_MAX_VISITED)
        target_count = MG_EXPLORE_MAX_VISITED;

    /* ---- keyword filter ---- */
    mg_keyword_id_t kw_filter[MG_EXPLORE_MAX_KW_FILTER];
    size_t          n_kw_filter = 0;

    mpack_node_t kws_node = mpack_node_map_cstr_optional(args, "keywords");
    if (!mpack_node_is_missing(kws_node) && !mpack_node_is_nil(kws_node)) {
        if (mpack_node_type(kws_node) != mpack_type_array) {
            free(text);
            return MG_ERR_INVALID_ARG;
        }
        size_t arr_n = mpack_node_array_length(kws_node);
        for (size_t i = 0;
             i < arr_n && n_kw_filter < MG_EXPLORE_MAX_KW_FILTER; i++) {
            char *kw = mpack_node_cstr_alloc(
                          mpack_node_array_at(kws_node, i), 1024);
            if (!kw) continue;
            mg_keyword_id_t id = 0;
            if (mg_storage_upsert_keyword(s, kw, NULL, &id) == MG_OK && id > 0) {
                kw_filter[n_kw_filter++] = id;
            }
            free(kw);
        }
    }

    /* ---- embed query ---- */
    mg_embedding_t q;
    mg_err_t e = mg_embed_text(ctx->embed, text, q);
    free(text);
    if (e != MG_OK) return e;

    /* ---- heap allocations ---- */
    mg_emb_entry_t *cache_buf = (mg_emb_entry_t *)
        calloc(MG_EXPLORE_EMBED_CACHE, sizeof(*cache_buf));
    mg_visited_t   *visited   = (mg_visited_t *)
        calloc(MG_EXPLORE_MAX_VISITED, sizeof(*visited));
    mg_trav_edge_t *trav      = (mg_trav_edge_t *)
        calloc(MG_EXPLORE_MAX_EDGES, sizeof(*trav));
    mg_beam_t      *cands     = (mg_beam_t *)
        calloc(MG_EXPLORE_MAX_CANDIDATES, sizeof(*cands));
    mg_trav_edge_t *cand_edges = (mg_trav_edge_t *)
        calloc(MG_EXPLORE_MAX_CANDIDATES, sizeof(*cand_edges));

    if (!cache_buf || !visited || !trav || !cands || !cand_edges) {
        free(cache_buf); free(visited); free(trav);
        free(cands);     free(cand_edges);
        return MG_ERR_OOM;
    }

    mg_emb_cache_t cache = { .e = cache_buf,
                             .n = 0,
                             .cap = MG_EXPLORE_EMBED_CACHE };
    const float depth_penalty = explore_depth_penalty(cfg->explore_decay_gamma);

    int n_visited = 0;
    int n_trav    = 0;

    /* ---- seeds ---- */
    int n_seed_request = 2 * beam_width;
    if (n_seed_request > MG_EXPLORE_MAX_SEEDS)
        n_seed_request = MG_EXPLORE_MAX_SEEDS;

    mg_node_score_t seeds[MG_EXPLORE_MAX_SEEDS];
    int n_seeds = 0;
    if (mg_storage_vector_topk(s, q, n_seed_request, seeds, &n_seeds) != MG_OK)
        n_seeds = 0;

    mg_beam_t  beams_buf[MG_EXPLORE_MAX_BEAM];
    mg_beam_t *beams = beams_buf;
    int n_beams = 0;

    for (int i = 0; i < n_seeds && n_beams < beam_width; i++) {
        if (!seed_matches_kw_filter(s, seeds[i].id, kw_filter, n_kw_filter))
            continue;
        memcpy(beams[n_beams].path[0], seeds[i].id, MG_NODE_ID_BYTES);
        beams[n_beams].path_len = 1;
        beams[n_beams].score    = (float)log((double)explore_semantic_score(seeds[i].score));
        beams[n_beams].depth    = 0;
        visited_upsert(visited, &n_visited, MG_EXPLORE_MAX_VISITED,
                       seeds[i].id, beams[n_beams].score, 0);
        const float *unused = NULL;
        (void)cache_lookup(&cache, s, seeds[i].id, &unused);
        n_beams++;
    }

    /* ---- step loop ---- */
    bool used[MG_EXPLORE_MAX_CANDIDATES];

    for (int step = 1; step <= depth && n_beams > 0; step++) {
        int n_cands = 0;

        for (int b = 0; b < n_beams; b++) {
            mg_beam_t *beam = &beams[b];
            const uint8_t *last = beam->path[beam->path_len - 1];

            mg_edge_t neigh[MG_EXPLORE_MAX_NEIGHBORS];
            int n_neigh = 0;
            if (mg_storage_neighbors(s, last, /*kind*/ -1,
                                      n_kw_filter ? kw_filter : NULL,
                                      n_kw_filter,
                                      neigh, MG_EXPLORE_MAX_NEIGHBORS,
                                      &n_neigh) != MG_OK)
                continue;

            for (int j = 0; j < n_neigh; j++) {
                if (n_cands >= MG_EXPLORE_MAX_CANDIDATES) break;
                if (beam->path_len >= MG_EXPLORE_PATH_CAP) break;

                const mg_edge_t *edge = &neigh[j];

                /* skip cycles within this beam's path */
                bool in_path = false;
                for (int p = 0; p < beam->path_len; p++) {
                    if (memcmp(beam->path[p], edge->dst,
                               MG_NODE_ID_BYTES) == 0) {
                        in_path = true; break;
                    }
                }
                if (in_path) continue;

                const float *dst_emb = NULL;
                if (cache_lookup(&cache, s, edge->dst, &dst_emb) != MG_OK)
                    continue;

                float sem_score = explore_semantic_score(mg_cosine(q, dst_emb));
                float edge_score = explore_edge_score(edge->weight);

                double base =
                    (double)beam->score
                  + log((double)edge_score)
                  + (double)cfg->explore_alpha * log((double)sem_score)
                  - (double)depth_penalty * (double)step;

                /* MMR penalty against current beam path tips. */
                float mmr_pen = 0.0f;
                for (int p = 0; p < beam->path_len; p++) {
                    const float *pe = NULL;
                    if (cache_lookup(&cache, s, beam->path[p], &pe) != MG_OK)
                        continue;
                    float c = explore_redundancy_score(mg_cosine(dst_emb, pe));
                    if (c > mmr_pen) mmr_pen = c;
                }

                double final_score = base -
                    (double)cfg->mmr_lambda * (double)mmr_pen;

                /* push candidate */
                mg_beam_t *nb = &cands[n_cands];
                memcpy(nb->path, beam->path,
                       sizeof(mg_node_id_t) * (size_t)beam->path_len);
                memcpy(nb->path[beam->path_len], edge->dst, MG_NODE_ID_BYTES);
                nb->path_len = beam->path_len + 1;
                nb->score    = (float)final_score;
                nb->depth    = step;

                memcpy(cand_edges[n_cands].src, last, MG_NODE_ID_BYTES);
                memcpy(cand_edges[n_cands].dst, edge->dst, MG_NODE_ID_BYTES);
                cand_edges[n_cands].kind       = edge->kind;
                cand_edges[n_cands].keyword_id = edge->keyword_id;
                cand_edges[n_cands].weight     = edge->weight;

                n_cands++;
            }
        }

        if (n_cands == 0) break;

        /* ---- greedy MMR beam selection ---- */
        memset(used, 0, sizeof(used));

        mg_beam_t new_beams[MG_EXPLORE_MAX_BEAM];
        int n_new = 0;

        while (n_new < beam_width) {
            int   best_i = -1;
            float best_a = -INFINITY;

            for (int i = 0; i < n_cands; i++) {
                if (used[i]) continue;
                const float *ie = NULL;
                if (cache_lookup(&cache, s,
                                  cands[i].path[cands[i].path_len - 1],
                                  &ie) != MG_OK)
                    continue;

                float pen = 0.0f;
                for (int j = 0; j < n_new; j++) {
                    const float *je = NULL;
                    if (cache_lookup(&cache, s,
                                      new_beams[j].path[new_beams[j].path_len - 1],
                                      &je) != MG_OK)
                        continue;
                    float c = explore_redundancy_score(mg_cosine(ie, je));
                    if (c > pen) pen = c;
                }
                float adj = cands[i].score - cfg->mmr_lambda * pen;
                if (adj > best_a) {
                    best_a = adj;
                    best_i = i;
                }
            }
            if (best_i < 0) break;

            used[best_i] = true;
            new_beams[n_new] = cands[best_i];

            edge_add_unique(trav, &n_trav, MG_EXPLORE_MAX_EDGES,
                            &cand_edges[best_i]);

            const uint8_t *tip = new_beams[n_new]
                                 .path[new_beams[n_new].path_len - 1];
            visited_upsert(visited, &n_visited, MG_EXPLORE_MAX_VISITED,
                           tip, new_beams[n_new].score, step);

            n_new++;
        }

        if (n_new == 0) break;
        memcpy(beams, new_beams, sizeof(mg_beam_t) * (size_t)n_new);
        n_beams = n_new;
    }

    /* ---- output ---- */
    qsort(visited, (size_t)n_visited, sizeof(*visited), cmp_visited_desc);
    int n_emit = n_visited < target_count ? n_visited : target_count;

    mpack_build_map(result);

    mpack_write_cstr(result, "nodes");
    mpack_build_array(result);
    for (int i = 0; i < n_emit; i++) {
        mg_node_t node = {0};
        if (mg_storage_get_node(s, visited[i].id, &node) != MG_OK) continue;

        char hex[2 * MG_NODE_ID_BYTES + 1];
        hex_encode(visited[i].id, MG_NODE_ID_BYTES, hex);

        /* Recompute cosine(q, node) so the client gets a bounded [-1, 1]
         * similarity score. The `score` field is the log-additive beam
         * composite — useful for ranking, useless as a percentage. */
        mg_embedding_t emb;
        float cos_to_q = 0.0f;
        if (mg_storage_get_embedding(s, visited[i].id, emb) == MG_OK) {
            cos_to_q = mg_cosine(q, emb);
        }

        mpack_build_map(result);
        mpack_write_cstr(result, "id_hex");
        mpack_write_cstr(result, hex);
        mpack_write_cstr(result, "title");
        mpack_write_cstr(result, node.title ? node.title : "");
        mpack_write_cstr(result, "score");
        mpack_write_float(result, visited[i].score);
        mpack_write_cstr(result, "cosine");
        mpack_write_float(result, cos_to_q);
        mpack_write_cstr(result, "depth_reached");
        mpack_write_int(result, visited[i].depth_reached);
        mpack_complete_map(result);

        mg_node_free(&node);
    }
    mpack_complete_array(result);

    mpack_write_cstr(result, "edges");
    mpack_build_array(result);
    for (int i = 0; i < n_trav; i++) {
        char src_hex[2 * MG_NODE_ID_BYTES + 1];
        char dst_hex[2 * MG_NODE_ID_BYTES + 1];
        hex_encode(trav[i].src, MG_NODE_ID_BYTES, src_hex);
        hex_encode(trav[i].dst, MG_NODE_ID_BYTES, dst_hex);

        mpack_build_map(result);
        mpack_write_cstr(result, "src_hex");
        mpack_write_cstr(result, src_hex);
        mpack_write_cstr(result, "dst_hex");
        mpack_write_cstr(result, dst_hex);
        mpack_write_cstr(result, "kind");
        mpack_write_int(result, (int)trav[i].kind);
        mpack_write_cstr(result, "weight");
        mpack_write_float(result, trav[i].weight);
        mpack_complete_map(result);
    }
    mpack_complete_array(result);

    mpack_complete_map(result);

    free(cache_buf);
    free(visited);
    free(trav);
    free(cands);
    free(cand_edges);
    return MG_OK;
}
