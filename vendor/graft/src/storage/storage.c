#include "graft/storage.h"

#include <sqlite3.h>

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef _WIN32
#include <sys/stat.h>
#endif

extern int sqlite3_vec_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi);
extern const char *mg_storage_schema_sql(void);
extern const char *mg_storage_migration_v2_sql(void);
extern const char *mg_storage_migration_v3_sql(void);

struct mg_storage {
  sqlite3 *db;
};

static char *mg_strdup(const char *s) {
  size_t n;
  char *out;
  if (!s) {
    return NULL;
  }
  n = strlen(s) + 1;
  out = (char *)malloc(n);
  if (!out) {
    return NULL;
  }
  memcpy(out, s, n);
  return out;
}

static int64_t now_ms(void) {
  return (int64_t)time(NULL) * 1000;
}

static mg_err_t exec_sql(sqlite3 *db, const char *sql) {
  char *err = NULL;
  int rc = sqlite3_exec(db, sql, NULL, NULL, &err);
  if (rc != SQLITE_OK) {
    sqlite3_free(err);
    return MG_ERR_STORAGE;
  }
  return MG_OK;
}

static mg_err_t step_done(sqlite3_stmt *stmt) {
  int rc = sqlite3_step(stmt);
  if (rc == SQLITE_DONE) {
    return MG_OK;
  }
  if (rc == SQLITE_CONSTRAINT) {
    return MG_ERR_DUPLICATE;
  }
  return MG_ERR_STORAGE;
}

static mg_err_t prepare(sqlite3 *db, const char *sql, sqlite3_stmt **stmt) {
  return sqlite3_prepare_v2(db, sql, -1, stmt, NULL) == SQLITE_OK ? MG_OK : MG_ERR_STORAGE;
}

static float cosine_score(const float *a, const float *b) {
  double dot = 0.0;
  double na = 0.0;
  double nb = 0.0;
  size_t i;
  for (i = 0; i < MG_EMBEDDING_DIM; ++i) {
    dot += (double)a[i] * (double)b[i];
    na += (double)a[i] * (double)a[i];
    nb += (double)b[i] * (double)b[i];
  }
  if (na <= 0.0 || nb <= 0.0) {
    return 0.0f;
  }
  return (float)(dot / (sqrt(na) * sqrt(nb)));
}

static void push_topk(mg_node_score_t *out, int *count, int k, const void *id, float score) {
  int pos;
  int limit;
  if (k <= 0) {
    return;
  }
  pos = *count;
  if (pos < k) {
    ++(*count);
  } else if (score <= out[k - 1].score) {
    return;
  } else {
    pos = k - 1;
  }
  while (pos > 0 && out[pos - 1].score < score) {
    out[pos] = out[pos - 1];
    --pos;
  }
  memcpy(out[pos].id, id, MG_NODE_ID_BYTES);
  out[pos].score = score;
  limit = *count < k ? *count : k;
  *count = limit;
}

static mg_err_t create_vec_table(sqlite3 *db) {
  mg_err_t err = exec_sql(db,
    "CREATE VIRTUAL TABLE IF NOT EXISTS node_vec USING vec0("
    "id BLOB PRIMARY KEY, embedding FLOAT[1024]);");
  if (err == MG_OK) {
    return MG_OK;
  }
  return exec_sql(db,
    "CREATE TABLE IF NOT EXISTS node_vec("
    "id BLOB PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,"
    "embedding BLOB NOT NULL);");
}

mg_err_t mg_storage_open(const char *db_path, mg_storage_t **out) {
  static int initialized = 0;
  mg_storage_t *s;

  if (!db_path || !out) {
    return MG_ERR_INVALID_ARG;
  }
  *out = NULL;
  if (!initialized) {
    sqlite3_auto_extension((void (*)(void))sqlite3_vec_init);
    initialized = 1;
  }
  s = (mg_storage_t *)calloc(1, sizeof(*s));
  if (!s) {
    return MG_ERR_OOM;
  }
  if (sqlite3_open_v2(db_path, &s->db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, NULL) != SQLITE_OK) {
    mg_storage_close(s);
    return MG_ERR_STORAGE;
  }
#ifndef _WIN32
  /* Restrict the DB file to the owner. The file holds embeddings, FTS data,
   * and usage history — treat it as secret. SQLite may have created it with
   * the default umask (often world-readable on POSIX); force 0600 after open
   * regardless of umask. Errors are non-fatal: the daemon can still operate,
   * but log so operators notice if the FS rejects the chmod (rare). */
  if (chmod(db_path, S_IRUSR | S_IWUSR) != 0) {
    fprintf(stderr,
            "graft: warning: chmod(0600) on db file failed (%s)\n",
            db_path);
  }
#endif
  /* Optional encryption-at-rest via SQLCipher. When GRAFT_DB_KEY is set,
   * apply PRAGMA key as the first statement on the connection (SQLCipher
   * requires this BEFORE any other access). Then probe PRAGMA cipher_version
   * to confirm the linked sqlite is actually SQLCipher — vanilla sqlite
   * silently ignores PRAGMA key, leaving the DB unencrypted. We log the
   * mismatch loudly so operators don't get a false sense of security.
   * Leaving GRAFT_DB_KEY unset preserves the legacy unencrypted behaviour. */
  {
    const char *key = getenv("GRAFT_DB_KEY");
    if (key && *key) {
      char *pragma = NULL;
      sqlite3_stmt *probe = NULL;
      size_t klen = strlen(key);
      pragma = (char *)malloc(klen + 32u);
      if (pragma) {
        /* Single-quote the key and double any embedded single quotes to keep
         * the PRAGMA syntactically valid. */
        char *dst = pragma;
        const char *src = key;
        dst += sprintf(dst, "PRAGMA key='");
        while (*src) {
          if (*src == '\'') { *dst++ = '\''; *dst++ = '\''; }
          else              { *dst++ = *src; }
          ++src;
        }
        *dst++ = '\'';
        *dst++ = ';';
        *dst   = '\0';
        if (sqlite3_exec(s->db, pragma, NULL, NULL, NULL) != SQLITE_OK) {
          fprintf(stderr, "graft: warning: PRAGMA key failed — DB is NOT encrypted\n");
        }
        free(pragma);
      }
      if (sqlite3_prepare_v2(s->db, "PRAGMA cipher_version;", -1, &probe, NULL) == SQLITE_OK) {
        int has_cipher = (sqlite3_step(probe) == SQLITE_ROW &&
                          sqlite3_column_type(probe, 0) != SQLITE_NULL);
        sqlite3_finalize(probe);
        if (!has_cipher) {
          fprintf(stderr,
                  "graft: WARNING: GRAFT_DB_KEY is set but SQLCipher is not "
                  "linked — the database is stored UNENCRYPTED. Rebuild with "
                  "SQLCipher to enable encryption-at-rest, or unset the env "
                  "var to silence this warning.\n");
        }
      }
    }
  }
  *out = s;
  return MG_OK;
}

void mg_storage_close(mg_storage_t *s) {
  if (!s) {
    return;
  }
  if (s->db) {
    sqlite3_close(s->db);
  }
  free(s);
}

/* Returns 1 if the legacy `summary` column exists on `nodes` (i.e. pre-rename
 * schema). Returns 0 if the table is absent or already on the new schema.
 * Returns -1 on error. */
static int has_table_column(sqlite3 *db, const char *table, const char *column) {
  sqlite3_stmt *stmt = NULL;
  int rc, found = 0;
  char sql[128];
  int n;
  if (!db || !table || !column) return -1;
  n = snprintf(sql, sizeof(sql), "PRAGMA table_info(%s);", table);
  if (n <= 0 || (size_t)n >= sizeof(sql)) return -1;
  rc = sqlite3_prepare_v2(db, sql, -1, &stmt, NULL);
  if (rc != SQLITE_OK) {
    return -1;
  }
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    const unsigned char *name = sqlite3_column_text(stmt, 1);
    if (name && strcmp((const char *)name, column) == 0) {
      found = 1;
      break;
    }
  }
  sqlite3_finalize(stmt);
  return (rc == SQLITE_ROW || rc == SQLITE_DONE) ? found : -1;
}

static int has_legacy_summary_column(sqlite3 *db) {
  return has_table_column(db, "nodes", "summary");
}

mg_err_t mg_storage_apply_schema(mg_storage_t *s) {
  mg_err_t err;
  int legacy;
  int has_origin;
  if (!s || !s->db) {
    return MG_ERR_INVALID_ARG;
  }
  /* One-shot rename migration for DBs created before the title/body
   * standardisation. No-op on fresh DBs. */
  legacy = has_legacy_summary_column(s->db);
  if (legacy < 0) {
    return MG_ERR_STORAGE;
  }
  if (legacy == 1) {
    err = exec_sql(s->db, mg_storage_migration_v2_sql());
    if (err != MG_OK) {
      return err;
    }
  }
  has_origin = has_table_column(s->db, "nodes", "origin");
  if (has_origin < 0) {
    return MG_ERR_STORAGE;
  }
  if (has_origin == 0 && has_table_column(s->db, "nodes", "id") == 1) {
    err = exec_sql(s->db, mg_storage_migration_v3_sql());
    if (err != MG_OK) {
      return err;
    }
  }
  err = exec_sql(s->db, mg_storage_schema_sql());
  if (err != MG_OK) {
    return err;
  }
  err = create_vec_table(s->db);
  if (err != MG_OK) {
    return err;
  }
  return mg_storage_prune_expired(s, NULL);
}

mg_err_t mg_storage_prune_expired(mg_storage_t *s, int64_t *out_deleted) {
  sqlite3_stmt *stmt = NULL;
  mg_err_t err;
  int rc;
  int changes;

  if (!s || !s->db) {
    return MG_ERR_INVALID_ARG;
  }
  if (out_deleted) {
    *out_deleted = 0;
  }

  err = exec_sql(s->db, "BEGIN IMMEDIATE;");
  if (err != MG_OK) {
    return err;
  }

  err = prepare(s->db,
    "DELETE FROM node_vec WHERE id IN ("
    "  SELECT id FROM nodes "
    "  WHERE expires_at IS NOT NULL "
    "    AND expires_at != 0 "
    "    AND expires_at <= (CAST(strftime('%s','now') AS INTEGER) * 1000)"
    ");",
    &stmt);
  if (err != MG_OK) goto rollback;
  err = step_done(stmt);
  sqlite3_finalize(stmt);
  stmt = NULL;
  if (err != MG_OK && err != MG_ERR_DUPLICATE) goto rollback;

  err = prepare(s->db,
    "DELETE FROM nodes "
    "WHERE expires_at IS NOT NULL "
    "  AND expires_at != 0 "
    "  AND expires_at <= (CAST(strftime('%s','now') AS INTEGER) * 1000);",
    &stmt);
  if (err != MG_OK) goto rollback;
  rc = sqlite3_step(stmt);
  changes = sqlite3_changes(s->db);
  sqlite3_finalize(stmt);
  stmt = NULL;
  if (rc != SQLITE_DONE) {
    err = MG_ERR_STORAGE;
    goto rollback;
  }

  err = exec_sql(s->db, "COMMIT;");
  if (err == MG_OK && out_deleted) {
    *out_deleted = changes;
  }
  return err;

rollback:
  if (stmt) sqlite3_finalize(stmt);
  (void)exec_sql(s->db, "ROLLBACK;");
  return err;
}

mg_err_t mg_storage_insert_node_with_edges(
  mg_storage_t *s,
  const mg_node_t *node,
  const mg_embedding_t embedding,
  const mg_keyword_id_t *keyword_ids, size_t n_keywords,
  const mg_edge_t *edges, size_t n_edges,
  const mg_node_id_t *supersedes_id
) {
  sqlite3_stmt *stmt = NULL;
  size_t i;
  mg_err_t err;
  if (!s || !node || !embedding || (!keyword_ids && n_keywords > 0) || (!edges && n_edges > 0) ||
      !node->title || !node->body) {
    return MG_ERR_INVALID_ARG;
  }

  (void)mg_storage_prune_expired(s, NULL);

  err = exec_sql(s->db, "BEGIN IMMEDIATE;");
  if (err != MG_OK) {
    return err;
  }

  err = prepare(s->db, "INSERT INTO nodes(id,content_hash,title,body,author,created_at,expires_at,last_access,access_count,state) VALUES(?,?,?,?,?,?,?,?,?,?);", &stmt);
  if (err == MG_OK) {
    sqlite3_bind_blob(stmt, 1, node->id, MG_NODE_ID_BYTES, SQLITE_STATIC);
    sqlite3_bind_blob(stmt, 2, node->content_hash, MG_HASH_BYTES, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 3, node->title, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 4, node->body, -1, SQLITE_STATIC);
    if (node->author) {
      sqlite3_bind_text(stmt, 5, node->author, -1, SQLITE_STATIC);
    } else {
      sqlite3_bind_null(stmt, 5);
    }
    sqlite3_bind_int64(stmt, 6, node->created_at);
    sqlite3_bind_int64(stmt, 7, node->expires_at);
    sqlite3_bind_int64(stmt, 8, node->last_access);
    sqlite3_bind_int64(stmt, 9, node->access_count);
    sqlite3_bind_int(stmt, 10, (int)node->state);
    err = step_done(stmt);
  }
  sqlite3_finalize(stmt);

  if (err == MG_OK) {
    err = prepare(s->db, "INSERT INTO node_vec(id,embedding) VALUES(?,?);", &stmt);
    if (err == MG_OK) {
      sqlite3_bind_blob(stmt, 1, node->id, MG_NODE_ID_BYTES, SQLITE_STATIC);
      sqlite3_bind_blob(stmt, 2, embedding, (int)sizeof(mg_embedding_t), SQLITE_STATIC);
      err = step_done(stmt);
    }
    sqlite3_finalize(stmt);
  }

  for (i = 0; err == MG_OK && i < n_keywords; ++i) {
    err = prepare(s->db, "INSERT OR IGNORE INTO node_keywords(node_id,keyword_id) VALUES(?,?);", &stmt);
    if (err == MG_OK) {
      sqlite3_bind_blob(stmt, 1, node->id, MG_NODE_ID_BYTES, SQLITE_STATIC);
      sqlite3_bind_int64(stmt, 2, keyword_ids[i]);
      err = step_done(stmt);
    }
    sqlite3_finalize(stmt);
  }

  for (i = 0; err == MG_OK && i < n_edges; ++i) {
    err = prepare(s->db, "INSERT OR REPLACE INTO edges(src,dst,kind,keyword_id,weight) VALUES(?,?,?,?,?);", &stmt);
    if (err == MG_OK) {
      sqlite3_bind_blob(stmt, 1, edges[i].src, MG_NODE_ID_BYTES, SQLITE_STATIC);
      sqlite3_bind_blob(stmt, 2, edges[i].dst, MG_NODE_ID_BYTES, SQLITE_STATIC);
      sqlite3_bind_int(stmt, 3, (int)edges[i].kind);
      if (edges[i].keyword_id == 0) {
        sqlite3_bind_null(stmt, 4);
      } else {
        sqlite3_bind_int64(stmt, 4, edges[i].keyword_id);
      }
      sqlite3_bind_double(stmt, 5, (double)edges[i].weight);
      err = step_done(stmt);
    }
    sqlite3_finalize(stmt);
  }

  /* Supersession (atomic with the insert): mark the old node SUPERSEDED and
   * add a SUPERSEDES edge new -> old. Both happen inside the same tx so an
   * outside reader never sees an "insert without supersede" intermediate. */
  if (err == MG_OK && supersedes_id) {
    err = prepare(s->db,
      "INSERT OR REPLACE INTO edges(src,dst,kind,keyword_id,weight) VALUES(?,?,?,NULL,1.0);",
      &stmt);
    if (err == MG_OK) {
      sqlite3_bind_blob(stmt, 1, node->id, MG_NODE_ID_BYTES, SQLITE_STATIC);
      sqlite3_bind_blob(stmt, 2, *supersedes_id, MG_NODE_ID_BYTES, SQLITE_STATIC);
      sqlite3_bind_int(stmt, 3, (int)MG_EDGE_SUPERSEDES);
      err = step_done(stmt);
    }
    sqlite3_finalize(stmt);

    if (err == MG_OK) {
      err = prepare(s->db, "UPDATE nodes SET state = ? WHERE id = ?;", &stmt);
      if (err == MG_OK) {
        sqlite3_bind_int(stmt, 1, (int)MG_NODE_SUPERSEDED);
        sqlite3_bind_blob(stmt, 2, *supersedes_id, MG_NODE_ID_BYTES, SQLITE_STATIC);
        err = step_done(stmt);
      }
      sqlite3_finalize(stmt);
    }
  }

  if (err == MG_OK) {
    err = exec_sql(s->db, "COMMIT;");
  } else {
    (void)exec_sql(s->db, "ROLLBACK;");
  }
  return err;
}

mg_err_t mg_storage_get_node(mg_storage_t *s, const mg_node_id_t id, mg_node_t *out) {
  sqlite3_stmt *stmt = NULL;
  int rc;
  if (!s || !id || !out) {
    return MG_ERR_INVALID_ARG;
  }
  memset(out, 0, sizeof(*out));
  if (prepare(s->db, "SELECT id,content_hash,title,body,author,created_at,expires_at,last_access,access_count,state FROM nodes WHERE id=?;", &stmt) != MG_OK) {
    return MG_ERR_STORAGE;
  }
  sqlite3_bind_blob(stmt, 1, id, MG_NODE_ID_BYTES, SQLITE_STATIC);
  rc = sqlite3_step(stmt);
  if (rc == SQLITE_ROW) {
    const unsigned char *author_text;
    memcpy(out->id, sqlite3_column_blob(stmt, 0), MG_NODE_ID_BYTES);
    memcpy(out->content_hash, sqlite3_column_blob(stmt, 1), MG_HASH_BYTES);
    out->title = mg_strdup((const char *)sqlite3_column_text(stmt, 2));
    out->body  = mg_strdup((const char *)sqlite3_column_text(stmt, 3));
    author_text = sqlite3_column_text(stmt, 4);
    out->author = author_text ? mg_strdup((const char *)author_text) : NULL;
    out->created_at  = sqlite3_column_int64(stmt, 5);
    out->expires_at  = sqlite3_column_int64(stmt, 6);
    out->last_access = sqlite3_column_int64(stmt, 7);
    out->access_count = sqlite3_column_int64(stmt, 8);
    out->state = (mg_node_state_t)sqlite3_column_int(stmt, 9);
    sqlite3_finalize(stmt);
    if (!out->title || !out->body) {
      mg_node_free(out);
      return MG_ERR_OOM;
    }
    return MG_OK;
  }
  sqlite3_finalize(stmt);
  return rc == SQLITE_DONE ? MG_ERR_NOT_FOUND : MG_ERR_STORAGE;
}

mg_err_t mg_storage_node_id_by_hash(mg_storage_t *s, const mg_hash_t h, mg_node_id_t out) {
  sqlite3_stmt *stmt = NULL;
  int rc;
  if (!s || !h || !out) {
    return MG_ERR_INVALID_ARG;
  }
  if (prepare(s->db, "SELECT id FROM nodes WHERE content_hash=?;", &stmt) != MG_OK) {
    return MG_ERR_STORAGE;
  }
  sqlite3_bind_blob(stmt, 1, h, MG_HASH_BYTES, SQLITE_STATIC);
  rc = sqlite3_step(stmt);
  if (rc == SQLITE_ROW) {
    memcpy(out, sqlite3_column_blob(stmt, 0), MG_NODE_ID_BYTES);
    sqlite3_finalize(stmt);
    return MG_OK;
  }
  sqlite3_finalize(stmt);
  return rc == SQLITE_DONE ? MG_ERR_NOT_FOUND : MG_ERR_STORAGE;
}

mg_err_t mg_storage_touch_access(mg_storage_t *s, const mg_node_id_t id) {
  sqlite3_stmt *stmt = NULL;
  mg_err_t err;
  if (!s || !id) {
    return MG_ERR_INVALID_ARG;
  }
  err = prepare(s->db, "UPDATE nodes SET last_access=?, access_count=access_count+1 WHERE id=?;", &stmt);
  if (err != MG_OK) {
    return err;
  }
  sqlite3_bind_int64(stmt, 1, now_ms());
  sqlite3_bind_blob(stmt, 2, id, MG_NODE_ID_BYTES, SQLITE_STATIC);
  err = step_done(stmt);
  sqlite3_finalize(stmt);
  return err == MG_OK && sqlite3_changes(s->db) == 0 ? MG_ERR_NOT_FOUND : err;
}

mg_err_t mg_storage_upsert_keyword(mg_storage_t *s, const char *text, const float *opt_embedding, mg_keyword_id_t *out_id) {
  sqlite3_stmt *stmt = NULL;
  mg_err_t err;
  if (!s || !text || !out_id) {
    return MG_ERR_INVALID_ARG;
  }
  err = prepare(s->db, "INSERT OR IGNORE INTO keywords(text,embedding) VALUES(?,?);", &stmt);
  if (err == MG_OK) {
    sqlite3_bind_text(stmt, 1, text, -1, SQLITE_STATIC);
    if (opt_embedding) {
      sqlite3_bind_blob(stmt, 2, opt_embedding, (int)sizeof(mg_embedding_t), SQLITE_STATIC);
    } else {
      sqlite3_bind_null(stmt, 2);
    }
    err = step_done(stmt);
  }
  sqlite3_finalize(stmt);
  if (err != MG_OK) {
    return err;
  }
  err = prepare(s->db, "SELECT id FROM keywords WHERE text=? COLLATE NOCASE;", &stmt);
  if (err != MG_OK) {
    return err;
  }
  sqlite3_bind_text(stmt, 1, text, -1, SQLITE_STATIC);
  if (sqlite3_step(stmt) != SQLITE_ROW) {
    sqlite3_finalize(stmt);
    return MG_ERR_STORAGE;
  }
  *out_id = sqlite3_column_int64(stmt, 0);
  sqlite3_finalize(stmt);
  return MG_OK;
}

mg_err_t mg_storage_get_keyword_text(mg_storage_t *s, mg_keyword_id_t id, char **out) {
  sqlite3_stmt *stmt = NULL;
  int rc;
  if (!s || !out || id <= 0) {
    return MG_ERR_INVALID_ARG;
  }
  *out = NULL;
  if (prepare(s->db, "SELECT text FROM keywords WHERE id=?;", &stmt) != MG_OK) {
    return MG_ERR_STORAGE;
  }
  sqlite3_bind_int64(stmt, 1, id);
  rc = sqlite3_step(stmt);
  if (rc == SQLITE_ROW) {
    *out = mg_strdup((const char *)sqlite3_column_text(stmt, 0));
    sqlite3_finalize(stmt);
    return *out ? MG_OK : MG_ERR_OOM;
  }
  sqlite3_finalize(stmt);
  return rc == SQLITE_DONE ? MG_ERR_NOT_FOUND : MG_ERR_STORAGE;
}

static mg_err_t topk_scan(mg_storage_t *s, const mg_embedding_t query, int k, mg_keyword_id_t kw_id, int use_kw, mg_node_score_t *out, int *out_count) {
  sqlite3_stmt *stmt = NULL;
  /* Exclude superseded and expired nodes from semantic search. Expiration is
   * stored as Unix milliseconds; strftime('%s') is seconds, so scale it. */
  const char *sql_all = "SELECT v.id,v.embedding FROM node_vec v "
                        "JOIN nodes n ON n.id=v.id "
                        "WHERE n.state != 2 "
                        "AND (n.expires_at IS NULL OR n.expires_at = 0 "
                        "OR n.expires_at > (CAST(strftime('%s','now') AS INTEGER) * 1000));";
  const char *sql_kw  = "SELECT v.id,v.embedding FROM node_vec v "
                        "JOIN node_keywords nk ON nk.node_id=v.id "
                        "JOIN nodes n ON n.id=v.id "
                        "WHERE nk.keyword_id=? AND n.state != 2 "
                        "AND (n.expires_at IS NULL OR n.expires_at = 0 "
                        "OR n.expires_at > (CAST(strftime('%s','now') AS INTEGER) * 1000));";
  int rc;
  if (!s || !query || k < 0 || !out || !out_count) {
    return MG_ERR_INVALID_ARG;
  }
  *out_count = 0;
  if (k == 0) {
    return MG_OK;
  }
  (void)mg_storage_prune_expired(s, NULL);
  if (prepare(s->db, use_kw ? sql_kw : sql_all, &stmt) != MG_OK) {
    return MG_ERR_STORAGE;
  }
  if (use_kw) {
    sqlite3_bind_int64(stmt, 1, kw_id);
  }
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    const void *id = sqlite3_column_blob(stmt, 0);
    const void *blob = sqlite3_column_blob(stmt, 1);
    int bytes = sqlite3_column_bytes(stmt, 1);
    if (id && blob && bytes == (int)sizeof(mg_embedding_t)) {
      push_topk(out, out_count, k, id, cosine_score(query, (const float *)blob));
    }
  }
  sqlite3_finalize(stmt);
  return rc == SQLITE_DONE ? MG_OK : MG_ERR_STORAGE;
}

mg_err_t mg_storage_vector_topk(mg_storage_t *s, const mg_embedding_t query, int k, mg_node_score_t *out, int *out_count) {
  return topk_scan(s, query, k, 0, 0, out, out_count);
}

mg_err_t mg_storage_vector_topk_by_keyword(mg_storage_t *s, const mg_embedding_t query, mg_keyword_id_t kw_id, int k, mg_node_score_t *out, int *out_count) {
  if (kw_id <= 0) {
    return MG_ERR_INVALID_ARG;
  }
  return topk_scan(s, query, k, kw_id, 1, out, out_count);
}

/* Build an FTS5 MATCH expression that constrains every token in `query_text`
 * to a single column (e.g. "title" or "body"). Returns a malloc'd string,
 * or NULL on OOM or if the input contains no usable tokens.
 *
 * Without this scoping, passing user input straight into the MATCH expression
 * lets a query like `a) OR body:secret OR title:(b` break out of a `title:(…)`
 * scope and search columns the caller did not authorize. We tokenize on
 * ASCII whitespace and wrap each token as `<col>:"<token>"`, doubling any
 * internal `"` per FTS5 quoting rules. Quoted phrases lose all special
 * meaning to FTS5, so `(`, `)`, `:`, and column-name keywords pass through
 * harmlessly as literal text to match. */
static char *build_scoped_fts_query(const char *col, const char *query_text) {
  size_t in_len = strlen(query_text);
  /* Worst-case output size: every char becomes a doubled quote inside a
   * quoted phrase, plus `<col>:"` prefix and `"` suffix and a trailing
   * space per token. Bound loosely as (in_len + col_len + 4) * 2. */
  size_t col_len = strlen(col);
  size_t cap = (in_len + col_len + 4) * 2 + 1;
  char *out = (char *)malloc(cap);
  if (!out) {
    return NULL;
  }
  size_t op = 0;
  size_t i = 0;
  int wrote_any = 0;
  while (i < in_len) {
    /* skip whitespace */
    while (i < in_len && isspace((unsigned char)query_text[i])) i++;
    if (i >= in_len) break;
    /* find token end */
    size_t tok_start = i;
    while (i < in_len && !isspace((unsigned char)query_text[i])) i++;
    size_t tok_len = i - tok_start;
    if (tok_len == 0) continue;
    if (wrote_any) {
      if (op + 1 < cap) out[op++] = ' ';
    }
    /* <col>:"<token with " doubled>" */
    if (op + col_len + 2 >= cap) break;
    memcpy(out + op, col, col_len); op += col_len;
    out[op++] = ':';
    out[op++] = '"';
    for (size_t j = 0; j < tok_len; j++) {
      char c = query_text[tok_start + j];
      if (c == '"') {
        if (op + 2 >= cap) { op = cap - 1; break; }
        out[op++] = '"';
        out[op++] = '"';
      } else {
        if (op + 1 >= cap) { op = cap - 1; break; }
        out[op++] = c;
      }
    }
    if (op + 1 >= cap) { op = cap - 1; }
    out[op++] = '"';
    wrote_any = 1;
  }
  out[op] = '\0';
  if (!wrote_any) {
    free(out);
    return NULL;
  }
  return out;
}

mg_err_t mg_storage_fts_search(mg_storage_t *s, const char *query_text, int k, bool match_title, bool match_body, mg_node_score_t *out, int *out_count) {
  sqlite3_stmt *stmt = NULL;
  char *match_query = NULL;
  const char *match_expr = query_text;
  const char *rank_expr = "bm25(node_fts)";
  int rc;
  if (!s || !query_text || k < 0 || !out || !out_count || (!match_title && !match_body)) {
    return MG_ERR_INVALID_ARG;
  }
  *out_count = 0;
  if (k == 0) {
    return MG_OK;
  }

  if (match_title && !match_body) {
    match_query = build_scoped_fts_query("title", query_text);
    if (!match_query) {
      /* No usable tokens (whitespace-only input) -> no results, not an error. */
      return MG_OK;
    }
    match_expr = match_query;
    rank_expr = "bm25(node_fts, 1.0, 0.0)";
  } else if (!match_title && match_body) {
    match_query = build_scoped_fts_query("body", query_text);
    if (!match_query) {
      return MG_OK;
    }
    match_expr = match_query;
    rank_expr = "bm25(node_fts, 0.0, 1.0)";
  }

  (void)mg_storage_prune_expired(s, NULL);

  char sql[384];
  snprintf(sql, sizeof(sql),
           "SELECT nodes.id, -%s FROM node_fts "
           "JOIN nodes ON nodes.rowid=node_fts.rowid "
           "WHERE node_fts MATCH ? AND nodes.state != 2 "
           "AND (nodes.expires_at IS NULL OR nodes.expires_at = 0 "
           "OR nodes.expires_at > (CAST(strftime('%%s','now') AS INTEGER) * 1000)) "
           "ORDER BY %s LIMIT ?;",
           rank_expr, rank_expr);
  if (prepare(s->db, sql, &stmt) != MG_OK) {
    free(match_query);
    return MG_ERR_STORAGE;
  }
  sqlite3_bind_text(stmt, 1, match_expr, -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(stmt, 2, k);
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    memcpy(out[*out_count].id, sqlite3_column_blob(stmt, 0), MG_NODE_ID_BYTES);
    out[*out_count].score = (float)sqlite3_column_double(stmt, 1);
    ++(*out_count);
  }
  sqlite3_finalize(stmt);
  free(match_query);
  return rc == SQLITE_DONE ? MG_OK : MG_ERR_STORAGE;
}

mg_err_t mg_storage_neighbors(mg_storage_t *s, const mg_node_id_t src, int kind_filter, const mg_keyword_id_t *kw_filter, size_t n_kw, mg_edge_t *out, int max_out, int *out_count) {
  sqlite3_stmt *stmt = NULL;
  int rc;
  if (!s || !src || !out || !out_count || max_out < 0 || (!kw_filter && n_kw > 0)) {
    return MG_ERR_INVALID_ARG;
  }
  *out_count = 0;
  (void)mg_storage_prune_expired(s, NULL);
  if (prepare(s->db,
      "SELECT src,dst,kind,COALESCE(keyword_id,0),weight FROM ("
      "  SELECT e.src,e.dst,e.kind,e.keyword_id,e.weight FROM edges e "
      "  JOIN nodes dst ON dst.id=e.dst "
      "  WHERE e.src=? AND (?=-1 OR e.kind=?) "
      "    AND dst.state != 2 "
      "    AND (dst.expires_at IS NULL OR dst.expires_at = 0 "
      "         OR dst.expires_at > (CAST(strftime('%s','now') AS INTEGER) * 1000)) "
      "  UNION ALL "
      "  SELECT e.dst AS src,e.src AS dst,e.kind,e.keyword_id,e.weight FROM edges e "
      "  JOIN nodes dst ON dst.id=e.src "
      "  WHERE e.dst=? AND e.kind IN (0,1) AND (?=-1 OR e.kind=?)"
      "    AND dst.state != 2 "
      "    AND (dst.expires_at IS NULL OR dst.expires_at = 0 "
      "         OR dst.expires_at > (CAST(strftime('%s','now') AS INTEGER) * 1000)) "
      ") ORDER BY weight DESC;",
      &stmt) != MG_OK) {
    return MG_ERR_STORAGE;
  }
  sqlite3_bind_blob(stmt, 1, src, MG_NODE_ID_BYTES, SQLITE_STATIC);
  sqlite3_bind_int(stmt, 2, kind_filter);
  sqlite3_bind_int(stmt, 3, kind_filter);
  sqlite3_bind_blob(stmt, 4, src, MG_NODE_ID_BYTES, SQLITE_STATIC);
  sqlite3_bind_int(stmt, 5, kind_filter);
  sqlite3_bind_int(stmt, 6, kind_filter);
  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW && *out_count < max_out) {
    mg_keyword_id_t kw = sqlite3_column_int64(stmt, 3);
    int keep = n_kw == 0;
    size_t i;
    for (i = 0; i < n_kw; ++i) {
      if (kw_filter[i] == kw) {
        keep = 1;
      }
    }
    if (keep) {
      const void *dst = sqlite3_column_blob(stmt, 1);
      mg_edge_kind_t kind = (mg_edge_kind_t)sqlite3_column_int(stmt, 2);
      int seen = 0;
      for (int j = 0; j < *out_count; ++j) {
        if (out[j].kind == kind &&
            out[j].keyword_id == kw &&
            memcmp(out[j].dst, dst, MG_NODE_ID_BYTES) == 0) {
          seen = 1;
          break;
        }
      }
      if (seen) {
        continue;
      }
      memcpy(out[*out_count].src, sqlite3_column_blob(stmt, 0), MG_NODE_ID_BYTES);
      memcpy(out[*out_count].dst, dst, MG_NODE_ID_BYTES);
      out[*out_count].kind = kind;
      out[*out_count].keyword_id = kw;
      out[*out_count].weight = (float)sqlite3_column_double(stmt, 4);
      ++(*out_count);
    }
  }
  sqlite3_finalize(stmt);
  return rc == SQLITE_DONE || *out_count == max_out ? MG_OK : MG_ERR_STORAGE;
}

mg_err_t mg_storage_record_sample(mg_storage_t *s, int kind, float cosine) {
  sqlite3_stmt *stmt = NULL;
  mg_err_t err;
  if (!s) {
    return MG_ERR_INVALID_ARG;
  }
  err = prepare(s->db, "INSERT INTO similarity_samples(ts,kind,cosine) VALUES(?,?,?);", &stmt);
  if (err != MG_OK) {
    return err;
  }
  sqlite3_bind_int64(stmt, 1, now_ms());
  sqlite3_bind_int(stmt, 2, kind);
  sqlite3_bind_double(stmt, 3, (double)cosine);
  err = step_done(stmt);
  sqlite3_finalize(stmt);
  return err;
}

mg_err_t mg_storage_distribution_percentiles(mg_storage_t *s, int kind, float out[6]) {
  static const double pct[6] = {0.25, 0.50, 0.75, 0.90, 0.95, 0.99};
  sqlite3_stmt *stmt = NULL;
  sqlite3_int64 count;
  int i;
  if (!s || !out) {
    return MG_ERR_INVALID_ARG;
  }
  if (prepare(s->db, "SELECT COUNT(*) FROM similarity_samples WHERE kind=?;", &stmt) != MG_OK) {
    return MG_ERR_STORAGE;
  }
  sqlite3_bind_int(stmt, 1, kind);
  if (sqlite3_step(stmt) != SQLITE_ROW) {
    sqlite3_finalize(stmt);
    return MG_ERR_STORAGE;
  }
  count = sqlite3_column_int64(stmt, 0);
  sqlite3_finalize(stmt);
  if (count <= 0) {
    memset(out, 0, 6 * sizeof(float));
    return MG_OK;
  }
  for (i = 0; i < 6; ++i) {
    sqlite3_int64 off = (sqlite3_int64)floor((double)(count - 1) * pct[i]);
    if (prepare(s->db, "SELECT cosine FROM similarity_samples WHERE kind=? ORDER BY cosine LIMIT 1 OFFSET ?;", &stmt) != MG_OK) {
      return MG_ERR_STORAGE;
    }
    sqlite3_bind_int(stmt, 1, kind);
    sqlite3_bind_int64(stmt, 2, off);
    if (sqlite3_step(stmt) != SQLITE_ROW) {
      sqlite3_finalize(stmt);
      return MG_ERR_STORAGE;
    }
    out[i] = (float)sqlite3_column_double(stmt, 0);
    sqlite3_finalize(stmt);
  }
  return MG_OK;
}

mg_err_t mg_storage_get_embedding(mg_storage_t *s, const mg_node_id_t id, mg_embedding_t out) {
  sqlite3_stmt *stmt = NULL;
  int rc;
  const void *blob;
  if (!s || !id || !out) {
    return MG_ERR_INVALID_ARG;
  }
  if (prepare(s->db, "SELECT embedding FROM node_vec WHERE id=?;", &stmt) != MG_OK) {
    return MG_ERR_STORAGE;
  }
  sqlite3_bind_blob(stmt, 1, id, MG_NODE_ID_BYTES, SQLITE_STATIC);
  rc = sqlite3_step(stmt);
  if (rc == SQLITE_ROW) {
    blob = sqlite3_column_blob(stmt, 0);
    if (!blob || sqlite3_column_bytes(stmt, 0) != (int)sizeof(mg_embedding_t)) {
      sqlite3_finalize(stmt);
      return MG_ERR_STORAGE;
    }
    memcpy(out, blob, sizeof(mg_embedding_t));
    sqlite3_finalize(stmt);
    return MG_OK;
  }
  sqlite3_finalize(stmt);
  return rc == SQLITE_DONE ? MG_ERR_NOT_FOUND : MG_ERR_STORAGE;
}

mg_err_t mg_storage_count(mg_storage_t *s, int kind, int64_t *out) {
  static const char *const sqls[] = {
    "SELECT COUNT(*) FROM nodes;",
    "SELECT COUNT(*) FROM edges;",
    "SELECT COUNT(*) FROM keywords;",
  };
  if (!s || !out) return MG_ERR_INVALID_ARG;
  if (kind < 0 || kind >= (int)(sizeof(sqls) / sizeof(*sqls)))
    return MG_ERR_INVALID_ARG;

  sqlite3_stmt *stmt = NULL;
  mg_err_t err = prepare(s->db, sqls[kind], &stmt);
  if (err != MG_OK) return err;

  int rc = sqlite3_step(stmt);
  if (rc == SQLITE_ROW) {
    *out = (int64_t)sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return MG_OK;
  }
  sqlite3_finalize(stmt);
  return MG_ERR_STORAGE;
}

static mg_err_t scalar_i64(mg_storage_t *s, const char *sql, int64_t *out) {
  sqlite3_stmt *stmt = NULL;
  int rc;
  if (!s || !sql || !out) {
    return MG_ERR_INVALID_ARG;
  }
  *out = 0;
  if (prepare(s->db, sql, &stmt) != MG_OK) {
    return MG_ERR_STORAGE;
  }
  rc = sqlite3_step(stmt);
  if (rc == SQLITE_ROW) {
    *out = (int64_t)sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return MG_OK;
  }
  sqlite3_finalize(stmt);
  return rc == SQLITE_DONE ? MG_OK : MG_ERR_STORAGE;
}

static mg_err_t exec_count_changes(mg_storage_t *s, const char *sql, int64_t *out_changes) {
  mg_err_t err;
  if (!s || !sql || !out_changes) {
    return MG_ERR_INVALID_ARG;
  }
  *out_changes = 0;
  err = exec_sql(s->db, sql);
  if (err != MG_OK) {
    return err;
  }
  *out_changes = (int64_t)sqlite3_changes(s->db);
  return MG_OK;
}

mg_err_t mg_storage_consolidate(mg_storage_t *s, mg_storage_consolidate_report_t *out) {
  mg_err_t err;

  if (!s || !out) {
    return MG_ERR_INVALID_ARG;
  }
  memset(out, 0, sizeof(*out));

  err = mg_storage_prune_expired(s, &out->expired_deleted);
  if (err != MG_OK) {
    return err;
  }

  err = exec_sql(s->db, "BEGIN IMMEDIATE;");
  if (err != MG_OK) {
    return err;
  }

  err = exec_count_changes(s,
    "DELETE FROM node_keywords "
    "WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE id = node_keywords.node_id) "
    "   OR NOT EXISTS (SELECT 1 FROM keywords WHERE id = node_keywords.keyword_id);",
    &out->orphan_node_keywords_deleted);
  if (err != MG_OK) goto rollback;

  err = exec_count_changes(s,
    "DELETE FROM edges "
    "WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE id = edges.src) "
    "   OR NOT EXISTS (SELECT 1 FROM nodes WHERE id = edges.dst) "
    "   OR (keyword_id IS NOT NULL AND NOT EXISTS "
    "       (SELECT 1 FROM keywords WHERE id = edges.keyword_id));",
    &out->orphan_edges_deleted);
  if (err != MG_OK) goto rollback;

  err = exec_count_changes(s,
    "DELETE FROM edges "
    "WHERE rowid NOT IN ("
    "  SELECT MIN(rowid) FROM edges "
    "  GROUP BY src, dst, kind, COALESCE(keyword_id, -1)"
    ");",
    &out->duplicate_edges_deleted);
  if (err != MG_OK) goto rollback;

  err = exec_count_changes(s,
    "DELETE FROM edges WHERE weight IS NULL OR weight <= 0.0;",
    &out->invalid_edges_deleted);
  if (err != MG_OK) goto rollback;

  err = exec_sql(s->db, "COMMIT;");
  if (err != MG_OK) {
    return err;
  }

  (void)exec_sql(s->db, "ANALYZE;");
  (void)exec_sql(s->db, "PRAGMA optimize;");

  (void)mg_storage_count(s, MG_STORAGE_COUNT_NODES, &out->n_nodes);
  (void)mg_storage_count(s, MG_STORAGE_COUNT_EDGES, &out->n_edges);
  (void)mg_storage_count(s, MG_STORAGE_COUNT_KEYWORDS, &out->n_keywords);

  (void)scalar_i64(s,
    "SELECT COUNT(*) FROM nodes n "
    "WHERE n.state != 2 "
    "  AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id OR e.dst = n.id) "
    "  AND NOT EXISTS (SELECT 1 FROM node_keywords nk WHERE nk.node_id = n.id);",
    &out->isolated_nodes);

  (void)scalar_i64(s,
    "SELECT COUNT(*) FROM edges e "
    "WHERE e.kind IN (0,1) "
    "  AND e.src < e.dst "
    "  AND EXISTS ("
    "    SELECT 1 FROM edges r "
    "    WHERE r.src = e.dst AND r.dst = e.src "
    "      AND r.kind = e.kind "
    "      AND COALESCE(r.keyword_id, -1) = COALESCE(e.keyword_id, -1)"
    "  );",
    &out->physical_bidirectional_pairs);

  (void)scalar_i64(s,
    "SELECT COUNT(*) FROM edges WHERE kind = 2;",
    &out->contradictions_found);

  return MG_OK;

rollback:
  (void)exec_sql(s->db, "ROLLBACK;");
  return err;
}

mg_err_t mg_storage_delete_node(mg_storage_t *s, const mg_node_id_t id) {
  if (!s || !id) return MG_ERR_INVALID_ARG;

  mg_err_t err = exec_sql(s->db, "BEGIN IMMEDIATE;");
  if (err != MG_OK) return err;

  /* node_vec uses sqlite-vec's vec0 virtual table, which does not honor
   * SQL foreign keys — clean it up explicitly first. */
  sqlite3_stmt *stmt = NULL;
  err = prepare(s->db, "DELETE FROM node_vec WHERE id = ?;", &stmt);
  if (err != MG_OK) goto rollback;
  sqlite3_bind_blob(stmt, 1, id, MG_NODE_ID_BYTES, SQLITE_STATIC);
  err = step_done(stmt);
  sqlite3_finalize(stmt);
  if (err != MG_OK && err != MG_ERR_DUPLICATE) goto rollback;

  /* nodes: deleting cascades node_keywords + edges; the nodes_ad trigger
   * removes the FTS row. */
  err = prepare(s->db, "DELETE FROM nodes WHERE id = ?;", &stmt);
  if (err != MG_OK) goto rollback;
  sqlite3_bind_blob(stmt, 1, id, MG_NODE_ID_BYTES, SQLITE_STATIC);
  int rc = sqlite3_step(stmt);
  int changes = sqlite3_changes(s->db);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE) {
    err = MG_ERR_STORAGE;
    goto rollback;
  }
  if (changes == 0) {
    /* nothing to delete — surface NOT_FOUND but still commit (node_vec
     * cleanup above is harmless on a non-existent id). */
    (void)exec_sql(s->db, "COMMIT;");
    return MG_ERR_NOT_FOUND;
  }
  return exec_sql(s->db, "COMMIT;");

rollback:
  (void)exec_sql(s->db, "ROLLBACK;");
  return err;
}

mg_err_t mg_storage_merge_from(mg_storage_t *s, const char *source_path,
                               int overwrite) {
  /* Strategy: ATTACH the source DB read-only to our existing connection (so
   * sqlite-vec is already loaded), copy in dependency order with SQL set-
   * operations, then DETACH. Idempotency comes from the content_hash UNIQUE
   * constraint on nodes and the (src,dst,kind,coalesce(kw,-1)) index on
   * edges. Keyword ids are remapped by text since keywords.text is UNIQUE
   * COLLATE NOCASE. The whole thing runs in one transaction so a failure
   * leaves the target untouched.
   *
   * Note about overwrite semantics: nodes are deduplicated by content_hash
   * (which hashes title+body+keywords). If two nodes have the same
   * content_hash, they are by definition identical — so "overwrite" only
   * matters for fields the hash does not cover (created_at, last_access,
   * access_count). With overwrite=1 we adopt the source's metadata; with
   * overwrite=0 we keep what the target already has. */
  if (!s || !source_path) return MG_ERR_INVALID_ARG;

  sqlite3_stmt *stmt = NULL;
  if (sqlite3_prepare_v2(s->db, "ATTACH DATABASE ? AS src", -1, &stmt, NULL)
      != SQLITE_OK) return MG_ERR_STORAGE;
  sqlite3_bind_text(stmt, 1, source_path, -1, SQLITE_STATIC);
  int rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE) return MG_ERR_STORAGE;

  mg_err_t err = exec_sql(s->db, "BEGIN IMMEDIATE;");
  if (err != MG_OK) {
    (void)exec_sql(s->db, "DETACH DATABASE src;");
    return err;
  }

  const char *node_verb = overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  char sql[1024];

  /* 1. nodes (idempotent on content_hash UNIQUE) */
  snprintf(sql, sizeof(sql),
    "%s INTO main.nodes(id, content_hash, title, body, author, "
    "                   created_at, expires_at, last_access, access_count, state, origin) "
    "SELECT id, content_hash, title, body, author, "
    "       created_at, expires_at, last_access, access_count, state, origin FROM src.nodes;",
    node_verb);
  err = exec_sql(s->db, sql);
  if (err != MG_OK) goto rollback;

  /* 2. node_vec (only for nodes that ended up in main; same id) */
  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO main.node_vec(id, embedding) "
    "SELECT id, embedding FROM src.node_vec "
    "WHERE id IN (SELECT id FROM main.nodes);");
  if (err != MG_OK) goto rollback;

  /* 3. keywords (UNIQUE on text COLLATE NOCASE → idempotent) */
  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO main.keywords(text, embedding) "
    "SELECT text, embedding FROM src.keywords;");
  if (err != MG_OK) goto rollback;

  /* 4. node_keywords with id remap via text */
  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO main.node_keywords(node_id, keyword_id) "
    "SELECT nk.node_id, m_kw.id "
    "FROM src.node_keywords AS nk "
    "JOIN src.keywords AS s_kw ON s_kw.id = nk.keyword_id "
    "JOIN main.keywords AS m_kw ON m_kw.text = s_kw.text COLLATE NOCASE "
    "WHERE EXISTS (SELECT 1 FROM main.nodes WHERE id = nk.node_id);");
  if (err != MG_OK) goto rollback;

  /* 5. edges with optional keyword_id remap; restrict to endpoints in main */
  snprintf(sql, sizeof(sql),
    "%s INTO main.edges(src, dst, kind, keyword_id, weight) "
    "SELECT e.src, e.dst, e.kind, "
    "       CASE WHEN e.keyword_id IS NULL THEN NULL ELSE m_kw.id END, "
    "       e.weight "
    "FROM src.edges AS e "
    "LEFT JOIN src.keywords AS s_kw ON s_kw.id = e.keyword_id "
    "LEFT JOIN main.keywords AS m_kw ON m_kw.text = s_kw.text COLLATE NOCASE "
    "WHERE EXISTS (SELECT 1 FROM main.nodes WHERE id = e.src) "
    "  AND EXISTS (SELECT 1 FROM main.nodes WHERE id = e.dst);",
    overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE");
  err = exec_sql(s->db, sql);
  if (err != MG_OK) goto rollback;

  err = exec_sql(s->db, "COMMIT;");
  if (err != MG_OK) goto rollback;
  (void)exec_sql(s->db, "DETACH DATABASE src;");
  return MG_OK;

rollback:
  (void)exec_sql(s->db, "ROLLBACK;");
  (void)exec_sql(s->db, "DETACH DATABASE src;");
  return err;
}

mg_err_t mg_storage_pull_remote_file(mg_storage_t *s, const char *source_path,
                                     int64_t *inserted, int64_t *deleted) {
  if (!s || !source_path) return MG_ERR_INVALID_ARG;
  if (inserted) *inserted = 0;
  if (deleted) *deleted = 0;

  sqlite3_stmt *stmt = NULL;
  if (sqlite3_prepare_v2(s->db, "ATTACH DATABASE ? AS src", -1, &stmt, NULL)
      != SQLITE_OK) return MG_ERR_STORAGE;
  sqlite3_bind_text(stmt, 1, source_path, -1, SQLITE_STATIC);
  int rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE) return MG_ERR_STORAGE;

  mg_err_t err = exec_sql(s->db, "BEGIN IMMEDIATE;");
  if (err != MG_OK) {
    (void)exec_sql(s->db, "DETACH DATABASE src;");
    return err;
  }

  err = exec_sql(s->db,
    "DELETE FROM main.nodes "
    "WHERE origin != 0 "
    "  AND NOT EXISTS (SELECT 1 FROM src.nodes WHERE src.nodes.id = main.nodes.id);");
  if (err != MG_OK) goto rollback;
  if (deleted) *deleted = sqlite3_changes64(s->db);

  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO main.keywords(text, embedding) "
    "SELECT text, embedding FROM src.keywords;");
  if (err != MG_OK) goto rollback;

  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO main.nodes(id, content_hash, title, body, author, "
    "  created_at, expires_at, last_access, access_count, state, origin) "
    "SELECT id, content_hash, title, body, author, "
    "  created_at, expires_at, last_access, access_count, state, 1 "
    "FROM src.nodes;");
  if (err != MG_OK) goto rollback;
  if (inserted) *inserted = sqlite3_changes64(s->db);

  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO main.node_vec(id, embedding) "
    "SELECT id, embedding FROM src.node_vec "
    "WHERE id IN (SELECT id FROM main.nodes);");
  if (err != MG_OK) goto rollback;

  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO main.node_keywords(node_id, keyword_id) "
    "SELECT nk.node_id, m_kw.id "
    "FROM src.node_keywords AS nk "
    "JOIN src.keywords AS s_kw ON s_kw.id = nk.keyword_id "
    "JOIN main.keywords AS m_kw ON m_kw.text = s_kw.text COLLATE NOCASE "
    "WHERE EXISTS (SELECT 1 FROM main.nodes WHERE id = nk.node_id);");
  if (err != MG_OK) goto rollback;

  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO main.edges(src, dst, kind, keyword_id, weight) "
    "SELECT e.src, e.dst, e.kind, "
    "       CASE WHEN e.keyword_id IS NULL THEN NULL ELSE m_kw.id END, "
    "       e.weight "
    "FROM src.edges AS e "
    "LEFT JOIN src.keywords AS s_kw ON s_kw.id = e.keyword_id "
    "LEFT JOIN main.keywords AS m_kw ON m_kw.text = s_kw.text COLLATE NOCASE "
    "WHERE EXISTS (SELECT 1 FROM main.nodes WHERE id = e.src) "
    "  AND EXISTS (SELECT 1 FROM main.nodes WHERE id = e.dst) "
    "  AND NOT EXISTS (SELECT 1 FROM main.nodes WHERE id = e.src AND origin = 0) "
    "  AND NOT EXISTS (SELECT 1 FROM main.nodes WHERE id = e.dst AND origin = 0);");
  if (err != MG_OK) goto rollback;

  err = exec_sql(s->db, "COMMIT;");
  if (err != MG_OK) goto rollback;
  (void)exec_sql(s->db, "DETACH DATABASE src;");
  return MG_OK;

rollback:
  (void)exec_sql(s->db, "ROLLBACK;");
  (void)exec_sql(s->db, "DETACH DATABASE src;");
  return err;
}

mg_err_t mg_storage_mark_local_pushed(mg_storage_t *s, int64_t *updated) {
  if (!s) return MG_ERR_INVALID_ARG;
  if (updated) *updated = 0;
  mg_err_t err = exec_sql(s->db, "UPDATE nodes SET origin = 2 WHERE origin = 0;");
  if (err == MG_OK && updated) *updated = sqlite3_changes64(s->db);
  return err;
}

mg_err_t mg_storage_push_to_remote_file(mg_storage_t *s, const char *dest_path,
                                        int64_t *pushed) {
  /* Strategy: ATTACH the remote file as "dest" on the daemon's existing
   * connection. This avoids opening a second connection to the local WAL,
   * which was the source of SQLITE_BUSY failures under concurrent inserts.
   *
   * The whole copy + mark runs in one BEGIN IMMEDIATE transaction:
   *   - only origin=0 (LOCAL) nodes are pushed, not already-remote ones
   *   - origin is flipped to 2 (PUSHED) in the same transaction, so there
   *     is no window where a new insert gets marked PUSHED without being sent
   */
  if (!s || !dest_path) return MG_ERR_INVALID_ARG;
  if (pushed) *pushed = 0;

  sqlite3_busy_timeout(s->db, 5000);

  sqlite3_stmt *stmt = NULL;
  if (sqlite3_prepare_v2(s->db, "ATTACH DATABASE ? AS dest", -1, &stmt, NULL)
      != SQLITE_OK) {
    sqlite3_busy_timeout(s->db, 0);
    return MG_ERR_STORAGE;
  }
  sqlite3_bind_text(stmt, 1, dest_path, -1, SQLITE_STATIC);
  int rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE) {
    sqlite3_busy_timeout(s->db, 0);
    return MG_ERR_STORAGE;
  }

  mg_err_t err = exec_sql(s->db, "BEGIN IMMEDIATE;");
  if (err != MG_OK) goto detach;

  /* 1. keywords referenced by local nodes */
  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO dest.keywords(text, embedding) "
    "SELECT DISTINCT k.text, k.embedding "
    "FROM main.keywords AS k "
    "JOIN main.node_keywords AS nk ON nk.keyword_id = k.id "
    "JOIN main.nodes AS n ON n.id = nk.node_id "
    "WHERE n.origin = 0;");
  if (err != MG_OK) goto rollback;

  /* 2. nodes (LOCAL only) */
  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO dest.nodes"
    "(id, content_hash, title, body, author,"
    " created_at, expires_at, last_access, access_count, state, origin) "
    "SELECT id, content_hash, title, body, author,"
    "       created_at, expires_at, last_access, access_count, state, 0 "
    "FROM main.nodes WHERE origin = 0;");
  if (err != MG_OK) goto rollback;
  if (pushed) *pushed = sqlite3_changes64(s->db);

  /* 3. embeddings for pushed nodes */
  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO dest.node_vec(id, embedding) "
    "SELECT id, embedding FROM main.node_vec "
    "WHERE id IN (SELECT id FROM main.nodes WHERE origin = 0);");
  if (err != MG_OK) goto rollback;

  /* 4. node_keywords with keyword id remap via text */
  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO dest.node_keywords(node_id, keyword_id) "
    "SELECT nk.node_id, dk.id "
    "FROM main.node_keywords AS nk "
    "JOIN main.keywords AS mk ON mk.id = nk.keyword_id "
    "JOIN dest.keywords  AS dk ON dk.text = mk.text COLLATE NOCASE "
    "WHERE EXISTS (SELECT 1 FROM dest.nodes WHERE id = nk.node_id);");
  if (err != MG_OK) goto rollback;

  /* 5. edges where both endpoints are in dest */
  err = exec_sql(s->db,
    "INSERT OR IGNORE INTO dest.edges(src, dst, kind, keyword_id, weight) "
    "SELECT e.src, e.dst, e.kind, "
    "       CASE WHEN e.keyword_id IS NULL THEN NULL ELSE dk.id END, "
    "       e.weight "
    "FROM main.edges AS e "
    "LEFT JOIN main.keywords AS mk ON mk.id = e.keyword_id "
    "LEFT JOIN dest.keywords  AS dk ON dk.text = mk.text COLLATE NOCASE "
    "WHERE EXISTS (SELECT 1 FROM dest.nodes WHERE id = e.src) "
    "  AND EXISTS (SELECT 1 FROM dest.nodes WHERE id = e.dst);");
  if (err != MG_OK) goto rollback;

  /* 6. flip origin to PUSHED — atomic with the copy above */
  err = exec_sql(s->db, "UPDATE main.nodes SET origin = 2 WHERE origin = 0;");
  if (err != MG_OK) goto rollback;

  err = exec_sql(s->db, "COMMIT;");
  if (err != MG_OK) goto rollback;
  goto detach;

rollback:
  (void)exec_sql(s->db, "ROLLBACK;");
  if (pushed) *pushed = 0;
detach:
  (void)exec_sql(s->db, "DETACH DATABASE dest;");
  sqlite3_busy_timeout(s->db, 0);
  return err;
}

mg_err_t mg_storage_node_keywords(mg_storage_t *s,
                                  const mg_node_id_t node_id,
                                  mg_keyword_id_t *out_ids,
                                  int max_out, int *out_count) {
  if (!s || !node_id || !out_ids || !out_count || max_out <= 0) return MG_ERR_INVALID_ARG;

  sqlite3_stmt *stmt = NULL;
  mg_err_t err = prepare(s->db,
    "SELECT keyword_id FROM node_keywords WHERE node_id = ? ORDER BY keyword_id;",
    &stmt);
  if (err != MG_OK) return err;

  sqlite3_bind_blob(stmt, 1, node_id, MG_NODE_ID_BYTES, SQLITE_STATIC);

  int n = 0;
  while (n < max_out) {
    int rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW) {
      out_ids[n++] = (mg_keyword_id_t)sqlite3_column_int64(stmt, 0);
    } else if (rc == SQLITE_DONE) {
      break;
    } else {
      sqlite3_finalize(stmt);
      return MG_ERR_STORAGE;
    }
  }
  sqlite3_finalize(stmt);
  *out_count = n;
  return MG_OK;
}
