/* Convert an mpack tree to compact JSON.
 *
 * The HTTP layer reuses the existing op handlers (which write mpack into a
 * response). To avoid duplicating the per-op serialization code in two
 * places, we encode the mpack response as JSON only at the wire boundary.
 *
 * Compact output (no pretty-printing) — frontend/curl handles formatting.
 */

#include "internal.h"
#include "mpack.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char  *buf;
  size_t len;
  size_t cap;
  int    err;
} sb_t;

static void sb_init(sb_t *sb) { memset(sb, 0, sizeof(*sb)); }

static void sb_free(sb_t *sb) { free(sb->buf); memset(sb, 0, sizeof(*sb)); }

static int sb_reserve(sb_t *sb, size_t add) {
  if (sb->err) return -1;
  if (sb->len + add + 1 > sb->cap) {
    size_t nc = sb->cap ? sb->cap * 2 : 256;
    while (nc < sb->len + add + 1) nc *= 2;
    char *nb = (char *)realloc(sb->buf, nc);
    if (!nb) { sb->err = 1; return -1; }
    sb->buf = nb;
    sb->cap = nc;
  }
  return 0;
}

static void sb_putc(sb_t *sb, char c) {
  if (sb_reserve(sb, 1) != 0) return;
  sb->buf[sb->len++] = c;
}

static void sb_puts(sb_t *sb, const char *s) {
  size_t n = strlen(s);
  if (sb_reserve(sb, n) != 0) return;
  memcpy(sb->buf + sb->len, s, n);
  sb->len += n;
}

static void sb_putn(sb_t *sb, const char *s, size_t n) {
  if (sb_reserve(sb, n) != 0) return;
  memcpy(sb->buf + sb->len, s, n);
  sb->len += n;
}

static void sb_putf(sb_t *sb, const char *fmt, ...) {
  char tmp[64];
  va_list ap;
  int n;
  va_start(ap, fmt);
  n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
  va_end(ap);
  if (n > 0 && (size_t)n < sizeof(tmp)) sb_putn(sb, tmp, (size_t)n);
}

static void emit_string(sb_t *sb, const char *s, size_t n) {
  size_t i;
  sb_putc(sb, '"');
  for (i = 0; i < n; ++i) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
      case '"':  sb_puts(sb, "\\\""); break;
      case '\\': sb_puts(sb, "\\\\"); break;
      case '\n': sb_puts(sb, "\\n");  break;
      case '\r': sb_puts(sb, "\\r");  break;
      case '\t': sb_puts(sb, "\\t");  break;
      case '\b': sb_puts(sb, "\\b");  break;
      case '\f': sb_puts(sb, "\\f");  break;
      default:
        if (c < 0x20) sb_putf(sb, "\\u%04x", c);
        else          sb_putc(sb, (char)c);
        break;
    }
  }
  sb_putc(sb, '"');
}

static void emit_value(sb_t *sb, mpack_node_t n);

static void emit_array(sb_t *sb, mpack_node_t n) {
  size_t i, len = mpack_node_array_length(n);
  sb_putc(sb, '[');
  for (i = 0; i < len; ++i) {
    if (i > 0) sb_putc(sb, ',');
    emit_value(sb, mpack_node_array_at(n, i));
  }
  sb_putc(sb, ']');
}

static void emit_map(sb_t *sb, mpack_node_t n) {
  size_t i, len = mpack_node_map_count(n);
  sb_putc(sb, '{');
  for (i = 0; i < len; ++i) {
    mpack_node_t k = mpack_node_map_key_at(n, i);
    mpack_node_t v = mpack_node_map_value_at(n, i);
    if (i > 0) sb_putc(sb, ',');
    if (mpack_node_type(k) == mpack_type_str) {
      emit_string(sb, mpack_node_str(k), mpack_node_strlen(k));
    } else {
      emit_value(sb, k);
    }
    sb_putc(sb, ':');
    emit_value(sb, v);
  }
  sb_putc(sb, '}');
}

static void emit_value(sb_t *sb, mpack_node_t n) {
  switch (mpack_node_type(n)) {
    case mpack_type_nil:   sb_puts(sb, "null"); break;
    case mpack_type_bool:  sb_puts(sb, mpack_node_bool(n) ? "true" : "false"); break;
    case mpack_type_int:   sb_putf(sb, "%lld", (long long)mpack_node_i64(n)); break;
    case mpack_type_uint:  sb_putf(sb, "%llu", (unsigned long long)mpack_node_u64(n)); break;
    case mpack_type_float: sb_putf(sb, "%g",   (double)mpack_node_float(n)); break;
    case mpack_type_double:sb_putf(sb, "%g",   mpack_node_double(n)); break;
    case mpack_type_str:   emit_string(sb, mpack_node_str(n), mpack_node_strlen(n)); break;
    case mpack_type_bin:   sb_puts(sb, "null"); break;  /* binary opaque to JSON */
    case mpack_type_array: emit_array(sb, n); break;
    case mpack_type_map:   emit_map(sb, n); break;
    default:               sb_puts(sb, "null"); break;
  }
}

mg_err_t mg_http_mpack_to_json(const void *mpack_buf, size_t mpack_len,
                               char **out, size_t *out_len) {
  mpack_tree_t tree;
  sb_t sb;

  if (!mpack_buf || !out || !out_len) return MG_ERR_INVALID_ARG;
  *out = NULL; *out_len = 0;

  mpack_tree_init_data(&tree, (const char *)mpack_buf, mpack_len);
  mpack_tree_parse(&tree);
  if (mpack_tree_error(&tree) != mpack_ok) {
    mpack_tree_destroy(&tree);
    return MG_ERR_INTERNAL;
  }

  sb_init(&sb);
  emit_value(&sb, mpack_tree_root(&tree));
  mpack_tree_destroy(&tree);

  if (sb.err) {
    sb_free(&sb);
    return MG_ERR_OOM;
  }
  if (sb_reserve(&sb, 0) != 0) {
    sb_free(&sb);
    return MG_ERR_OOM;
  }
  sb.buf[sb.len] = '\0';
  *out = sb.buf;
  *out_len = sb.len;
  return MG_OK;
}
