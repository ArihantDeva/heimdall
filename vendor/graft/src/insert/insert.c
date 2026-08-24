#include "graft/ops.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

mg_err_t mg_insert_build_edges_from_embedding(
  mg_storage_t *s,
  const mg_config_t *cfg,
  const mg_node_id_t src,
  const mg_embedding_t q,
  const mg_keyword_id_t *kw_ids,
  size_t n_kw,
  mg_edge_t **out_edges,
  size_t *out_n_edges,
  size_t *out_n_kw_edges,
  size_t *out_n_sem_edges
);

static mg_err_t copy_msgpack_string(mpack_node_t map, const char *key, char **out) {
  if (!key || !out) {
    return MG_ERR_INVALID_ARG;
  }

  mpack_node_t node = mpack_node_map_cstr(map, key);
  if (mpack_node_type(node) != mpack_type_str) {
    return MG_ERR_INVALID_ARG;
  }

  size_t len = mpack_node_strlen(node);
  char *copy = (char *)malloc(len + 1u);
  if (!copy) {
    return MG_ERR_OOM;
  }
  memcpy(copy, mpack_node_str(node), len);
  copy[len] = '\0';

  if (len == 0u) {
    free(copy);
    return MG_ERR_INVALID_ARG;
  }

  *out = copy;
  return MG_OK;
}

static int cmp_cstr_ptr(const void *a, const void *b) {
  const char *const *sa = (const char *const *)a;
  const char *const *sb = (const char *const *)b;
  return strcmp(*sa, *sb);
}

static mg_err_t parse_keywords(mpack_node_t args, char ***out_keywords, size_t *out_count) {
  if (!out_keywords || !out_count) {
    return MG_ERR_INVALID_ARG;
  }

  mpack_node_t arr = mpack_node_map_cstr(args, "keywords");
  if (mpack_node_type(arr) != mpack_type_array) {
    return MG_ERR_INVALID_ARG;
  }

  size_t count = mpack_node_array_length(arr);
  char **keywords = NULL;
  if (count > 0u) {
    keywords = (char **)calloc(count, sizeof(*keywords));
    if (!keywords) {
      return MG_ERR_OOM;
    }
  }

  for (size_t i = 0u; i < count; ++i) {
    mpack_node_t item = mpack_node_array_at(arr, i);
    if (mpack_node_type(item) != mpack_type_str) {
      for (size_t j = 0u; j < i; ++j) {
        free(keywords[j]);
      }
      free(keywords);
      return MG_ERR_INVALID_ARG;
    }

    size_t len = mpack_node_strlen(item);
    if (len == 0u) {
      for (size_t j = 0u; j < i; ++j) {
        free(keywords[j]);
      }
      free(keywords);
      return MG_ERR_INVALID_ARG;
    }

    keywords[i] = (char *)malloc(len + 1u);
    if (!keywords[i]) {
      for (size_t j = 0u; j < i; ++j) {
        free(keywords[j]);
      }
      free(keywords);
      return MG_ERR_OOM;
    }
    memcpy(keywords[i], mpack_node_str(item), len);
    keywords[i][len] = '\0';
  }

  *out_keywords = keywords;
  *out_count = count;
  return MG_OK;
}

static void free_keywords(char **keywords, size_t count) {
  if (!keywords) {
    return;
  }
  for (size_t i = 0u; i < count; ++i) {
    free(keywords[i]);
  }
  free(keywords);
}

/* Content hash covers title + body + sorted keywords. Author and dates are
 * intentionally NOT hashed: the same node saved by different authors or at
 * different times should still dedupe on identical content. */
static mg_err_t build_content_hash(
  const char *title,
  const char *body,
  char **keywords,
  size_t n_keywords,
  mg_hash_t out
) {
  size_t total = strlen(title) + 1u + strlen(body) + 1u;
  for (size_t i = 0u; i < n_keywords; ++i) {
    total += strlen(keywords[i]);
    if (i + 1u < n_keywords) {
      total += 1u;
    }
  }

  char *buf = (char *)malloc(total);
  if (!buf) {
    return MG_ERR_OOM;
  }

  qsort(keywords, n_keywords, sizeof(*keywords), cmp_cstr_ptr);

  size_t pos = 0u;
  size_t len = strlen(title);
  memcpy(buf + pos, title, len);
  pos += len;
  buf[pos++] = '\0';

  len = strlen(body);
  memcpy(buf + pos, body, len);
  pos += len;
  buf[pos++] = '\0';

  for (size_t i = 0u; i < n_keywords; ++i) {
    len = strlen(keywords[i]);
    memcpy(buf + pos, keywords[i], len);
    pos += len;
    if (i + 1u < n_keywords) {
      buf[pos++] = ',';
    }
  }

  mg_blake3((const uint8_t *)buf, pos, out);
  free(buf);
  return MG_OK;
}

static int64_t now_unix_ms(void) {
  return (int64_t)time(NULL) * 1000;
}

static void write_id_hex(const mg_node_id_t id, char out[33]) {
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0u; i < MG_NODE_ID_BYTES; ++i) {
    out[i * 2u] = hex[(id[i] >> 4) & 0x0f];
    out[i * 2u + 1u] = hex[id[i] & 0x0f];
  }
  out[32] = '\0';
}

static void write_insert_result(
  mpack_writer_t *result,
  const mg_node_id_t id,
  size_t n_kw_edges,
  size_t n_sem_edges,
  bool duplicate
) {
  char id_hex[33];
  write_id_hex(id, id_hex);

  mpack_start_map(result, 5);
  mpack_write_cstr(result, "id");
  mpack_write_bin(result, (const char *)id, MG_NODE_ID_BYTES);
  mpack_write_cstr(result, "id_hex");
  mpack_write_cstr(result, id_hex);
  mpack_write_cstr(result, "n_kw_edges");
  mpack_write_u64(result, (uint64_t)n_kw_edges);
  mpack_write_cstr(result, "n_sem_edges");
  mpack_write_u64(result, (uint64_t)n_sem_edges);
  mpack_write_cstr(result, "duplicate");
  mpack_write_bool(result, duplicate);
  mpack_finish_map(result);
}

mg_err_t mg_op_insert(mg_ctx_t *ctx, mpack_node_t args, mpack_writer_t *result) {
  if (!ctx || !ctx->storage || !ctx->embed || !ctx->config || !result) {
    return MG_ERR_INVALID_ARG;
  }

  char *title = NULL;
  char *body = NULL;
  char *author = NULL;
  char **keywords = NULL;
  size_t n_keywords = 0u;
  int64_t expires_at = 0;
  mg_node_id_t supersedes_id;
  bool has_supersedes = false;

  mg_err_t err = copy_msgpack_string(args, "title", &title);
  if (err != MG_OK) {
    return err;
  }
  err = copy_msgpack_string(args, "body", &body);
  if (err != MG_OK) {
    free(title);
    return err;
  }
  /* Optional fields. Author is empty/missing → NULL on the node. */
  {
    mpack_node_t a = mpack_node_map_cstr_optional(args, "author");
    if (!mpack_node_is_missing(a) && !mpack_node_is_nil(a)) {
      const char *s = mpack_node_str(a);
      uint32_t n = (uint32_t)mpack_node_strlen(a);
      if (s && n > 0u) {
        author = (char *)malloc((size_t)n + 1u);
        if (author) { memcpy(author, s, n); author[n] = '\0'; }
      }
    }
    mpack_node_t e = mpack_node_map_cstr_optional(args, "expires_at");
    if (!mpack_node_is_missing(e) && !mpack_node_is_nil(e)) {
      expires_at = (int64_t)mpack_node_i64(e);
      if (expires_at < 0) expires_at = 0;
    }
    /* Optional supersedes: hex node id whose content this insert replaces. */
    mpack_node_t sup = mpack_node_map_cstr_optional(args, "supersedes");
    if (!mpack_node_is_missing(sup) && !mpack_node_is_nil(sup)
        && mpack_node_type(sup) == mpack_type_str) {
      const char *hex = mpack_node_str(sup);
      uint32_t hex_n  = (uint32_t)mpack_node_strlen(sup);
      if (hex_n == 2 * MG_NODE_ID_BYTES) {
        size_t j;
        bool ok = true;
        for (j = 0; j < MG_NODE_ID_BYTES; ++j) {
          int hi = -1, lo = -1;
          char c = hex[j * 2];
          if      (c >= '0' && c <= '9') hi = c - '0';
          else if (c >= 'a' && c <= 'f') hi = c - 'a' + 10;
          else if (c >= 'A' && c <= 'F') hi = c - 'A' + 10;
          c = hex[j * 2 + 1];
          if      (c >= '0' && c <= '9') lo = c - '0';
          else if (c >= 'a' && c <= 'f') lo = c - 'a' + 10;
          else if (c >= 'A' && c <= 'F') lo = c - 'A' + 10;
          if (hi < 0 || lo < 0) { ok = false; break; }
          supersedes_id[j] = (uint8_t)((hi << 4) | lo);
        }
        has_supersedes = ok;
      }
    }
  }
  err = parse_keywords(args, &keywords, &n_keywords);
  if (err != MG_OK) {
    free(title);
    free(body);
    free(author);
    return err;
  }

  mg_hash_t content_hash;
  err = build_content_hash(title, body, keywords, n_keywords, content_hash);
  if (err != MG_OK) {
    free_keywords(keywords, n_keywords);
    free(title);
    free(body);
    free(author);
    return err;
  }

  mg_node_id_t existing_id;
  err = mg_storage_node_id_by_hash(ctx->storage, content_hash, existing_id);
  if (err == MG_OK) {
    write_insert_result(result, existing_id, 0u, 0u, true);
    free_keywords(keywords, n_keywords);
    free(title);
    free(body);
    free(author);
    return MG_OK;
  }
  if (err != MG_ERR_NOT_FOUND) {
    free_keywords(keywords, n_keywords);
    free(title);
    free(body);
    free(author);
    return err;
  }

  mg_node_t node;
  memset(&node, 0, sizeof(node));
  mg_uuidv7(node.id);
  memcpy(node.content_hash, content_hash, MG_HASH_BYTES);

  /* Embed title+body so the vector lane carries content, not just a
   * heading. Titles like "session <id> — <date>" are content-free, which
   * made vector top-k useless for content queries (LongMemEval analysis).
   * Body may be long; BGE-M3 mean-pools across the token window, which is
   * exactly what we want for a whole-session vector. */
  mg_embedding_t q;
  char *embed_text = NULL;
  if (body && body[0]) {
    size_t tlen = strlen(title), blen = strlen(body);
    if (tlen > 0 && tlen + blen + 2 < (size_t)INT32_MAX) {
      embed_text = (char *)malloc(tlen + blen + 2);
      if (embed_text) {
        memcpy(embed_text, title, tlen);
        embed_text[tlen] = '\n';
        memcpy(embed_text + tlen + 1, body, blen);
        embed_text[tlen + 1 + blen] = '\0';
      }
    }
  }
  err = mg_embed_text(ctx->embed, embed_text ? embed_text : (title ? title : ""), q);
  free(embed_text);
  if (err != MG_OK) {
    free_keywords(keywords, n_keywords);
    free(title);
    free(body);
    free(author);
    return err;
  }

  mg_keyword_id_t *kw_ids = NULL;
  if (n_keywords > 0u) {
    kw_ids = (mg_keyword_id_t *)calloc(n_keywords, sizeof(*kw_ids));
    if (!kw_ids) {
      free_keywords(keywords, n_keywords);
      free(title);
      free(body);
      free(author);
      return MG_ERR_OOM;
    }
  }

  for (size_t i = 0u; i < n_keywords; ++i) {
    err = mg_storage_upsert_keyword(ctx->storage, keywords[i], NULL, &kw_ids[i]);
    if (err != MG_OK) {
      free(kw_ids);
      free_keywords(keywords, n_keywords);
      free(title);
      free(body);
      free(author);
      return err;
    }
  }

  mg_edge_t *edges = NULL;
  size_t n_edges = 0u;
  size_t n_kw_edges = 0u;
  size_t n_sem_edges = 0u;
  err = mg_insert_build_edges_from_embedding(
    ctx->storage,
    ctx->config,
    node.id,
    q,
    kw_ids,
    n_keywords,
    &edges,
    &n_edges,
    &n_kw_edges,
    &n_sem_edges
  );
  if (err != MG_OK) {
    free(edges);
    free(kw_ids);
    free_keywords(keywords, n_keywords);
    free(title);
    free(body);
    free(author);
    return err;
  }

  int64_t now = now_unix_ms();
  node.title = title;
  node.body = body;
  node.author = author;
  node.created_at = now;
  node.expires_at = expires_at;
  node.last_access = now;
  node.access_count = 0;
  node.state = MG_NODE_ACTIVE;

  err = mg_storage_insert_node_with_edges(ctx->storage, &node, q, kw_ids, n_keywords, edges, n_edges,
                                           has_supersedes ? (const mg_node_id_t *)&supersedes_id : NULL);
  if (err == MG_OK) {
    write_insert_result(result, node.id, n_kw_edges, n_sem_edges, false);
  }

  free(edges);
  free(kw_ids);
  free_keywords(keywords, n_keywords);
  free(title);
  free(body);
  free(author);
  return err;
}
