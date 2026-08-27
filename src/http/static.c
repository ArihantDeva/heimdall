/* Static file handler for the SPA bundle.
 *
 * Serves files from cfg->http_viewer_path. Path "/" maps to index.html;
 * paths under "/assets/..." are looked up directly. We intentionally do
 * NOT support directory listing or symlink traversal.
 *
 * This is enough to host a Vite-built SPA: one index.html + an immutable
 * /assets/ directory with hashed filenames.
 */

#include "internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static const char *guess_content_type(const char *path) {
  const char *dot = strrchr(path, '.');
  if (!dot) return "application/octet-stream";
  if (strcmp(dot, ".html") == 0) return "text/html; charset=utf-8";
  if (strcmp(dot, ".js")   == 0) return "application/javascript; charset=utf-8";
  if (strcmp(dot, ".mjs")  == 0) return "application/javascript; charset=utf-8";
  if (strcmp(dot, ".css")  == 0) return "text/css; charset=utf-8";
  if (strcmp(dot, ".json") == 0) return "application/json; charset=utf-8";
  if (strcmp(dot, ".svg")  == 0) return "image/svg+xml";
  if (strcmp(dot, ".png")  == 0) return "image/png";
  if (strcmp(dot, ".woff2")== 0) return "font/woff2";
  if (strcmp(dot, ".ico")  == 0) return "image/x-icon";
  return "application/octet-stream";
}

/* Reject paths that try to escape the root via "..". A purely defensive
 * check — we don't open the path itself unless it stays under the root. */
static int path_is_safe(const char *p) {
  if (!p) return 0;
  if (strstr(p, "..")) return 0;
  if (strchr(p, '\\')) return 0;     /* windows path separator not allowed in URL */
  return 1;
}

static char *read_whole_file(const char *path, size_t *out_len) {
  FILE *fp = fopen(path, "rb");
  long size;
  char *buf;
  if (!fp) return NULL;
  if (fseek(fp, 0, SEEK_END) != 0) { fclose(fp); return NULL; }
  size = ftell(fp);
  if (size < 0) { fclose(fp); return NULL; }
  rewind(fp);
  /* malloc(0) is implementation-defined (some libcs return NULL, which would
   * incorrectly signal a read error). Always allocate at least one byte so
   * callers receive a valid non-NULL pointer for empty files. */
  buf = (char *)malloc(size > 0 ? (size_t)size : 1);
  if (!buf) { fclose(fp); return NULL; }
  if (size > 0 && fread(buf, 1, (size_t)size, fp) != (size_t)size) {
    free(buf); fclose(fp); return NULL;
  }
  fclose(fp);
  *out_len = (size_t)size;
  return buf;
}

bool mg_http_try_static(mg_ctx_t *ctx, mg_http_request_t *req,
                        mg_http_response_t *resp) {
  const char *vpath;
  const char *url;
  char fs_path[1024];
  char *body;
  size_t body_len;

  if (!ctx || !ctx->config || !req) return false;
  if (strcmp(req->method ? req->method : "", "GET") != 0) return false;

  vpath = ctx->config->http_viewer_path;
  if (!vpath || !*vpath) return false;

  url = req->path ? req->path : "/";
  /* Only serve "/" or "/assets/..." or top-level static files (favicon etc.) */
  if (!path_is_safe(url)) return false;
  if (strcmp(url, "/") == 0) {
    snprintf(fs_path, sizeof(fs_path), "%s/index.html", vpath);
  } else if (strncmp(url, "/assets/", 8) == 0
          || strcmp(url, "/favicon.ico") == 0
          || strcmp(url, "/index.html") == 0) {
    snprintf(fs_path, sizeof(fs_path), "%s%s", vpath, url);
  } else {
    return false;  /* not ours */
  }

  body = read_whole_file(fs_path, &body_len);
  if (!body) {
    /* SPA fallback: unknown URL → return index.html so the client-side router can handle it. */
    if (strcmp(url, "/") != 0) return false;
    /* index.html itself is missing → the bundle isn't built. */
    mg_http_error(resp, 503,
                  "viewer bundle missing — run: cd viewer && npm install && npm run build");
    return true;
  }

  resp->status = 200;
  resp->content_type = (char *)guess_content_type(fs_path);
  resp->body = body;
  resp->body_len = body_len;
  return true;
}
