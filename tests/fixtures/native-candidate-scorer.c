/* UNIT fixture only: fixed opaque IDs and mock CE values, no corpus/labels.
 * Links the ACTUAL handler/core/retrieve/dispatch/wire and vendored MPack.
 * Storage, embedding, CE and unused dispatch operations are strict stub seams.
 * No llama/sqlite/yaml dependency, model loads, filesystem index or live socket.
 */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#include "graft/candidate_scorer.h"
#include "graft/ops.h"
#include "graft/verify_internal.h"
#include "graft/wire.h"

#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define CHECK(c) do { if (!(c)) { \
    fprintf(stderr, "%s:%d: assertion failed: %s\n", __FILE__, __LINE__, #c); exit(1); \
} } while (0)
#define CLOSE(a,b) CHECK(fabs((double)(a) - (double)(b)) < 1e-6)
#define LIMIT 50

static struct {
    uint64_t now;
    uint64_t clock_step;
    int clock_reads;
    int clock_fail_at;
    int ce_calls;
    int nli_calls;
    int loads;
    int shutdowns;
    float ce[LIMIT];
    int ce_rc[LIMIT];
    uint64_t ce_advance[LIMIT];
    char *seen_query[LIMIT];
    char *seen_document[LIMIT];
    bool allow_storage;
    int storage_calls;
    int vector_calls;
    int fts_calls;
    int get_calls;
    int writer_calls;
    int embed_calls;
    int other_ops;
    mg_node_score_t vec[LIMIT], title[LIMIT], body[LIMIT];
    int n_vec, n_title, n_body;
    bool vector_error;
    const char *node_title[LIMIT + 1];
    const char *node_body[LIMIT + 1];
    bool missing_node[LIMIT + 1];
} stub;

static char *copy(const char *s) {
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    CHECK(p);
    memcpy(p, s, n);
    return p;
}
static char *repeated(size_t n, char c) {
    char *p = malloc(n + 1);
    CHECK(p);
    memset(p, c, n);
    p[n] = 0;
    return p;
}
static void reset(void) {
    for (int i = 0; i < LIMIT; ++i) {
        free(stub.seen_query[i]);
        free(stub.seen_document[i]);
    }
    memset(&stub, 0, sizeof(stub));
    for (int i = 0; i < LIMIT; ++i) stub.ce[i] = 0.5f;
}
int mg_candidate_test_now_ms(uint64_t *out) {
    stub.clock_reads++;
    if (stub.clock_fail_at == stub.clock_reads) return -1;
    *out = stub.now;
    stub.now += stub.clock_step;
    return 0;
}
int mg_ce_score_pair(mg_verify_ctx_t *ctx, const char *q, const char *d, float *out) {
    CHECK(ctx && ctx->ce_runtime_enabled && q && d && out);
    int i = stub.ce_calls++;
    CHECK(i < LIMIT);
    stub.seen_query[i] = copy(q);
    stub.seen_document[i] = copy(d);
    stub.now += stub.ce_advance[i];
    *out = stub.ce[i];
    return stub.ce_rc[i];
}
int mg_ce_score_nli(mg_verify_ctx_t *ctx, const char *q, const char *d, float *out) {
    (void)ctx; (void)q; (void)d; (void)out;
    stub.nli_calls++;
    return -1;
}
int mg_ce_try_enable(mg_verify_ctx_t *ctx) { (void)ctx; stub.loads++; return -1; }
void mg_ce_shutdown(mg_verify_ctx_t *ctx) { (void)ctx; stub.shutdowns++; }
void mg_config_free(mg_config_t *cfg) { (void)cfg; }

static void storage_called(void) { CHECK(stub.allow_storage); stub.storage_calls++; }
mg_err_t mg_storage_vector_topk(mg_storage_t *s, const mg_embedding_t q, int k,
                                mg_node_score_t *out, int *n) {
    (void)q; CHECK(s); CHECK(k == 50); storage_called(); stub.vector_calls++;
    if (stub.vector_error) return MG_ERR_STORAGE;
    memcpy(out, stub.vec, (size_t)stub.n_vec * sizeof(*out)); *n = stub.n_vec; return MG_OK;
}
mg_err_t mg_storage_fts_search(mg_storage_t *s, const char *q, int k,
                               bool title, bool body, mg_node_score_t *out, int *n) {
    CHECK(s && q && k == 50 && title != body); storage_called(); stub.fts_calls++;
    *n = title ? stub.n_title : stub.n_body;
    memcpy(out, title ? stub.title : stub.body, (size_t)*n * sizeof(*out)); return MG_OK;
}
mg_err_t mg_storage_get_node(mg_storage_t *s, const mg_node_id_t id, mg_node_t *out) {
    CHECK(s && id[0] && id[0] <= LIMIT); storage_called(); stub.get_calls++;
    if (stub.missing_node[id[0]]) return MG_ERR_NOT_FOUND;
    memcpy(out->id, id, MG_NODE_ID_BYTES);
    out->title = copy(stub.node_title[id[0]]);
    out->body = copy(stub.node_body[id[0]]);
    return MG_OK;
}
mg_err_t mg_storage_node_keywords(mg_storage_t *s, const mg_node_id_t id,
                                  mg_keyword_id_t *out, int max, int *n) {
    CHECK(s && max > 0); storage_called(); out[0] = id[0]; *n = 1; return MG_OK;
}
mg_err_t mg_storage_get_keyword_text(mg_storage_t *s, mg_keyword_id_t id, char **out) {
    CHECK(s); storage_called(); char text[32];
    snprintf(text, sizeof(text), "keyword-%lld", (long long)id); *out = copy(text); return MG_OK;
}
mg_err_t mg_storage_touch_access(mg_storage_t *s, const mg_node_id_t id) {
    (void)s; (void)id; stub.writer_calls++; return MG_ERR_INTERNAL;
}
mg_err_t mg_storage_prune_expired(mg_storage_t *s, int64_t *n) {
    (void)s; (void)n; stub.writer_calls++; return MG_ERR_INTERNAL;
}
mg_err_t mg_storage_record_sample(mg_storage_t *s, int kind, float f) {
    (void)s; (void)kind; (void)f; stub.writer_calls++; return MG_ERR_INTERNAL;
}
mg_err_t mg_embed_text(mg_embed_ctx_t *ctx, const char *q, mg_embedding_t out) {
    CHECK(stub.allow_storage && ctx && q); stub.embed_calls++;
    memset(out, 0, sizeof(mg_embedding_t)); return MG_OK;
}
void mg_node_free(mg_node_t *node) {
    if (!node) return;
    free(node->title); free(node->body); free(node->author);
    memset(node, 0, sizeof(*node));
}
#define UNUSED_OP(name) mg_err_t name(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *w) { \
    (void)ctx; (void)args; (void)w; stub.other_ops++; return MG_ERR_INTERNAL; }
UNUSED_OP(mg_op_classify)
UNUSED_OP(mg_op_insert)
UNUSED_OP(mg_op_query)
UNUSED_OP(mg_op_explore)
UNUSED_OP(mg_op_get)
UNUSED_OP(mg_op_stats)
UNUSED_OP(mg_op_consolidate)
UNUSED_OP(mg_op_delete)
UNUSED_OP(mg_op_view)
UNUSED_OP(mg_op_remote_sync)

static mg_config_t config(void) {
    mg_config_t cfg = {0};
    cfg.rerank_enabled = true;
    cfg.rerank_top_k = 25;
    cfg.rerank_w_ce = 0.45f;
    cfg.rerank_w_vec = 0.30f;
    cfg.rerank_w_lex = 0.25f;
    cfg.cross_encoder_enabled = true;
    cfg.retrieve_top_k = 25;
    cfg.rrf_k_const = 60;
    return cfg;
}
static mg_rerank_ctx_t *reranker(mg_config_t *cfg, mg_verify_ctx_t *verify) {
    mg_rerank_ctx_t *r = NULL;
    CHECK(mg_rerank_init(cfg, verify, &r) == MG_OK);
    return r;
}
static mg_verify_ctx_t verifier(mg_config_t cfg) {
    mg_verify_ctx_t verify = {0}; verify.cfg = cfg; verify.ce_runtime_enabled = true; return verify;
}
static void no_side_effects(void) {
    CHECK(stub.storage_calls == 0 && stub.embed_calls == 0 && stub.writer_calls == 0);
    CHECK(stub.loads == 0 && stub.shutdowns == 0 && stub.nli_calls == 0 && stub.other_ops == 0);
}
static mg_candidate_input_t sample[3] = {
    {"opaque:/A", "alpha", "indexed body A, not title", -0.5, true},
    {"opaque:\xf0\x9f\x92\xbe:B", "beta", "indexed body B", 0.0, true},
    {"C", "", "indexed body C", 0.0, false}
};

typedef struct { char *bytes; size_t len; } bytes_t;
static bytes_t finish_writer(mpack_writer_t *w, char **data, size_t *size) {
    CHECK(mpack_writer_destroy(w) == mpack_ok);
    bytes_t bytes = {*data, *size}; return bytes;
}
static void write_candidate(mpack_writer_t *w, const mg_candidate_input_t *in) {
    mpack_build_map(w);
    mpack_write_cstr(w, "id"); mpack_write_cstr(w, in->id);
    mpack_write_cstr(w, "title"); mpack_write_cstr(w, in->title);
    mpack_write_cstr(w, "document"); mpack_write_cstr(w, in->document);
    mpack_write_cstr(w, "s_vec");
    if (in->has_s_vec) mpack_write_double(w, in->s_vec); else mpack_write_nil(w);
    mpack_complete_map(w);
}
static bytes_t request(const char *q, const mg_candidate_input_t *in, size_t n, int budget) {
    char *data = NULL; size_t size = 0; mpack_writer_t w;
    mpack_writer_init_growable(&w, &data, &size);
    mpack_build_map(&w);
    mpack_write_cstr(&w, "op"); mpack_write_cstr(&w, "score_candidates");
    mpack_write_cstr(&w, "args"); mpack_build_map(&w);
    mpack_write_cstr(&w, "query"); mpack_write_cstr(&w, q);
    if (budget != -1) { mpack_write_cstr(&w, "budget_ms"); mpack_write_int(&w, budget); }
    mpack_write_cstr(&w, "candidates"); mpack_start_array(&w, (uint32_t)n);
    for (size_t i = 0; i < n; ++i) write_candidate(&w, &in[i]);
    mpack_finish_array(&w); mpack_complete_map(&w); mpack_complete_map(&w);
    return finish_writer(&w, &data, &size);
}
typedef struct {
    void *bytes; size_t len; mpack_tree_t tree; mpack_node_t root; mpack_node_t result;
} response_t;
static mpack_node_t field(mpack_node_t node, const char *key) { return mpack_node_map_cstr(node, key); }
static bool eq(mpack_node_t node, const char *s) {
    return mpack_node_type(node) == mpack_type_str && mpack_node_strlen(node) == strlen(s) &&
           memcmp(mpack_node_str(node), s, strlen(s)) == 0;
}
static void finite_tree(mpack_node_t node, int depth) {
    CHECK(depth < 16);
    mpack_type_t t = mpack_node_type(node);
    if (t == mpack_type_double || t == mpack_type_float) CHECK(isfinite(mpack_node_double(node)));
    if (t == mpack_type_array) {
        for (size_t i = 0; i < mpack_node_array_length(node); ++i)
            finite_tree(mpack_node_array_at(node, i), depth + 1);
    } else if (t == mpack_type_map) {
        for (size_t i = 0; i < mpack_node_map_count(node); ++i) {
            CHECK(mpack_node_type(mpack_node_map_key_at(node, i)) == mpack_type_str);
            finite_tree(mpack_node_map_value_at(node, i), depth + 1);
        }
    }
}
static void parse_response(response_t *resp) {
    mpack_tree_init_data(&resp->tree, resp->bytes, resp->len);
    mpack_tree_parse(&resp->tree);
    CHECK(mpack_tree_error(&resp->tree) == mpack_ok);
    CHECK(mpack_tree_size(&resp->tree) == resp->len);
    resp->root = mpack_tree_root(&resp->tree);
    resp->result = field(resp->root, "result");
    finite_tree(resp->root, 0);
}
static void dispatch(mg_ctx_t *ctx, bytes_t req, response_t *resp) {
    memset(resp, 0, sizeof(*resp));
    CHECK(mg_dispatch(ctx, req.bytes, req.len, &resp->bytes, &resp->len) == MG_OK);
    parse_response(resp);
}
static void free_response(response_t *resp) {
    CHECK(mpack_tree_destroy(&resp->tree) == mpack_ok); free(resp->bytes);
}
static void success(response_t *resp, const char *status, size_t n, size_t scored) {
    CHECK(mpack_node_int(field(resp->root, "status")) == MG_OK);
    CHECK(mpack_node_int(field(resp->result, "version")) == 1);
    CHECK(eq(field(resp->result, "status"), status));
    CHECK(mpack_node_u64(field(resp->result, "candidate_count")) == n);
    CHECK(mpack_node_u64(field(resp->result, "scored_count")) == scored);
    CHECK(mpack_node_array_length(field(resp->result, "results")) == n);
    bool applied = strcmp(status, "applied") == 0;
    CHECK(mpack_node_bool(field(resp->result, "applied")) == applied);
    CHECK(eq(field(resp->result, "method"), applied ? "cross_encoder" : "original_order"));
}
static mpack_node_t item(response_t *resp, size_t i) {
    return mpack_node_array_at(field(resp->result, "results"), i);
}
static void check_original(const mg_candidate_batch_t *out) {
    CHECK(!out->applied);
    for (size_t i = 0; i < out->candidate_count; ++i) {
        CHECK(out->results[i].original_rank == (int)i + 1);
        CHECK(out->results[i].rank == (int)i + 1);
    }
}

static void test_core(void) {
    reset(); mg_config_t cfg = config();
    cfg.nli_enabled = true; cfg.rerank_w_nli = 100.0f; /* never an NLI/fusion path */
    mg_verify_ctx_t verify = verifier(cfg);
    float lex = NAN;
    CHECK(mg_text_trigram_jaccard_checked("alpha", "alpha", &lex) == MG_OK); CLOSE(lex, 1.0);
    CHECK(mg_text_trigram_jaccard_checked("alpha", "", &lex) == MG_OK); CLOSE(lex, 0.0);
    CHECK(mg_text_trigram_jaccard_checked(NULL, "alpha", &lex) == MG_ERR_INVALID_ARG && isnan(lex));
    CLOSE(mg_text_trigram_jaccard(NULL, "alpha"), 0.0); /* legacy gate utility unchanged */
    CHECK(mg_text_trigram_jaccard_checked("alpha", "alpha", NULL) == MG_ERR_INVALID_ARG);
    mg_rerank_ctx_t *r = reranker(&cfg, &verify); CHECK(r);
    stub.ce[0] = 0.2f; stub.ce[1] = stub.ce[2] = 0.8f;
    mg_candidate_batch_t out;
    CHECK(mg_candidate_score(r, "alpha", sample, 3, 8000, &out) == MG_OK);
    CHECK(out.status == MG_CANDIDATE_APPLIED && out.applied && out.scored_count == 3);
    CHECK(out.results[0].rank == 3 && out.results[1].rank == 1 && out.results[2].rank == 2);
    CLOSE(out.results[0].s_vec, -0.5); CLOSE(out.results[0].s_lex, 1.0);
    CHECK(out.results[1].has_s_vec && out.results[1].s_vec == 0.0);
    CHECK(!out.results[2].has_s_vec && out.results[2].has_s_lex && out.results[2].s_lex == 0.0);
    for (int i = 0; i < 3; ++i) {
        CHECK(strcmp(stub.seen_document[i], sample[i].document) == 0);
        CHECK(strcmp(stub.seen_query[i], "alpha") == 0);
        CHECK(out.results[i].ce_status == MG_CE_OK);
        CHECK(out.results[i].document_bytes == strlen(sample[i].document));
    }
    no_side_effects(); mg_rerank_shutdown(r); no_side_effects();

    /* Fixed permutations and ties for every permitted window size, not a
     * retrieval-quality or timing test. */
    char ids[25][16]; mg_candidate_input_t in[25];
    for (int i = 0; i < 25; ++i) {
        snprintf(ids[i], sizeof(ids[i]), "fixed-id-%02d", i);
        in[i] = (mg_candidate_input_t){ids[i], "title", "fixed body", 0.0, false};
    }
    for (size_t n = 1; n <= 25; ++n) {
        reset(); r = reranker(&cfg, &verify);
        for (size_t i = 0; i < n; ++i) stub.ce[i] = (float)(i % 4) / 4.0f;
        CHECK(mg_candidate_score(r, "query", in, n, 1, &out) == MG_OK);
        CHECK(out.applied && out.scored_count == n);
        bool ranks[26] = {false};
        for (size_t i = 0; i < n; ++i) {
            int rank = out.results[i].rank;
            CHECK(rank > 0 && rank <= (int)n && !ranks[rank]); ranks[rank] = true;
            for (size_t j = i + 1; j < n; ++j) {
                if (stub.ce[i] >= stub.ce[j]) CHECK(rank < out.results[j].rank);
                else CHECK(rank > out.results[j].rank);
            }
        }
        mg_rerank_shutdown(r); no_side_effects();
    }
}

static void test_states(void) {
    mg_candidate_batch_t out;
    for (int mode = 0; mode < 10; ++mode) {
        reset(); mg_config_t cfg = config();
        if (mode == 0) cfg.rerank_enabled = false;
        if (mode == 1) cfg.rerank_w_ce = cfg.rerank_w_vec = cfg.rerank_w_lex = cfg.rerank_w_nli = 0;
        if (mode == 2) cfg.cross_encoder_enabled = false;
        if (mode == 3) cfg.rerank_w_ce = 0;
        if (mode == 4) cfg.rerank_top_k = 0;
        if (mode == 5) cfg.hardware_accel = true;
        mg_verify_ctx_t verify = verifier(cfg);
        if (mode == 6) verify.cfg.hardware_accel = true;
        if (mode == 8) verify.ce_runtime_enabled = false;
        if (mode == 9) verify.cfg.cross_encoder_enabled = false;
        mg_rerank_ctx_t *r = reranker(&cfg, mode == 7 ? NULL : &verify);
        CHECK(mg_candidate_score(r, "alpha", sample, 3, 8000, &out) == MG_OK);
        bool disabled = mode < 5 || mode == 9;
        CHECK(out.status == (disabled ? MG_CANDIDATE_DISABLED : MG_CANDIDATE_UNAVAILABLE));
        if (mode == 5 || mode == 6) CHECK(strcmp(out.reason, "cpu_required") == 0);
        if (mode == 7 || mode == 8) CHECK(strcmp(out.reason, "ce_runtime_unavailable") == 0);
        check_original(&out); CHECK(out.scored_count == 0 && stub.ce_calls == 0);
        CHECK(out.results[0].has_s_vec && out.results[0].has_s_lex);
        CLOSE(out.results[0].s_lex, 1.0); CLOSE(out.results[0].s_vec, -0.5);
        for (int i = 0; i < 3; ++i) {
            CHECK(!out.results[i].has_s_ce);
            CHECK(out.results[i].ce_status == (disabled ? MG_CE_DISABLED : MG_CE_UNAVAILABLE));
        }
        mg_rerank_shutdown(r); no_side_effects();
    }
    mg_config_t cfg = config(); mg_verify_ctx_t verify = verifier(cfg);
    mg_rerank_ctx_t *r = reranker(&cfg, &verify);
    for (int mode = 0; mode < 6; ++mode) {
        reset(); stub.ce[0] = 0.1f; stub.ce[1] = 0.9f; stub.ce[2] = 0.8f;
        if (mode == 0) stub.ce_rc[1] = -1;
        if (mode == 1) stub.ce[1] = NAN;
        if (mode == 2) stub.ce[1] = INFINITY;
        if (mode == 3) stub.ce[1] = -INFINITY;
        if (mode == 4) stub.ce[1] = -0.1f;
        if (mode == 5) stub.ce[1] = 1.1f;
        CHECK(mg_candidate_score(r, "alpha", sample, 3, 8000, &out) == MG_OK);
        CHECK(out.status == MG_CANDIDATE_FAILED && out.scored_count == 2);
        check_original(&out); CHECK(stub.ce_calls == 3);
        CHECK(out.results[0].has_s_ce && out.results[2].has_s_ce);
        CHECK(!out.results[1].has_s_ce && out.results[1].ce_status == MG_CE_FAILED);
        no_side_effects();
    }
    reset(); stub.clock_step = 1;
    CHECK(mg_candidate_score(r, "alpha", sample, 3, 1, &out) == MG_OK);
    CHECK(out.status == MG_CANDIDATE_DEADLINE && out.scored_count == 0 && stub.ce_calls == 0);
    check_original(&out);
    for (int i = 0; i < 3; ++i) CHECK(out.results[i].ce_status == MG_CE_DEADLINE);
    reset(); stub.ce_advance[0] = 5;
    CHECK(mg_candidate_score(r, "alpha", sample, 3, 5, &out) == MG_OK);
    CHECK(out.status == MG_CANDIDATE_DEADLINE && out.scored_count == 1 && stub.ce_calls == 1);
    CHECK(out.results[0].ce_status == MG_CE_OK && out.results[1].ce_status == MG_CE_DEADLINE);
    check_original(&out);
    reset(); stub.ce_advance[0] = 5;
    CHECK(mg_candidate_score(r, "alpha", sample, 1, 5, &out) == MG_OK);
    CHECK(out.status == MG_CANDIDATE_DEADLINE && out.scored_count == 1 && stub.ce_calls == 1);
    CHECK(out.results[0].ce_status == MG_CE_OK); check_original(&out);
    for (int clock_fail = 1; clock_fail <= 5; ++clock_fail) {
        reset(); stub.clock_fail_at = clock_fail;
        CHECK(mg_candidate_score(r, "alpha", sample, 3, 8000, &out) == MG_OK);
        CHECK(out.status == MG_CANDIDATE_FAILED && strcmp(out.reason, "clock_unavailable") == 0);
        check_original(&out); no_side_effects();
    }
    reset(); mg_candidate_input_t missing[3]; memcpy(missing, sample, sizeof(missing));
    missing[1].document = NULL;
    CHECK(mg_candidate_score(r, "alpha", missing, 3, 8000, &out) == MG_OK);
    CHECK(out.status == MG_CANDIDATE_FAILED && out.scored_count == 2 && stub.ce_calls == 2);
    CHECK(strcmp(out.reason, "document_unavailable") == 0); check_original(&out);
    reset(); missing[1].document = sample[1].document; missing[1].title = NULL;
    CHECK(mg_candidate_score(r, "alpha", missing, 3, 8000, &out) == MG_OK);
    CHECK(out.applied && !out.results[1].has_s_lex);
    reset(); CHECK(mg_candidate_score(r, "query", NULL, 0, 8000, &out) == MG_OK);
    CHECK(out.status == MG_CANDIDATE_EMPTY && !out.applied && !out.scored_count && !stub.ce_calls);
    mg_rerank_shutdown(r); no_side_effects();
}

/* Each mutation is built as a real MessagePack value, not JSON re-encoding. */
enum bad {
    BAD_QUERY_TYPE, BAD_BLANK, BAD_UNICODE_BLANK, BAD_QUERY_NUL, BAD_QUERY_UTF8, BAD_QUERY_LONG,
    BAD_LIST_TYPE, BAD_TOO_MANY, BAD_CAND_TYPE, BAD_ID_EMPTY, BAD_ID_LONG, BAD_ID_NUL, BAD_ID_UTF8,
    BAD_TITLE_TYPE, BAD_TITLE_LONG, BAD_TITLE_NUL, BAD_DOC_TYPE, BAD_DOC_LONG, BAD_DOC_NUL,
    BAD_DOC_UTF8, BAD_VEC_NAN, BAD_VEC_INF, BAD_VEC_NEGINF, BAD_VEC_BOOL, BAD_VEC_STRING,
    BAD_VEC_CONTAINER, BAD_DUP_ID, BAD_MISSING_FIELD, BAD_DUP_KEY, BAD_UNKNOWN_KEY, BAD_NONSTR_KEY,
    BAD_BUDGET_ZERO, BAD_BUDGET_NEG, BAD_BUDGET_LONG, BAD_BUDGET_FLOAT, BAD_BUDGET_NIL,
    BAD_BUDGET_BOOL, BAD_BUDGET_UINT, BAD_ARGS_TYPE, BAD_DUP_ARG, BAD_UNKNOWN_ARG,
    BAD_ROOT_EXTRA, BAD_ROOT_DUP_ARGS, BAD_ROOT_DUP_OP, BAD_ROOT_TYPE, BAD_ARGS_MISSING,
    BAD_COUNT
};
static bytes_t bad_request(enum bad kind) {
    char *data = NULL; size_t size = 0; mpack_writer_t w;
    mpack_writer_init_growable(&w, &data, &size);
    char *long_q = repeated(16385, 'q'); char *long_id = repeated(4097, 'i');
    char *long_doc = repeated(131073, 'd');
    if (kind == BAD_ROOT_TYPE) { mpack_write_int(&w, 1); goto finished; }
    mpack_build_map(&w);
    mpack_write_cstr(&w, "op"); mpack_write_cstr(&w, "score_candidates");
    if (kind == BAD_ROOT_DUP_OP) { mpack_write_cstr(&w, "op"); mpack_write_cstr(&w, "score_candidates"); }
    if (kind == BAD_ROOT_EXTRA) { mpack_write_cstr(&w, "extra"); mpack_write_nil(&w); }
    if (kind == BAD_ARGS_MISSING) { mpack_complete_map(&w); goto finished; }
    if (kind == BAD_ROOT_DUP_ARGS) { mpack_write_cstr(&w, "args"); mpack_start_map(&w, 0); mpack_finish_map(&w); }
    mpack_write_cstr(&w, "args");
    if (kind == BAD_ARGS_TYPE) { mpack_write_nil(&w); mpack_complete_map(&w); goto finished; }
    mpack_build_map(&w);
    mpack_write_cstr(&w, "query");
    if (kind == BAD_QUERY_TYPE) mpack_write_int(&w, 2);
    else if (kind == BAD_BLANK) mpack_write_cstr(&w, " \n\t\r");
    else if (kind == BAD_UNICODE_BLANK) mpack_write_cstr(&w, "\xc2\xa0\xe3\x80\x80");
    else if (kind == BAD_QUERY_NUL) mpack_write_str(&w, "query\0tail", 10);
    else if (kind == BAD_QUERY_UTF8) mpack_write_str(&w, "\xc0\x80", 2);
    else if (kind == BAD_QUERY_LONG) mpack_write_cstr(&w, long_q);
    else mpack_write_cstr(&w, "alpha");
    if (kind == BAD_DUP_ARG) { mpack_write_cstr(&w, "query"); mpack_write_cstr(&w, "other"); }
    if (kind == BAD_UNKNOWN_ARG) { mpack_write_cstr(&w, "extra"); mpack_write_int(&w, 1); }
    if (kind != BAD_DUP_ARG && kind != BAD_UNKNOWN_ARG) {
        mpack_write_cstr(&w, "budget_ms");
        if (kind == BAD_BUDGET_ZERO) mpack_write_int(&w, 0);
        else if (kind == BAD_BUDGET_NEG) mpack_write_int(&w, -1);
        else if (kind == BAD_BUDGET_LONG) mpack_write_int(&w, 8001);
        else if (kind == BAD_BUDGET_FLOAT) mpack_write_double(&w, 1.0);
        else if (kind == BAD_BUDGET_NIL) mpack_write_nil(&w);
        else if (kind == BAD_BUDGET_BOOL) mpack_write_bool(&w, true);
        else if (kind == BAD_BUDGET_UINT) mpack_write_u64(&w, UINT64_MAX);
        else mpack_write_int(&w, 8000);
    }
    mpack_write_cstr(&w, "candidates");
    if (kind == BAD_LIST_TYPE) mpack_write_cstr(&w, "not an array");
    else {
        int count = kind == BAD_TOO_MANY ? 26 : (kind == BAD_DUP_ID ? 2 : 1);
        mpack_start_array(&w, (uint32_t)count);
        for (int i = 0; i < count; ++i) {
            if (kind == BAD_CAND_TYPE) { mpack_write_bool(&w, true); continue; }
            mpack_build_map(&w);
            mpack_write_cstr(&w, "id");
            if (kind == BAD_ID_EMPTY) mpack_write_cstr(&w, "");
            else if (kind == BAD_ID_LONG) mpack_write_cstr(&w, long_id);
            else if (kind == BAD_ID_NUL) mpack_write_str(&w, "id\0tail", 7);
            else if (kind == BAD_ID_UTF8) mpack_write_str(&w, "\xed\xa0\x80", 3);
            else mpack_write_cstr(&w, "fixed-id");
            mpack_write_cstr(&w, "title");
            if (kind == BAD_TITLE_TYPE) mpack_write_nil(&w);
            else if (kind == BAD_TITLE_LONG) mpack_write_cstr(&w, long_q);
            else if (kind == BAD_TITLE_NUL) mpack_write_str(&w, "a\0b", 3);
            else mpack_write_cstr(&w, "alpha");
            if (kind == BAD_NONSTR_KEY) mpack_write_int(&w, 2);
            else mpack_write_cstr(&w, kind == BAD_DUP_KEY ? "id" : (kind == BAD_UNKNOWN_KEY ? "extra" : "document"));
            if (kind == BAD_DOC_TYPE) mpack_write_nil(&w);
            else if (kind == BAD_DOC_LONG) mpack_write_cstr(&w, long_doc);
            else if (kind == BAD_DOC_NUL) mpack_write_str(&w, "body\0tail", 9);
            else if (kind == BAD_DOC_UTF8) mpack_write_str(&w, "\xf4\x90\x80\x80", 4);
            else mpack_write_cstr(&w, "actual fixed body");
            if (kind != BAD_MISSING_FIELD) {
                mpack_write_cstr(&w, "s_vec");
                if (kind == BAD_VEC_NAN) mpack_write_double(&w, NAN);
                else if (kind == BAD_VEC_INF) mpack_write_double(&w, INFINITY);
                else if (kind == BAD_VEC_NEGINF) mpack_write_double(&w, -INFINITY);
                else if (kind == BAD_VEC_BOOL) mpack_write_bool(&w, true);
                else if (kind == BAD_VEC_STRING) mpack_write_cstr(&w, "0.5");
                else if (kind == BAD_VEC_CONTAINER) { mpack_start_array(&w, 0); mpack_finish_array(&w); }
                else mpack_write_nil(&w);
            }
            mpack_complete_map(&w);
        }
        mpack_finish_array(&w);
    }
    mpack_complete_map(&w); mpack_complete_map(&w);
finished:
    free(long_q); free(long_id); free(long_doc);
    return finish_writer(&w, &data, &size);
}
static void expect_invalid(mg_ctx_t *ctx, bytes_t req) {
    response_t resp; dispatch(ctx, req, &resp);
    CHECK(mpack_node_int(field(resp.root, "status")) != MG_OK);
    CHECK(mpack_node_is_nil(resp.result));
    CHECK(stub.ce_calls == 0); no_side_effects();
    free_response(&resp);
}
static void test_invalid(void) {
    mg_config_t cfg = config(); mg_verify_ctx_t verify = verifier(cfg);
    mg_rerank_ctx_t *r = reranker(&cfg, &verify); mg_ctx_t ctx = {0}; ctx.rerank = r;
    for (int i = 0; i < BAD_COUNT; ++i) {
        reset(); bytes_t req = bad_request((enum bad)i);
        expect_invalid(&ctx, req); free(req.bytes);
    }
    reset(); bytes_t good = request("alpha", sample, 3, 8000);
    bytes_t trailing = {malloc(good.len + 1), good.len + 1}; CHECK(trailing.bytes);
    memcpy(trailing.bytes, good.bytes, good.len); trailing.bytes[good.len] = 0;
    expect_invalid(&ctx, trailing); free(trailing.bytes);
    bytes_t oversized = {calloc(MG_CANDIDATE_MAX_REQUEST_BYTES + 1u, 1), MG_CANDIDATE_MAX_REQUEST_BYTES + 1u};
    CHECK(oversized.bytes); memcpy(oversized.bytes, good.bytes, good.len);
    expect_invalid(&ctx, oversized); free(oversized.bytes);
    bytes_t truncated = {good.bytes, good.len - 1}; expect_invalid(&ctx, truncated);
    char invalid = (char)0xc1; bytes_t invalid_bytes = {&invalid, 1}; expect_invalid(&ctx, invalid_bytes);
    free(good.bytes);
    mg_candidate_batch_t out;
    CHECK(mg_candidate_score(r, "", sample, 3, 8000, &out) == MG_ERR_INVALID_ARG);
    CHECK(mg_candidate_score(r, "query", sample, 26, 8000, &out) == MG_ERR_INVALID_ARG);
    CHECK(mg_candidate_score(r, "query", NULL, 1, 8000, &out) == MG_ERR_INVALID_ARG);
    CHECK(mg_candidate_score(r, "query", sample, 3, 0, &out) == MG_ERR_INVALID_ARG);
    CHECK(mg_candidate_score(r, "query", sample, 3, 8001, &out) == MG_ERR_INVALID_ARG);
    mg_candidate_input_t duplicate[2] = {sample[0], sample[0]};
    CHECK(mg_candidate_score(r, "query", duplicate, 2, 8000, &out) == MG_ERR_INVALID_ARG);
    CHECK(stub.ce_calls == 0); mg_rerank_shutdown(r); no_side_effects();
}

static void test_bounds(void) {
    reset(); mg_config_t cfg = config(); mg_verify_ctx_t verify = verifier(cfg);
    mg_rerank_ctx_t *r = reranker(&cfg, &verify); mg_ctx_t ctx = {0}; ctx.rerank = r;
    char *q = repeated(16384, 'q'); char *title = repeated(16384, 't');
    char *doc = repeated(131072, 'd'); char *ids[25]; mg_candidate_input_t in[25];
    for (int i = 0; i < 25; ++i) {
        ids[i] = repeated(4096, 'i'); ids[i][4095] = (char)('A' + i);
        in[i] = (mg_candidate_input_t){ids[i], title, doc, 0.0, false};
    }
    in[0].s_vec = DBL_MAX; in[0].has_s_vec = true;
    bytes_t req = request(q, in, 25, -1); CHECK(req.len < MG_CANDIDATE_MAX_REQUEST_BYTES);
    response_t resp; dispatch(&ctx, req, &resp); success(&resp, "applied", 25, 25);
    CHECK(resp.len < 1024u * 1024u && stub.ce_calls == 25);
    CHECK(eq(field(item(&resp, 0), "id"), ids[0]));
    CHECK(mpack_node_double(field(item(&resp, 0), "s_vec")) == DBL_MAX);
    CHECK(mpack_node_u64(field(item(&resp, 0), "document_bytes")) == 131072u);
    CHECK(strlen(stub.seen_query[0]) == 16384u && strlen(stub.seen_document[24]) == 131072u);
    free_response(&resp); free(req.bytes); no_side_effects();
    for (int i = 0; i < 25; ++i) free(ids[i]);
    free(q); free(title); free(doc);
    reset(); req = request("alpha", NULL, 0, 1); dispatch(&ctx, req, &resp);
    success(&resp, "empty", 0, 0); CHECK(stub.ce_calls == 0);
    free_response(&resp); free(req.bytes); mg_rerank_shutdown(r); no_side_effects();
}

static void test_serialization(void) {
    reset(); mg_config_t cfg = config(); mg_verify_ctx_t verify = verifier(cfg);
    mg_rerank_ctx_t *r = reranker(&cfg, &verify); mg_ctx_t ctx = {0}; ctx.rerank = r;
    stub.ce[0] = 0.2f; stub.ce[1] = stub.ce[2] = 0.8f;
    bytes_t req = request("alpha", sample, 3, 8000); response_t resp;
    dispatch(&ctx, req, &resp); success(&resp, "applied", 3, 3);
    CHECK(mpack_node_map_count(resp.result) == 8);
    int ranks[] = {3, 1, 2};
    for (int i = 0; i < 3; ++i) {
        mpack_node_t node = item(&resp, (size_t)i);
        CHECK(mpack_node_map_count(node) == 9);
        CHECK(eq(field(node, "id"), sample[i].id));
        CHECK(mpack_node_int(field(node, "original_rank")) == i + 1);
        CHECK(mpack_node_int(field(node, "rank")) == ranks[i]);
        CHECK(eq(field(node, "ce_status"), "ok"));
        CHECK(eq(field(node, "s_lex_source"), "title_trigram_jaccard"));
    }
    CLOSE(mpack_node_double(field(item(&resp, 0), "s_vec")), -0.5);
    CLOSE(mpack_node_double(field(item(&resp, 1), "s_vec")), 0);
    CHECK(mpack_node_is_nil(field(item(&resp, 2), "s_vec")));
    free_response(&resp); no_side_effects();
    reset(); stub.ce[1] = INFINITY;
    dispatch(&ctx, req, &resp); success(&resp, "failed", 3, 2);
    for (int i = 0; i < 3; ++i) CHECK(mpack_node_int(field(item(&resp, i), "rank")) == i + 1);
    CHECK(mpack_node_is_nil(field(item(&resp, 1), "s_ce")));
    CHECK(eq(field(item(&resp, 1), "ce_status"), "failed"));
    CHECK(!mpack_node_is_nil(field(item(&resp, 0), "s_ce")));
    free_response(&resp);
    reset(); verify.ce_runtime_enabled = false;
    dispatch(&ctx, req, &resp); success(&resp, "unavailable", 3, 0);
    CHECK(eq(field(resp.result, "reason"), "ce_runtime_unavailable"));
    CHECK(mpack_node_is_nil(field(item(&resp, 1), "s_ce")));
    CHECK(eq(field(item(&resp, 1), "ce_status"), "unavailable"));
    free_response(&resp); verify.ce_runtime_enabled = true;
    reset(); stub.ce_advance[0] = 8000;
    dispatch(&ctx, req, &resp); success(&resp, "deadline", 3, 1);
    CHECK(eq(field(item(&resp, 0), "ce_status"), "ok"));
    CHECK(eq(field(item(&resp, 1), "ce_status"), "deadline"));
    CHECK(mpack_node_int(field(item(&resp, 0), "rank")) == 1);
    free_response(&resp); free(req.bytes);
    reset(); ctx.rerank = NULL; req = request("alpha", sample, 3, 8000);
    dispatch(&ctx, req, &resp); success(&resp, "disabled", 3, 0);
    CHECK(mpack_node_is_nil(field(item(&resp, 0), "s_ce")));
    CLOSE(mpack_node_double(field(item(&resp, 0), "s_lex")), 1);
    free_response(&resp); free(req.bytes); no_side_effects();

    /* Defense in depth: even a corrupt internal signal is serialized as nil. */
    char *data = NULL; size_t size = 0; mpack_writer_t w;
    mpack_writer_init_growable(&w, &data, &size);
    mg_candidate_result_t signals = {0};
    signals.has_s_vec = signals.has_s_lex = signals.has_s_ce = true;
    signals.s_vec = NAN; signals.s_lex = INFINITY; signals.s_ce = -INFINITY;
    signals.ce_status = MG_CE_FAILED;
    mpack_build_map(&w); mg_candidate_write_signal_fields(&w, &signals); mpack_complete_map(&w);
    bytes_t bytes = finish_writer(&w, &data, &size);
    mpack_tree_t tree; mpack_tree_init_data(&tree, bytes.bytes, bytes.len); mpack_tree_parse(&tree);
    CHECK(mpack_tree_error(&tree) == mpack_ok); mpack_node_t root = mpack_tree_root(&tree);
    CHECK(mpack_node_is_nil(field(root, "s_vec")) && mpack_node_is_nil(field(root, "s_lex")) &&
          mpack_node_is_nil(field(root, "s_ce"))); finite_tree(root, 0);
    CHECK(mpack_tree_destroy(&tree) == mpack_ok); free(bytes.bytes);
    mg_rerank_shutdown(r); no_side_effects();
}

static void set_list(mg_node_score_t *entry, int id, float score) {
    memset(entry, 0, sizeof(*entry)); entry->id[0] = (uint8_t)id; entry->score = score;
}
static void setup_retrieve(void) {
    reset(); stub.allow_storage = true;
    stub.n_vec = stub.n_title = stub.n_body = 3;
    set_list(&stub.vec[0], 1, 0.9f); set_list(&stub.vec[1], 2, -0.4f); set_list(&stub.vec[2], 4, 0.0f);
    for (int i = 0; i < 3; ++i) {
        set_list(&stub.title[i], i + 1, 99.0f - (float)i); /* BM25 is NOT a lexical signal */
        set_list(&stub.body[i], i + 1, -99.0f + (float)i);
    }
    stub.node_title[1] = "query"; stub.node_body[1] = "actual indexed body A";
    stub.node_title[2] = "title B"; stub.node_body[2] = "actual indexed body B";
    stub.node_title[3] = "explicit title fallback C"; stub.node_body[3] = NULL;
    stub.node_title[4] = "tail D"; stub.node_body[4] = "actual indexed tail D";
    stub.ce[0] = 0.2f; stub.ce[1] = stub.ce[2] = 0.9f;
}
static bytes_t retrieve_request(int top_k) {
    char *data = NULL; size_t size = 0; mpack_writer_t w;
    mpack_writer_init_growable(&w, &data, &size);
    mpack_build_map(&w); mpack_write_cstr(&w, "op"); mpack_write_cstr(&w, "retrieve");
    mpack_write_cstr(&w, "args"); mpack_build_map(&w);
    mpack_write_cstr(&w, "text"); mpack_write_cstr(&w, "query");
    mpack_write_cstr(&w, "top_k"); mpack_write_int(&w, top_k);
    mpack_complete_map(&w); mpack_complete_map(&w); return finish_writer(&w, &data, &size);
}
static void id_is(mpack_node_t node, int id) {
    char hex[33]; memset(hex, '0', 32); hex[32] = 0;
    const char *digits = "0123456789abcdef";
    hex[0] = digits[(id >> 4) & 15]; hex[1] = digits[id & 15];
    CHECK(eq(field(node, "id_hex"), hex));
}
static void retrieval_counts(int nodes) {
    CHECK(stub.vector_calls == 1 && stub.fts_calls == 2 && stub.get_calls == nodes && stub.embed_calls == 1);
    CHECK(stub.writer_calls == 0 && stub.loads == 0 && stub.shutdowns == 0 && stub.nli_calls == 0 && stub.other_ops == 0);
}
static void test_retrieve(void) {
    mg_config_t cfg = config(); cfg.rerank_top_k = 3; mg_verify_ctx_t verify = verifier(cfg);
    mg_rerank_ctx_t *r = reranker(&cfg, &verify);
    mg_ctx_t ctx = {0}; ctx.config = &cfg; ctx.rerank = r;
    ctx.storage = (mg_storage_t *)(uintptr_t)1; ctx.embed = (mg_embed_ctx_t *)(uintptr_t)2;
    bytes_t req = retrieve_request(4); response_t resp;
    setup_retrieve(); dispatch(&ctx, req, &resp);
    CHECK(mpack_node_int(field(resp.root, "status")) == MG_OK);
    CHECK(eq(field(field(resp.result, "rerank"), "status"), "applied"));
    CHECK(mpack_node_u64(field(field(resp.result, "rerank"), "candidate_count")) == 3);
    CHECK(mpack_node_array_length(field(resp.result, "results")) == 4);
    int expected[] = {2, 3, 1, 4};
    float raw_rrf[] = {0, 3.0f / 61.0f, 3.0f / 62.0f, 2.0f / 63.0f, 1.0f / 63.0f};
    for (int i = 0; i < 4; ++i) {
        mpack_node_t node = item(&resp, i); int id = expected[i]; id_is(node, id);
        CHECK(mpack_node_int(field(node, "rank")) == i + 1);
        CHECK(mpack_node_int(field(node, "rrf_rank")) == id);
        CLOSE(mpack_node_double(field(node, "rrf_score")), raw_rrf[id]);
        CHECK(eq(field(node, "score_kind"), i < 3 ? "cross_encoder" : "rrf"));
        CLOSE(mpack_node_double(field(node, "score")), i < 3 ? (id == 1 ? 0.2f : 0.9f) : raw_rrf[id]);
        mpack_node_t sig = field(node, "signals");
        CHECK(eq(field(sig, "s_lex_source"), "title_trigram_jaccard"));
        CHECK(eq(field(sig, "ce_status"), i < 3 ? "ok" : "not_scored"));
        char kw[32]; snprintf(kw, sizeof(kw), "keyword-%d", id);
        CHECK(eq(mpack_node_array_at(field(node, "keywords"), 0), kw));
    }
    CLOSE(mpack_node_double(field(field(item(&resp, 0), "signals"), "s_vec")), -0.4);
    CHECK(mpack_node_is_nil(field(field(item(&resp, 1), "signals"), "s_vec")));
    CHECK(eq(field(field(item(&resp, 1), "signals"), "s_vec_source"), "unavailable"));
    CLOSE(mpack_node_double(field(field(item(&resp, 3), "signals"), "s_vec")), 0.0);
    CLOSE(mpack_node_double(field(field(item(&resp, 2), "signals"), "s_lex")), 1.0);
    CHECK(eq(field(field(item(&resp, 1), "signals"), "document_source"), "title_fallback"));
    CHECK(eq(field(field(item(&resp, 0), "signals"), "document_source"), "body"));
    CHECK(strcmp(stub.seen_document[0], "actual indexed body A") == 0);
    CHECK(strcmp(stub.seen_document[1], "actual indexed body B") == 0);
    CHECK(strcmp(stub.seen_document[2], "explicit title fallback C") == 0);
    CHECK(mpack_node_array_length(field(resp.result, "distinct_keywords")) == 4);
    retrieval_counts(4); free_response(&resp);

    setup_retrieve(); stub.ce_rc[1] = -1; dispatch(&ctx, req, &resp);
    CHECK(eq(field(field(resp.result, "rerank"), "status"), "failed"));
    for (int i = 0; i < 4; ++i) {
        mpack_node_t node = item(&resp, i); id_is(node, i + 1);
        CHECK(eq(field(node, "score_kind"), "rrf"));
        CLOSE(mpack_node_double(field(node, "score")), raw_rrf[i + 1]);
    }
    CHECK(mpack_node_is_nil(field(field(item(&resp, 1), "signals"), "s_ce")));
    CHECK(!mpack_node_is_nil(field(field(item(&resp, 0), "signals"), "s_ce")));
    retrieval_counts(4); free_response(&resp);

    setup_retrieve(); ctx.rerank = NULL; dispatch(&ctx, req, &resp);
    CHECK(eq(field(field(resp.result, "rerank"), "status"), "disabled") && stub.ce_calls == 0);
    for (int i = 0; i < 4; ++i) id_is(item(&resp, i), i + 1);
    retrieval_counts(4); free_response(&resp); ctx.rerank = r;

    setup_retrieve(); stub.node_title[2] = NULL; dispatch(&ctx, req, &resp);
    CHECK(eq(field(field(resp.result, "rerank"), "status"), "applied"));
    CHECK(mpack_node_is_nil(field(field(item(&resp, 0), "signals"), "s_lex")));
    CHECK(strcmp(stub.seen_document[1], "actual indexed body B") == 0);
    retrieval_counts(4); free_response(&resp);

    setup_retrieve(); stub.vec[1].score = NAN; dispatch(&ctx, req, &resp);
    CHECK(mpack_node_is_nil(field(field(item(&resp, 0), "signals"), "s_vec")));
    CHECK(eq(field(field(item(&resp, 0), "signals"), "s_vec_source"), "unavailable"));
    retrieval_counts(4); free_response(&resp);

    setup_retrieve(); stub.vector_error = true; dispatch(&ctx, req, &resp);
    CHECK(mpack_node_array_length(field(resp.result, "results")) == 3);
    for (int i = 0; i < 3; ++i) {
        CHECK(mpack_node_is_nil(field(field(item(&resp, i), "signals"), "s_vec")));
        CHECK(eq(field(field(item(&resp, i), "signals"), "s_vec_source"), "unavailable"));
    }
    retrieval_counts(3); free_response(&resp);

    setup_retrieve(); char *oversized = repeated(131073, 'b'); stub.node_body[2] = oversized;
    dispatch(&ctx, req, &resp);
    CHECK(eq(field(field(resp.result, "rerank"), "reason"), "input_limits") && stub.ce_calls == 0);
    CHECK(mpack_node_u64(field(field(item(&resp, 1), "signals"), "document_bytes")) == 131073u);
    for (int i = 0; i < 4; ++i) id_is(item(&resp, i), i + 1);
    retrieval_counts(4); free_response(&resp); free(oversized);

    setup_retrieve(); stub.missing_node[1] = true; dispatch(&ctx, req, &resp);
    CHECK(eq(field(field(resp.result, "rerank"), "status"), "failed"));
    CHECK(eq(field(field(resp.result, "rerank"), "reason"), "document_unavailable"));
    CHECK(mpack_node_array_length(field(resp.result, "results")) == 3 && stub.ce_calls == 2);
    for (int i = 0; i < 3; ++i) id_is(item(&resp, i), i + 2);
    retrieval_counts(4); free_response(&resp); free(req.bytes); mg_rerank_shutdown(r);

    /* The first-25 cap and unchanged tail on a frozen 30-ID list. */
    reset(); stub.allow_storage = true; stub.n_vec = 30;
    char titles[30][32], bodies[30][32];
    for (int i = 0; i < 30; ++i) {
        set_list(&stub.vec[i], i + 1, 0.5f);
        snprintf(titles[i], sizeof(titles[i]), "fixed title %02d", i + 1);
        snprintf(bodies[i], sizeof(bodies[i]), "fixed indexed body %02d", i + 1);
        stub.node_title[i + 1] = titles[i]; stub.node_body[i + 1] = bodies[i];
        stub.ce[i] = (float)i / 30.0f;
    }
    cfg.rerank_top_k = 40; verify = verifier(cfg); r = reranker(&cfg, &verify); ctx.rerank = r;
    req = retrieve_request(30); dispatch(&ctx, req, &resp);
    CHECK(mpack_node_array_length(field(resp.result, "results")) == 30 && stub.ce_calls == 25);
    CHECK(mpack_node_u64(field(field(resp.result, "rerank"), "candidate_count")) == 25);
    for (int i = 0; i < 30; ++i) {
        int id = i < 25 ? 25 - i : i + 1;
        mpack_node_t node = item(&resp, i); id_is(node, id);
        CHECK(mpack_node_int(field(node, "rrf_rank")) == id);
        CLOSE(mpack_node_double(field(node, "rrf_score")), 1.0f / (60.0f + (float)id));
        CHECK(eq(field(node, "score_kind"), i < 25 ? "cross_encoder" : "rrf"));
    }
    retrieval_counts(30); free_response(&resp); free(req.bytes); mg_rerank_shutdown(r);
}

static void test_wire(void) {
    reset(); mg_op_t op; CHECK(mg_wire_op_from_string("score_candidates", &op) == MG_OK);
    CHECK(op == MG_OP_SCORE_CANDIDATES && MG_OP_REMOTE_SYNC == 11);
    CHECK(strcmp(mg_wire_op_to_string(op), "score_candidates") == 0);
    CHECK(mg_wire_op_from_string("unknown", &op) == MG_ERR_INVALID_ARG);
    int sv[2]; CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
    unsigned char payload[258]; memset(payload, 0x42, sizeof(payload));
    CHECK(mg_wire_write_frame(sv[0], payload, sizeof(payload)) == MG_OK);
    unsigned char hdr[4], body[258];
    CHECK(recv(sv[1], hdr, 4, MSG_WAITALL) == 4);
    CHECK(hdr[0] == 2 && hdr[1] == 1 && hdr[2] == 0 && hdr[3] == 0);
    CHECK(recv(sv[1], body, sizeof(body), MSG_WAITALL) == (ssize_t)sizeof(body));
    CHECK(memcmp(body, payload, sizeof(body)) == 0);
    CHECK(send(sv[0], hdr, 1, 0) == 1 && send(sv[0], hdr + 1, 3, 0) == 3);
    CHECK(send(sv[0], payload, sizeof(payload), 0) == (ssize_t)sizeof(payload));
    void *buf = NULL; size_t len = 0;
    CHECK(mg_wire_read_frame(sv[1], &buf, &len) == MG_OK && len == sizeof(payload));
    CHECK(memcmp(buf, payload, len) == 0); free(buf);
    CHECK(mg_wire_write_frame(sv[0], NULL, 1) == MG_ERR_INVALID_ARG);
    CHECK(mg_wire_write_frame(sv[0], payload, 16u * 1024u * 1024u + 1u) == MG_ERR_INVALID_ARG);
    unsigned char too_big[] = {1, 0, 0, 1}; /* 16 MiB + 1, little endian */
    CHECK(send(sv[0], too_big, 4, 0) == 4);
    CHECK(mg_wire_read_frame(sv[1], &buf, &len) == MG_ERR_WIRE && !buf && !len);
    unsigned char zero[] = {0, 0, 0, 0}; CHECK(send(sv[0], zero, 4, 0) == 4);
    CHECK(mg_wire_read_frame(sv[1], &buf, &len) == MG_OK && !buf && !len);
    close(sv[0]); close(sv[1]);
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
    unsigned char truncated[] = {8, 0, 0, 0, 1, 2, 3};
    CHECK(send(sv[0], truncated, sizeof(truncated), 0) == (ssize_t)sizeof(truncated)); close(sv[0]);
    CHECK(mg_wire_read_frame(sv[1], &buf, &len) == MG_ERR_IO && !buf && !len); close(sv[1]);

    /* Actual framed dispatch round trip, no pathname socket or daemon. */
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
    mg_config_t cfg = config(); mg_verify_ctx_t verify = verifier(cfg);
    mg_rerank_ctx_t *r = reranker(&cfg, &verify); mg_ctx_t ctx = {0}; ctx.rerank = r;
    bytes_t req = request("alpha", sample, 3, 8000);
    CHECK(mg_wire_write_frame(sv[0], req.bytes, req.len) == MG_OK);
    CHECK(mg_wire_read_frame(sv[1], &buf, &len) == MG_OK);
    bytes_t server_req = {buf, len}; response_t server_resp; dispatch(&ctx, server_req, &server_resp);
    CHECK(mg_wire_write_frame(sv[1], server_resp.bytes, server_resp.len) == MG_OK);
    response_t client_resp = {0};
    CHECK(mg_wire_read_frame(sv[0], &client_resp.bytes, &client_resp.len) == MG_OK);
    parse_response(&client_resp); success(&client_resp, "applied", 3, 3);
    free_response(&client_resp); free_response(&server_resp); free(buf); free(req.bytes);
    close(sv[0]); close(sv[1]); mg_rerank_shutdown(r); no_side_effects();
}

int main(int argc, char **argv) {
    CHECK(argc == 2);
    if (!strcmp(argv[1], "core")) test_core();
    else if (!strcmp(argv[1], "states")) test_states();
    else if (!strcmp(argv[1], "invalid")) test_invalid();
    else if (!strcmp(argv[1], "bounds")) test_bounds();
    else if (!strcmp(argv[1], "serialization")) test_serialization();
    else if (!strcmp(argv[1], "retrieve")) test_retrieve();
    else if (!strcmp(argv[1], "wire")) test_wire();
    else CHECK(!"unknown unit group");
    reset();
    puts("native candidate scorer unit group passed (mock CE; genuine model runtime unverified)");
    return 0;
}
