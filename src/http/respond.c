/* Minimal HTTP/1.1 response writer.
 *
 * Writes a single response (status line + headers + Content-Length-bounded
 * body) to the socket and closes after — no keep-alive. This keeps the
 * request/response loop simple at the cost of one TCP setup per call;
 * acceptable for a local-first tool.
 */

#include "internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#  include <winsock2.h>
typedef SOCKET mg_sock_t;
#else
#  include <sys/socket.h>
typedef int mg_sock_t;
#endif

void mg_http_response_init(mg_http_response_t *resp) {
  if (!resp) return;
  memset(resp, 0, sizeof(*resp));
  resp->status = 200;
  resp->content_type = (char *)"application/json";
}

void mg_http_response_free(mg_http_response_t *resp) {
  int i;
  if (!resp) return;
  free(resp->body);
  /* content_type is either a static literal or NULL — don't free */
  for (i = 0; i < resp->n_extra_headers * 2; i += 2) {
    /* extra header keys/values are static literals on our side; nothing to free. */
    (void)resp->extra_headers[i];
  }
  memset(resp, 0, sizeof(*resp));
}

void mg_http_response_set_json(mg_http_response_t *resp, int status,
                               void *body, size_t body_len) {
  if (!resp) return;
  resp->status = status;
  resp->content_type = (char *)"application/json; charset=utf-8";
  resp->body = body;
  resp->body_len = body_len;
}

void mg_http_response_set_text(mg_http_response_t *resp, int status,
                               const char *body) {
  size_t n;
  char *copy;
  if (!resp || !body) return;
  n = strlen(body);
  copy = (char *)malloc(n);
  if (!copy) return;
  memcpy(copy, body, n);
  resp->status = status;
  resp->content_type = (char *)"text/plain; charset=utf-8";
  resp->body = copy;
  resp->body_len = n;
}

static const char *reason_phrase(int status) {
  switch (status) {
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    case 304: return "Not Modified";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 413: return "Payload Too Large";
    case 415: return "Unsupported Media Type";
    case 500: return "Internal Server Error";
    case 503: return "Service Unavailable";
    default:  return "OK";
  }
}

static int send_all(int fd, const char *buf, size_t n) {
  size_t sent = 0;
  while (sent < n) {
    int w = send((mg_sock_t)fd, buf + sent, (int)(n - sent), 0);
    if (w <= 0) return -1;
    sent += (size_t)w;
  }
  return 0;
}

mg_err_t mg_http_send_response(int fd, const mg_http_response_t *resp) {
  char head[2048];
  int n, i;
  const char *ct;

  if (!resp) return MG_ERR_INVALID_ARG;

  ct = resp->content_type ? resp->content_type : "application/octet-stream";

  n = snprintf(head, sizeof(head),
               "HTTP/1.1 %d %s\r\n"
               "Content-Type: %s\r\n"
               "Content-Length: %zu\r\n"
               "Connection: close\r\n"
               "Server: graftd\r\n",
               resp->status, reason_phrase(resp->status),
               ct, resp->body_len);
  if (n < 0 || (size_t)n >= sizeof(head)) return MG_ERR_INTERNAL;

  for (i = 0; i < resp->n_extra_headers && (size_t)n < sizeof(head) - 4; ++i) {
    int m = snprintf(head + n, sizeof(head) - (size_t)n,
                     "%s: %s\r\n",
                     resp->extra_headers[i * 2],
                     resp->extra_headers[i * 2 + 1]);
    if (m < 0) return MG_ERR_INTERNAL;
    n += m;
  }
  if ((size_t)n + 2 >= sizeof(head)) return MG_ERR_INTERNAL;
  head[n++] = '\r'; head[n++] = '\n';

  if (send_all(fd, head, (size_t)n) != 0) return MG_ERR_IO;
  if (resp->body_len > 0 && resp->body) {
    if (send_all(fd, (const char *)resp->body, resp->body_len) != 0)
      return MG_ERR_IO;
  }
  return MG_OK;
}
