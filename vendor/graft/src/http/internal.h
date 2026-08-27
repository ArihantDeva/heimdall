#ifndef MG_HTTP_INTERNAL_H
#define MG_HTTP_INTERNAL_H

#include "graft/error.h"
#include "graft/ops.h"

#include <stddef.h>
#include <stdbool.h>

#define MG_HTTP_MAX_HEADERS       32
#define MG_HTTP_MAX_REQUEST_BYTES (1 * 1024 * 1024)  /* 1 MiB cap */
#define MG_HTTP_MAX_HEADER_BYTES  16384

typedef struct {
  char *name;
  char *value;
} mg_http_header_t;

typedef struct {
  char            *method;       /* "GET", "POST", "DELETE", ... */
  char            *path;         /* "/v1/match" */
  char            *query;        /* "text=...&top_k=10" or NULL */
  mg_http_header_t headers[MG_HTTP_MAX_HEADERS];
  int              n_headers;
  void            *body;         /* malloc'd; may be NULL */
  size_t           body_len;
} mg_http_request_t;

typedef struct {
  int    status;                 /* 200, 404, etc. */
  char  *content_type;           /* "application/json", "text/html", ... */
  void  *body;                   /* malloc'd; may be NULL */
  size_t body_len;
  /* Optional extra headers, NULL-terminated key/value pairs */
  char  *extra_headers[8 * 2];
  int    n_extra_headers;
} mg_http_response_t;

/* parse.c */
mg_err_t mg_http_parse_request(int fd, mg_http_request_t *req);
void     mg_http_request_free(mg_http_request_t *req);
const char *mg_http_header_get(const mg_http_request_t *req, const char *name);
/* URL-decode a query parameter into out_buf (NUL-terminated). Returns NULL
 * if the parameter is missing. The buffer must be sized to fit the decoded
 * value; we cap at the source length. */
char *mg_http_query_get(const mg_http_request_t *req, const char *name);

/* respond.c */
mg_err_t mg_http_send_response(int fd, const mg_http_response_t *resp);
void     mg_http_response_init(mg_http_response_t *resp);
void     mg_http_response_free(mg_http_response_t *resp);
void     mg_http_response_set_json(mg_http_response_t *resp, int status,
                                   void *body, size_t body_len);
void     mg_http_response_set_text(mg_http_response_t *resp, int status,
                                   const char *body);

/* json.c */
/* Convert an mpack response (the {status, result|error} root map produced by
 * mg_dispatch) into a malloc'd UTF-8 JSON byte buffer. *out_len excludes the
 * trailing NUL. */
mg_err_t mg_http_mpack_to_json(const void *mpack_buf, size_t mpack_len,
                               char **out, size_t *out_len);

/* handlers.c */
typedef void (*mg_http_handler_fn)(mg_ctx_t *ctx,
                                   mg_http_request_t *req,
                                   mg_http_response_t *resp);

void mg_http_handler_healthz (mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);
void mg_http_handler_match   (mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);
void mg_http_handler_search  (mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);
void mg_http_handler_explore (mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);
void mg_http_handler_classify(mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);
void mg_http_handler_insert  (mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);
void mg_http_handler_get     (mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);
void mg_http_handler_delete  (mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);
void mg_http_handler_view    (mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);

/* Convenience: respond with a status + minimal JSON {error: "..."} body. */
void mg_http_error(mg_http_response_t *resp, int status, const char *msg);

/* Static file fallback for the viewer SPA. Returns true when a static asset
 * was found and the response was populated. False means "not ours, route
 * to API handlers instead". */
bool mg_http_try_static(mg_ctx_t *ctx, mg_http_request_t *req, mg_http_response_t *resp);

#endif
