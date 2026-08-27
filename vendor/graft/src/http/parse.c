/* Minimal HTTP/1.1 request parser.
 *
 * Reads from a connected socket, parses the request line + headers + optional
 * Content-Length-bounded body, and produces a populated mg_http_request_t.
 * No keep-alive, no chunked, no multipart — local-only REST surface keeps
 * the surface tiny on purpose.
 */

#include "internal.h"

#include <ctype.h>
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

static char *mg_strdup_n(const char *s, size_t n) {
  char *out = (char *)malloc(n + 1);
  if (!out) return NULL;
  memcpy(out, s, n);
  out[n] = '\0';
  return out;
}

static void rstrip_ws(char *s) {
  size_t n = strlen(s);
  while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\t')) {
    s[--n] = '\0';
  }
}

static char *lstrip_ws(char *s) {
  while (*s == ' ' || *s == '\t') s++;
  return s;
}

void mg_http_request_free(mg_http_request_t *req) {
  int i;
  if (!req) return;
  free(req->method);
  free(req->path);
  free(req->query);
  for (i = 0; i < req->n_headers; ++i) {
    free(req->headers[i].name);
    free(req->headers[i].value);
  }
  free(req->body);
  memset(req, 0, sizeof(*req));
}

const char *mg_http_header_get(const mg_http_request_t *req, const char *name) {
  int i;
  if (!req || !name) return NULL;
  for (i = 0; i < req->n_headers; ++i) {
    /* HTTP header names are case-insensitive */
#ifdef _WIN32
    if (_stricmp(req->headers[i].name, name) == 0) return req->headers[i].value;
#else
    if (strcasecmp(req->headers[i].name, name) == 0) return req->headers[i].value;
#endif
  }
  return NULL;
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Decode percent-encoded UTF-8 in-place into a freshly malloc'd buffer.
 * Treats '+' as space (form-urlencoded compat). */
static char *url_decode(const char *src, size_t n) {
  char *out = (char *)malloc(n + 1);
  size_t i, w = 0;
  if (!out) return NULL;
  for (i = 0; i < n; ++i) {
    char c = src[i];
    if (c == '+') {
      out[w++] = ' ';
    } else if (c == '%' && i + 2 < n) {
      int hi = hex_nibble(src[i + 1]);
      int lo = hex_nibble(src[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out[w++] = (char)((hi << 4) | lo);
        i += 2;
      } else {
        out[w++] = c;
      }
    } else {
      out[w++] = c;
    }
  }
  out[w] = '\0';
  return out;
}

char *mg_http_query_get(const mg_http_request_t *req, const char *name) {
  const char *q;
  size_t name_len;
  if (!req || !req->query || !name) return NULL;
  q = req->query;
  name_len = strlen(name);
  while (*q) {
    const char *eq = strchr(q, '=');
    const char *amp = strchr(q, '&');
    const char *end = amp ? amp : q + strlen(q);
    if (eq && eq < end) {
      size_t k_len = (size_t)(eq - q);
      if (k_len == name_len && memcmp(q, name, name_len) == 0) {
        return url_decode(eq + 1, (size_t)(end - eq - 1));
      }
    }
    if (!amp) break;
    q = amp + 1;
  }
  return NULL;
}

/* Read until the "\r\n\r\n" header terminator. Caps at MG_HTTP_MAX_HEADER_BYTES.
 * On success returns the byte offset where the body starts (i.e. just past
 * the terminator). *out is the malloc'd buffer with all bytes read so far
 * (which may already include some body bytes — caller pulls those out). */
static int read_headers(int fd, char **out, size_t *out_len) {
  char *buf = (char *)malloc(MG_HTTP_MAX_HEADER_BYTES);
  size_t total = 0;
  size_t scanned = 0;
  if (!buf) return -1;
  while (total < MG_HTTP_MAX_HEADER_BYTES) {
    int n = recv((mg_sock_t)fd, buf + total,
                 (int)(MG_HTTP_MAX_HEADER_BYTES - total), 0);
    if (n <= 0) { free(buf); return -1; }
    total += (size_t)n;
    /* Scan only the new region (back up by 3 to catch sequences that span
     * the previous chunk boundary). */
    size_t start = scanned > 3 ? scanned - 3 : 0;
    for (size_t i = start; i + 3 < total; ++i) {
      if (buf[i] == '\r' && buf[i + 1] == '\n'
          && buf[i + 2] == '\r' && buf[i + 3] == '\n') {
        *out = buf;
        *out_len = total;
        return (int)(i + 4);   /* first byte past "\r\n\r\n" */
      }
    }
    scanned = total;
  }
  free(buf);
  return -1;
}

mg_err_t mg_http_parse_request(int fd, mg_http_request_t *req) {
  char *raw = NULL;
  size_t raw_len = 0;
  int header_end;
  char *line, *next, *p;
  size_t body_len_total = 0;
  size_t body_pre = 0;
  const char *cl;

  if (!req) return MG_ERR_INVALID_ARG;
  memset(req, 0, sizeof(*req));

  header_end = read_headers(fd, &raw, &raw_len);
  if (header_end < 0) {
    free(raw);
    return MG_ERR_IO;
  }

  /* Parse request line: "<method> <path>[?<query>] HTTP/1.1\r\n" */
  line = raw;
  next = strstr(line, "\r\n");
  if (!next) { free(raw); return MG_ERR_IO; }
  *next = '\0';

  p = strchr(line, ' ');
  if (!p) { free(raw); return MG_ERR_IO; }
  *p = '\0';
  req->method = mg_strdup_n(line, strlen(line));

  line = p + 1;
  p = strchr(line, ' ');
  if (!p) { free(raw); mg_http_request_free(req); return MG_ERR_IO; }
  *p = '\0';
  /* Split path?query */
  {
    char *q = strchr(line, '?');
    if (q) {
      *q = '\0';
      req->path = mg_strdup_n(line, strlen(line));
      req->query = mg_strdup_n(q + 1, strlen(q + 1));
    } else {
      req->path = mg_strdup_n(line, strlen(line));
      req->query = NULL;
    }
  }

  /* Headers */
  line = next + 2;
  while (line < raw + header_end) {
    next = strstr(line, "\r\n");
    if (!next) break;
    if (next == line) break;  /* empty line = end of headers */
    *next = '\0';
    {
      char *colon = strchr(line, ':');
      if (colon && req->n_headers < MG_HTTP_MAX_HEADERS) {
        *colon = '\0';
        req->headers[req->n_headers].name  = mg_strdup_n(line, strlen(line));
        rstrip_ws(req->headers[req->n_headers].name);
        char *v = lstrip_ws(colon + 1);
        rstrip_ws(v);
        req->headers[req->n_headers].value = mg_strdup_n(v, strlen(v));
        req->n_headers++;
      }
    }
    line = next + 2;
  }

  /* Body, bounded by Content-Length */
  cl = mg_http_header_get(req, "Content-Length");
  if (cl) {
    long long n = atoll(cl);
    if (n < 0 || (size_t)n > MG_HTTP_MAX_REQUEST_BYTES) {
      free(raw);
      mg_http_request_free(req);
      return MG_ERR_INVALID_ARG;
    }
    body_len_total = (size_t)n;
  }

  if (body_len_total > 0) {
    char *body = (char *)malloc(body_len_total + 1);
    if (!body) { free(raw); mg_http_request_free(req); return MG_ERR_OOM; }
    body_pre = raw_len - (size_t)header_end;
    if (body_pre > body_len_total) body_pre = body_len_total;
    memcpy(body, raw + header_end, body_pre);
    while (body_pre < body_len_total) {
      int n = recv((mg_sock_t)fd, body + body_pre,
                   (int)(body_len_total - body_pre), 0);
      if (n <= 0) {
        free(body);
        free(raw);
        mg_http_request_free(req);
        return MG_ERR_IO;
      }
      body_pre += (size_t)n;
    }
    body[body_len_total] = '\0';
    req->body = body;
    req->body_len = body_len_total;
  }

  free(raw);
  return MG_OK;
}
