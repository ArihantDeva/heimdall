/* HTTP endpoint handlers.
 *
 * Each handler converts the HTTP request into an mpack request frame
 * (the same shape the unix-socket dispatcher already understands), calls
 * mg_dispatch, and converts the mpack response back to JSON for the wire.
 * This keeps a single source of truth for op semantics: the C op_* handlers.
 */

#include "internal.h"
#include "graft/http.h"
#include "graft/ops.h"
#include "mpack.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void mg_http_error(mg_http_response_t *resp, int status, const char *msg) {
  char buf[512];
  int n = snprintf(buf, sizeof(buf), "{\"error\":\"%s\"}", msg ? msg : "error");
  if (n < 0) n = 0;
  if ((size_t)n >= sizeof(buf)) n = (int)sizeof(buf) - 1;
  void *body = malloc((size_t)n);
  if (body) {
    memcpy(body, buf, (size_t)n);
    mg_http_response_set_json(resp, status, body, (size_t)n);
  } else {
    resp->status = status;
  }
}

/* Build an mpack frame {op, args} → run dispatch → write JSON of the
 * resulting {status, result, error} map. The caller-provided builder
 * populates the args submap. */
typedef void (*mg_http_args_builder_fn)(mpack_writer_t *w, void *user);

static void run_dispatch(mg_ctx_t *ctx, const char *op,
                         mg_http_args_builder_fn build_args, void *user,
                         int success_status, mg_http_response_t *resp) {
  char  *req_buf = NULL;
  size_t req_len = 0;
  mpack_writer_t w;
  void  *resp_buf = NULL;
  size_t resp_len = 0;
  char  *json = NULL;
  size_t json_len = 0;
  mg_err_t e;

  mpack_writer_init_growable(&w, &req_buf, &req_len);
  mpack_start_map(&w, 2);
  mpack_write_cstr(&w, "op");
  mpack_write_cstr(&w, op);
  mpack_write_cstr(&w, "args");
  if (build_args) build_args(&w, user);
  else { mpack_start_map(&w, 0); mpack_finish_map(&w); }
  mpack_finish_map(&w);
  if (mpack_writer_destroy(&w) != mpack_ok) {
    free(req_buf);
    mg_http_error(resp, 500, "request encode failed");
    return;
  }

  e = mg_dispatch(ctx, req_buf, req_len, &resp_buf, &resp_len);
  free(req_buf);
  if (e != MG_OK || !resp_buf) {
    free(resp_buf);
    mg_http_error(resp, 500, mg_strerror(e));
    return;
  }

  /* Inspect "status" from the mpack response to decide HTTP status. */
  {
    mpack_tree_t tree;
    int status_val = 0;
    mpack_tree_init_data(&tree, (const char *)resp_buf, resp_len);
    mpack_tree_parse(&tree);
    if (mpack_tree_error(&tree) == mpack_ok) {
      mpack_node_t st = mpack_node_map_cstr_optional(mpack_tree_root(&tree), "status");
      if (!mpack_node_is_missing(st) && !mpack_node_is_nil(st)) {
        status_val = (int)mpack_node_int(st);
      }
    }
    mpack_tree_destroy(&tree);
    if (status_val == 2 /* MG_ERR_NOT_FOUND mapping */) success_status = 404;
    else if (status_val != 0) success_status = 500;
  }

  e = mg_http_mpack_to_json(resp_buf, resp_len, &json, &json_len);
  free(resp_buf);
  if (e != MG_OK || !json) {
    free(json);
    mg_http_error(resp, 500, "response encode failed");
    return;
  }
  mg_http_response_set_json(resp, success_status, json, json_len);
}

/* ---------------- /v1/healthz ---------------- */

void mg_http_handler_healthz(mg_ctx_t *ctx, mg_http_request_t *req,
                             mg_http_response_t *resp) {
  char buf[256];
  int n;
  (void)req;
  (void)ctx;
  n = snprintf(buf, sizeof(buf),
               "{\"status\":\"ok\",\"service\":\"graftd\"}");
  if (n < 0 || (size_t)n >= sizeof(buf)) {
    mg_http_error(resp, 500, "internal error");
    return;
  }
  void *body = malloc((size_t)n);
  if (!body) { mg_http_error(resp, 500, "oom"); return; }
  memcpy(body, buf, (size_t)n);
  mg_http_response_set_json(resp, 200, body, (size_t)n);
}

/* ---------------- text-only arg builder ---------------- */

typedef struct {
  const char *text;
} text_only_args_t;

static void build_text_args(mpack_writer_t *w, void *user) {
  text_only_args_t *a = (text_only_args_t *)user;
  mpack_start_map(w, 1);
  mpack_write_cstr(w, "text");
  mpack_write_cstr(w, a->text ? a->text : "");
  mpack_finish_map(w);
}

/* ---------------- /v1/match?text=... ---------------- */

void mg_http_handler_match(mg_ctx_t *ctx, mg_http_request_t *req,
                           mg_http_response_t *resp) {
  char *text;
  text_only_args_t a;
  if (!ctx->config->http_ep_match) { mg_http_error(resp, 404, "endpoint disabled"); return; }
  text = mg_http_query_get(req, "text");
  if (!text) { mg_http_error(resp, 400, "missing text"); return; }
  a.text = text;
  run_dispatch(ctx, "query", build_text_args, &a, 200, resp);
  free(text);
}

/* ---------------- /v1/search?text=...&top_k=... ---------------- */

typedef struct {
  const char *text;
  int top_k;
} search_args_t;

static void build_search_args(mpack_writer_t *w, void *user) {
  search_args_t *a = (search_args_t *)user;
  int n = 1 + (a->top_k > 0 ? 1 : 0);
  mpack_start_map(w, (uint32_t)n);
  mpack_write_cstr(w, "text");
  mpack_write_cstr(w, a->text ? a->text : "");
  if (a->top_k > 0) {
    mpack_write_cstr(w, "top_k");
    mpack_write_int(w, a->top_k);
  }
  mpack_finish_map(w);
}

void mg_http_handler_search(mg_ctx_t *ctx, mg_http_request_t *req,
                            mg_http_response_t *resp) {
  char *text;
  char *top_k_s;
  search_args_t a;
  if (!ctx->config->http_ep_search) { mg_http_error(resp, 404, "endpoint disabled"); return; }
  text = mg_http_query_get(req, "text");
  if (!text) { mg_http_error(resp, 400, "missing text"); return; }
  top_k_s = mg_http_query_get(req, "top_k");
  a.text = text;
  a.top_k = top_k_s ? atoi(top_k_s) : 0;
  run_dispatch(ctx, "retrieve", build_search_args, &a, 200, resp);
  free(text);
  free(top_k_s);
}

/* ---------------- /v1/explore?text=...&depth=...&beam=...&keywords=a,b ---------------- */

typedef struct {
  const char *text;
  int depth;
  int beam;
  char  *keywords;       /* "a,b,c" or NULL */
} explore_args_t;

static void build_explore_args(mpack_writer_t *w, void *user) {
  explore_args_t *a = (explore_args_t *)user;
  int n_kw = 0;
  /* Count keywords */
  if (a->keywords && *a->keywords) {
    n_kw = 1;
    for (const char *p = a->keywords; *p; ++p) if (*p == ',') n_kw++;
  }
  int n_fields = 1
               + (a->depth > 0 ? 1 : 0)
               + (a->beam  > 0 ? 1 : 0)
               + (n_kw     > 0 ? 1 : 0);
  mpack_start_map(w, (uint32_t)n_fields);
  mpack_write_cstr(w, "text");
  mpack_write_cstr(w, a->text ? a->text : "");
  if (a->depth > 0) { mpack_write_cstr(w, "depth"); mpack_write_int(w, a->depth); }
  if (a->beam  > 0) { mpack_write_cstr(w, "beam_width"); mpack_write_int(w, a->beam); }
  if (n_kw > 0) {
    mpack_write_cstr(w, "keywords");
    mpack_start_array(w, (uint32_t)n_kw);
    char *p = a->keywords;
    while (p && *p) {
      char *comma = strchr(p, ',');
      if (comma) { *comma = '\0'; }
      mpack_write_cstr(w, p);
      if (!comma) break;
      *comma = ',';
      p = comma + 1;
    }
    mpack_finish_array(w);
  }
  mpack_finish_map(w);
}

void mg_http_handler_explore(mg_ctx_t *ctx, mg_http_request_t *req,
                             mg_http_response_t *resp) {
  char *text, *depth_s, *beam_s;
  explore_args_t a;
  if (!ctx->config->http_ep_explore) { mg_http_error(resp, 404, "endpoint disabled"); return; }
  text = mg_http_query_get(req, "text");
  if (!text) { mg_http_error(resp, 400, "missing text"); return; }
  depth_s = mg_http_query_get(req, "depth");
  beam_s  = mg_http_query_get(req, "beam");
  a.text = text;
  a.depth = depth_s ? atoi(depth_s) : 0;
  a.beam  = beam_s  ? atoi(beam_s)  : 0;
  a.keywords = mg_http_query_get(req, "keywords");
  run_dispatch(ctx, "explore", build_explore_args, &a, 200, resp);
  free(text);
  free(depth_s);
  free(beam_s);
  free(a.keywords);
}

/* ---------------- /v1/classify?text=... ---------------- */

static void build_classify_args(mpack_writer_t *w, void *user) {
  text_only_args_t *a = (text_only_args_t *)user;
  mpack_start_map(w, 1);
  mpack_write_cstr(w, "title");
  mpack_write_cstr(w, a->text ? a->text : "");
  mpack_finish_map(w);
}

void mg_http_handler_classify(mg_ctx_t *ctx, mg_http_request_t *req,
                              mg_http_response_t *resp) {
  char *text;
  text_only_args_t a;
  if (!ctx->config->http_ep_classify) { mg_http_error(resp, 404, "endpoint disabled"); return; }
  text = mg_http_query_get(req, "text");
  if (!text) { mg_http_error(resp, 400, "missing text"); return; }
  a.text = text;
  run_dispatch(ctx, "classify", build_classify_args, &a, 200, resp);
  free(text);
}

/* ---------------- /v1/insert  (POST JSON) ---------------- */

typedef struct {
  const char *title;
  const char *body;
  const char *author;       /* optional */
  long long   expires_at;   /* optional, 0 = none */
  const char *supersedes;   /* optional, hex id */
  /* keywords parsed inline from json — passed as a list of pointers into the
   * JSON buffer (we tokenize destructively in the caller). */
  char      **keywords;
  size_t      n_keywords;
} insert_args_t;

static void build_insert_args(mpack_writer_t *w, void *user) {
  insert_args_t *a = (insert_args_t *)user;
  int n_fields = 3
               + (a->author     ? 1 : 0)
               + (a->expires_at > 0 ? 1 : 0)
               + (a->supersedes ? 1 : 0);
  size_t i;
  mpack_start_map(w, (uint32_t)n_fields);
  mpack_write_cstr(w, "title"); mpack_write_cstr(w, a->title ? a->title : "");
  mpack_write_cstr(w, "body");  mpack_write_cstr(w, a->body  ? a->body  : "");
  mpack_write_cstr(w, "keywords");
  mpack_start_array(w, (uint32_t)a->n_keywords);
  for (i = 0; i < a->n_keywords; ++i) mpack_write_cstr(w, a->keywords[i]);
  mpack_finish_array(w);
  if (a->author) {
    mpack_write_cstr(w, "author");
    mpack_write_cstr(w, a->author);
  }
  if (a->expires_at > 0) {
    mpack_write_cstr(w, "expires_at");
    mpack_write_int(w, a->expires_at);
  }
  if (a->supersedes) {
    mpack_write_cstr(w, "supersedes");
    mpack_write_cstr(w, a->supersedes);
  }
  mpack_finish_map(w);
}

/* Tiny JSON extractor for the insert body. We only parse a flat object
 * with string/int/array-of-string values for our known fields — full JSON
 * parsing is overkill for the controlled POST body we accept.
 *
 * Returns: NULL on success, error message string on failure (caller uses
 * for 400). On success, populates *args by pointing into the body buffer
 * (which the caller MUST keep alive until run_dispatch finishes). */
static const char *parse_insert_body(char *body, size_t body_len,
                                     insert_args_t *args,
                                     char ***owned_kw_out, size_t *n_kw_out) {
  /* For brevity, we use a hand-rolled scanner. The accepted shape is:
   *   { "title": "...", "body": "...", "keywords": ["a","b"],
   *     "author": "...", "expires_at": 12345, "supersedes": "<hex>" }
   * with double-quoted strings and standard escapes. */
  (void)body_len;
  /* Only delegate to a separate parser if needed; for the simple shape we
   * scan top-level keys via search. The body MUST be NUL-terminated by the
   * caller (we malloc body_len + 1 and write '\0' at end in parse_request). */
  char *p = body;
  args->title = NULL;
  args->body = NULL;
  args->author = NULL;
  args->expires_at = 0;
  args->supersedes = NULL;
  args->keywords = NULL;
  args->n_keywords = 0;
  *owned_kw_out = NULL;
  *n_kw_out = 0;

  /* Skip whitespace to first '{' */
  while (*p && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
  if (*p != '{') return "expected JSON object";

  /* Field finder: returns pointer to value start of key="<name>" or NULL.
   * We do destructive in-place de-escaping for strings. */
  /* For simplicity, look for `"<name>"` patterns and scan forward. */
  /* This is intentionally minimal: it accepts well-formed inputs from our
   * own frontend and curl. Hostile inputs may produce garbage but never
   * UB — bounded by the body NUL terminator. */

  while (*p) {
    /* Find next '"' that starts a key */
    while (*p && *p != '"') p++;
    if (!*p) break;
    char *key_start = ++p;
    while (*p && *p != '"') {
      if (*p == '\\' && p[1]) p++;
      p++;
    }
    if (!*p) return "unterminated key";
    *p++ = '\0';  /* terminate key */
    /* Skip whitespace + colon */
    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return "expected ':' after key";
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;

    if (*p == '"') {
      /* string value */
      char *vstart = ++p, *w = vstart;
      while (*p && *p != '"') {
        if (*p == '\\' && p[1]) {
          p++;
          switch (*p) {
            case 'n': *w++ = '\n'; break;
            case 'r': *w++ = '\r'; break;
            case 't': *w++ = '\t'; break;
            case 'b': *w++ = '\b'; break;
            case 'f': *w++ = '\f'; break;
            case '"': *w++ = '"';  break;
            case '\\':*w++ = '\\'; break;
            case '/': *w++ = '/';  break;
            default:  *w++ = *p;   break;
          }
          p++;
        } else {
          *w++ = *p++;
        }
      }
      if (!*p) return "unterminated string";
      *w = '\0';
      p++;
      if      (strcmp(key_start, "title") == 0)      args->title = vstart;
      else if (strcmp(key_start, "body") == 0)       args->body = vstart;
      else if (strcmp(key_start, "author") == 0)     args->author = vstart;
      else if (strcmp(key_start, "supersedes") == 0) args->supersedes = vstart;
    } else if (*p == '[') {
      /* array of strings (keywords) */
      p++;
      char **kws = NULL;
      size_t cap = 0, n = 0;
      while (*p) {
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == ',') p++;
        if (*p == ']') { p++; break; }
        if (*p != '"') return "expected string in array";
        char *vstart = ++p, *w = vstart;
        while (*p && *p != '"') {
          if (*p == '\\' && p[1]) { p++; *w++ = *p++; }
          else                     *w++ = *p++;
        }
        if (!*p) return "unterminated string in array";
        *w = '\0';
        p++;
        if (n == cap) {
          size_t nc = cap ? cap * 2 : 8;
          char **nb = (char **)realloc(kws, nc * sizeof(*kws));
          if (!nb) { free(kws); return "oom"; }
          kws = nb; cap = nc;
        }
        kws[n++] = vstart;
      }
      if (strcmp(key_start, "keywords") == 0) {
        args->keywords = kws;
        args->n_keywords = n;
        *owned_kw_out = kws;
        *n_kw_out = n;
      } else {
        free(kws);
      }
    } else if ((*p >= '0' && *p <= '9') || *p == '-') {
      /* number value (we only use it for expires_at) */
      char *vstart = p;
      while ((*p >= '0' && *p <= '9') || *p == '-') p++;
      char saved = *p;
      *p = '\0';
      if (strcmp(key_start, "expires_at") == 0) {
        args->expires_at = atoll(vstart);
      }
      *p = saved;
    } else if (*p == 'n' && strncmp(p, "null", 4) == 0) {
      p += 4;  /* skip null */
    } else if (*p == 't' && strncmp(p, "true", 4) == 0) {
      p += 4;
    } else if (*p == 'f' && strncmp(p, "false", 5) == 0) {
      p += 5;
    }

    /* skip trailing comma/whitespace before next key */
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == ',') p++;
    if (*p == '}') break;
  }

  if (!args->title || !args->body) return "title and body required";
  return NULL;
}

void mg_http_handler_insert(mg_ctx_t *ctx, mg_http_request_t *req,
                            mg_http_response_t *resp) {
  insert_args_t a;
  const char *err;
  char **owned_kw = NULL;
  size_t n_kw = 0;

  if (!ctx->config->http_ep_insert) { mg_http_error(resp, 404, "endpoint disabled"); return; }
  if (!req->body || req->body_len == 0) {
    mg_http_error(resp, 400, "missing JSON body");
    return;
  }
  err = parse_insert_body((char *)req->body, req->body_len, &a, &owned_kw, &n_kw);
  if (err) {
    mg_http_error(resp, 400, err);
    free(owned_kw);
    return;
  }
  run_dispatch(ctx, "insert", build_insert_args, &a, 201, resp);
  free(owned_kw);
}

/* ---------------- DELETE /v1/nodes/{id_hex} ---------------- */

typedef struct {
  const char *id_hex;
} id_args_t;

static void build_id_args(mpack_writer_t *w, void *user) {
  id_args_t *a = (id_args_t *)user;
  mpack_start_map(w, 1);
  mpack_write_cstr(w, "id_hex");
  mpack_write_cstr(w, a->id_hex ? a->id_hex : "");
  mpack_finish_map(w);
}

void mg_http_handler_get(mg_ctx_t *ctx, mg_http_request_t *req,
                         mg_http_response_t *resp) {
  const char *prefix = "/v1/nodes/";
  size_t prefix_len = strlen(prefix);
  id_args_t a;
  if (!req->path || strncmp(req->path, prefix, prefix_len) != 0) {
    mg_http_error(resp, 404, "not found");
    return;
  }
  a.id_hex = req->path + prefix_len;
  if (strlen(a.id_hex) != 32) {
    mg_http_error(resp, 400, "id_hex must be 32 chars");
    return;
  }
  run_dispatch(ctx, "get", build_id_args, &a, 200, resp);
}

void mg_http_handler_delete(mg_ctx_t *ctx, mg_http_request_t *req,
                            mg_http_response_t *resp) {
  /* path is "/v1/nodes/<id_hex>" */
  const char *prefix = "/v1/nodes/";
  size_t prefix_len = strlen(prefix);
  id_args_t a;
  if (!ctx->config->http_ep_delete) { mg_http_error(resp, 404, "endpoint disabled"); return; }
  if (!req->path || strncmp(req->path, prefix, prefix_len) != 0) {
    mg_http_error(resp, 404, "not found");
    return;
  }
  a.id_hex = req->path + prefix_len;
  if (strlen(a.id_hex) != 32) {
    mg_http_error(resp, 400, "id_hex must be 32 chars");
    return;
  }
  run_dispatch(ctx, "delete", build_id_args, &a, 204, resp);
  /* On 204 the body should be empty per HTTP. We zero it. */
  if (resp->status == 204) {
    free(resp->body);
    resp->body = NULL;
    resp->body_len = 0;
  }
}

/* ---------------- /v1/view ---------------- */

void mg_http_handler_view(mg_ctx_t *ctx, mg_http_request_t *req,
                          mg_http_response_t *resp) {
  if (!ctx->config->http_ep_view) { mg_http_error(resp, 404, "endpoint disabled"); return; }
  (void)req;
  /* No args; the op produces a fully-formed result map. */
  run_dispatch(ctx, "view", NULL, NULL, 200, resp);
}
