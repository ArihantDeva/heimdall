#include "graft/config.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <yaml.h>

static char *mg_config_strdup(const char *s) {
  size_t len;
  char *out;

  if (!s) {
    return NULL;
  }

  len = strlen(s);
  out = (char *)malloc(len + 1u);
  if (!out) {
    return NULL;
  }
  memcpy(out, s, len + 1u);
  return out;
}

static mg_err_t mg_config_set_string(char **dst, const char *value) {
  char *copy = mg_config_strdup(value);
  if (!copy) {
    return MG_ERR_OOM;
  }
  free(*dst);
  *dst = copy;
  return MG_OK;
}

void mg_config_defaults(mg_config_t *cfg) {
  if (!cfg) {
    return;
  }

  memset(cfg, 0, sizeof(*cfg));
  cfg->socket_path = mg_config_strdup("/tmp/graft.sock");
  cfg->db_path = mg_config_strdup("./graft.db");
  cfg->embed_model_path = mg_config_strdup("./models/bge-m3.gguf");
  cfg->embed_threads = 4;
  cfg->embed_ctx_size = 8192;
  cfg->embed_instances = 1;
  cfg->hardware_accel = false;
  cfg->cross_encoder_enabled = false;
  cfg->cross_encoder_model_path = NULL;
  cfg->nli_enabled = false;
  cfg->nli_prompt_template = mg_config_strdup("Premise: {document}\nHypothesis: {query}");
  cfg->strong_hit_min_ce = 0.6f;
  cfg->strong_hit_min_lex = 0.15f;
  cfg->weak_hit_min_vec = 0.85f;
  cfg->min_lex_overlap = 0.05f;
  cfg->verify_lex_strong_min_vec = 0.7f;
  cfg->verify_sem_strong_min_vec = 0.75f;
  cfg->verify_sem_strong_lex_margin = 0.015f;
  cfg->verify_use_fused_gate = false;
  cfg->verify_strong_min_fused = 0.7f;
  cfg->verify_weak_min_fused = 0.5f;
  cfg->retrieve_top_k = 25;
  cfg->rrf_k_const = 60;
  cfg->query_fallback_top_k = 5;
  cfg->rerank_enabled = false;
  cfg->rerank_top_k = 25;
  cfg->rerank_w_vec = 0.30f;
  cfg->rerank_w_lex = 0.25f;
  cfg->rerank_w_ce = 0.45f;
  cfg->rerank_w_nli = 0.0f;
  cfg->edge_keyword_min = 0.5f;
  cfg->edge_semantic_min = 0.6f;
  cfg->edge_keyword_topk = 5;
  cfg->edge_semantic_topk = 20;
  cfg->mmr_lambda = 0.7f;
  cfg->explore_default_beam = 4;
  cfg->explore_default_depth = 3;
  cfg->explore_decay_gamma = 0.85f;
  cfg->explore_alpha = 0.5f;
  cfg->http_enabled = false;
  cfg->http_bind = mg_config_strdup("127.0.0.1");
  cfg->http_port = 9977;
  cfg->http_allow_remote = false;
  cfg->http_tls_terminated_externally = false;
  cfg->http_auth_token = NULL;
  cfg->http_readonly_token = NULL;
  cfg->http_view_anonymize = false;
  cfg->http_view_keyword_scope = NULL;
  cfg->http_ep_match = true;
  cfg->http_ep_search = true;
  cfg->http_ep_explore = true;
  cfg->http_ep_classify = true;
  cfg->http_ep_insert = true;
  cfg->http_ep_delete = false;
  cfg->http_ep_view = true;
  cfg->http_viewer_path = mg_config_strdup("viewer/dist");
}

void mg_config_free(mg_config_t *cfg) {
  if (!cfg) {
    return;
  }

  free(cfg->socket_path);
  free(cfg->db_path);
  free(cfg->embed_model_path);
  free(cfg->cross_encoder_model_path);
  free(cfg->nli_prompt_template);
  free(cfg->http_bind);
  free(cfg->http_auth_token);
  free(cfg->http_readonly_token);
  free(cfg->http_view_keyword_scope);
  free(cfg->http_viewer_path);
  memset(cfg, 0, sizeof(*cfg));
}

static bool mg_parse_bool(const char *s, bool *out) {
  if (!s || !out) {
    return false;
  }
  if (strcmp(s, "true") == 0 || strcmp(s, "yes") == 0 || strcmp(s, "1") == 0) {
    *out = true;
    return true;
  }
  if (strcmp(s, "false") == 0 || strcmp(s, "no") == 0 || strcmp(s, "0") == 0) {
    *out = false;
    return true;
  }
  return false;
}

static bool mg_parse_int(const char *s, int *out) {
  char *end = NULL;
  long value;

  if (!s || !out) {
    return false;
  }
  errno = 0;
  value = strtol(s, &end, 10);
  if (errno != 0 || !end || *end != '\0') {
    return false;
  }
  *out = (int)value;
  return true;
}

static bool mg_parse_float(const char *s, float *out) {
  char *end = NULL;
  float value;

  if (!s || !out) {
    return false;
  }
  errno = 0;
  value = strtof(s, &end);
  if (errno != 0 || !end || *end != '\0') {
    return false;
  }
  *out = value;
  return true;
}

static mg_err_t mg_config_apply(mg_config_t *cfg,
                                const char *section,
                                const char *key,
                                const char *value) {
  bool b;

  if (!cfg || !section || !key || !value) {
    return MG_ERR_INVALID_ARG;
  }

  if (strcmp(section, "daemon") == 0) {
    if (strcmp(key, "socket_path") == 0) {
      return mg_config_set_string(&cfg->socket_path, value);
    }
    if (strcmp(key, "db_path") == 0) {
      return mg_config_set_string(&cfg->db_path, value);
    }
  } else if (strcmp(section, "embedding") == 0) {
    if (strcmp(key, "model_path") == 0) {
      return mg_config_set_string(&cfg->embed_model_path, value);
    }
    if (strcmp(key, "threads") == 0 && mg_parse_int(value, &cfg->embed_threads)) {
      return MG_OK;
    }
    if (strcmp(key, "ctx_size") == 0 && mg_parse_int(value, &cfg->embed_ctx_size)) {
      return MG_OK;
    }
    if (strcmp(key, "instances") == 0 && mg_parse_int(value, &cfg->embed_instances)) {
      return MG_OK;
    }
    if (strcmp(key, "hardware_accel") == 0 && mg_parse_bool(value, &b)) {
      cfg->hardware_accel = b;
      return MG_OK;
    }
  } else if (strcmp(section, "verification") == 0) {
    if (strcmp(key, "cross_encoder_enabled") == 0 && mg_parse_bool(value, &b)) {
      cfg->cross_encoder_enabled = b;
      return MG_OK;
    }
    if (strcmp(key, "cross_encoder_model_path") == 0) {
      return mg_config_set_string(&cfg->cross_encoder_model_path, value);
    }
    if (strcmp(key, "nli_enabled") == 0 && mg_parse_bool(value, &b)) {
      cfg->nli_enabled = b;
      return MG_OK;
    }
    if (strcmp(key, "nli_prompt_template") == 0) {
      return mg_config_set_string(&cfg->nli_prompt_template, value);
    }
    if (strcmp(key, "lex_strong_min_vec") == 0 && mg_parse_float(value, &cfg->verify_lex_strong_min_vec)) return MG_OK;
    if (strcmp(key, "sem_strong_min_vec") == 0 && mg_parse_float(value, &cfg->verify_sem_strong_min_vec)) return MG_OK;
    if (strcmp(key, "sem_strong_lex_margin") == 0 && mg_parse_float(value, &cfg->verify_sem_strong_lex_margin)) return MG_OK;
    if (strcmp(key, "use_fused_gate") == 0 && mg_parse_bool(value, &b)) {
      cfg->verify_use_fused_gate = b;
      return MG_OK;
    }
    if (strcmp(key, "strong_min_fused") == 0 && mg_parse_float(value, &cfg->verify_strong_min_fused)) return MG_OK;
    if (strcmp(key, "weak_min_fused") == 0 && mg_parse_float(value, &cfg->verify_weak_min_fused)) return MG_OK;
  } else if (strcmp(section, "cache") == 0) {
    if (strcmp(key, "strong_hit_min_ce") == 0 && mg_parse_float(value, &cfg->strong_hit_min_ce)) return MG_OK;
    if (strcmp(key, "strong_hit_min_lex") == 0 && mg_parse_float(value, &cfg->strong_hit_min_lex)) return MG_OK;
    if (strcmp(key, "weak_hit_min_vec") == 0 && mg_parse_float(value, &cfg->weak_hit_min_vec)) return MG_OK;
    if (strcmp(key, "min_lex_overlap") == 0 && mg_parse_float(value, &cfg->min_lex_overlap)) return MG_OK;
  } else if (strcmp(section, "retrieval") == 0) {
    if (strcmp(key, "top_k") == 0 && mg_parse_int(value, &cfg->retrieve_top_k)) return MG_OK;
    if (strcmp(key, "rrf_k_const") == 0 && mg_parse_int(value, &cfg->rrf_k_const)) return MG_OK;
    if (strcmp(key, "query_fallback_top_k") == 0 && mg_parse_int(value, &cfg->query_fallback_top_k)) return MG_OK;
  } else if (strcmp(section, "rerank") == 0) {
    if (strcmp(key, "enabled") == 0 && mg_parse_bool(value, &b)) {
      cfg->rerank_enabled = b;
      return MG_OK;
    }
    if (strcmp(key, "top_k") == 0 && mg_parse_int(value, &cfg->rerank_top_k)) return MG_OK;
    if (strcmp(key, "w_vec") == 0 && mg_parse_float(value, &cfg->rerank_w_vec)) return MG_OK;
    if (strcmp(key, "w_lex") == 0 && mg_parse_float(value, &cfg->rerank_w_lex)) return MG_OK;
    if (strcmp(key, "w_ce") == 0 && mg_parse_float(value, &cfg->rerank_w_ce)) return MG_OK;
    if (strcmp(key, "w_nli") == 0 && mg_parse_float(value, &cfg->rerank_w_nli)) return MG_OK;
  } else if (strcmp(section, "edges") == 0) {
    if (strcmp(key, "edge_keyword_min") == 0 && mg_parse_float(value, &cfg->edge_keyword_min)) return MG_OK;
    if (strcmp(key, "edge_semantic_min") == 0 && mg_parse_float(value, &cfg->edge_semantic_min)) return MG_OK;
    if (strcmp(key, "edge_keyword_topk") == 0 && mg_parse_int(value, &cfg->edge_keyword_topk)) return MG_OK;
    if (strcmp(key, "edge_semantic_topk") == 0 && mg_parse_int(value, &cfg->edge_semantic_topk)) return MG_OK;
    if (strcmp(key, "mmr_lambda") == 0 && mg_parse_float(value, &cfg->mmr_lambda)) return MG_OK;
  } else if (strcmp(section, "explore") == 0) {
    if (strcmp(key, "default_beam") == 0 && mg_parse_int(value, &cfg->explore_default_beam)) return MG_OK;
    if (strcmp(key, "default_depth") == 0 && mg_parse_int(value, &cfg->explore_default_depth)) return MG_OK;
    if (strcmp(key, "decay_gamma") == 0 && mg_parse_float(value, &cfg->explore_decay_gamma)) return MG_OK;
    if (strcmp(key, "alpha") == 0 && mg_parse_float(value, &cfg->explore_alpha)) return MG_OK;
  } else if (strcmp(section, "http") == 0) {
    if (strcmp(key, "enabled") == 0 && mg_parse_bool(value, &b)) {
      cfg->http_enabled = b;
      return MG_OK;
    }
    if (strcmp(key, "bind") == 0) {
      return mg_config_set_string(&cfg->http_bind, value);
    }
    if (strcmp(key, "port") == 0 && mg_parse_int(value, &cfg->http_port)) return MG_OK;
    if (strcmp(key, "allow_remote") == 0 && mg_parse_bool(value, &b)) {
      cfg->http_allow_remote = b;
      return MG_OK;
    }
    if (strcmp(key, "tls_terminated_externally") == 0 && mg_parse_bool(value, &b)) {
      cfg->http_tls_terminated_externally = b;
      return MG_OK;
    }
    if (strcmp(key, "auth_token") == 0) {
      return mg_config_set_string(&cfg->http_auth_token, value);
    }
    if (strcmp(key, "readonly_token") == 0) {
      return mg_config_set_string(&cfg->http_readonly_token, value);
    }
    if (strcmp(key, "view_anonymize") == 0 && mg_parse_bool(value, &b)) {
      cfg->http_view_anonymize = b;
      return MG_OK;
    }
    if (strcmp(key, "view_keyword_scope") == 0) {
      return mg_config_set_string(&cfg->http_view_keyword_scope, value);
    }
    if (strcmp(key, "endpoint_match")    == 0 && mg_parse_bool(value, &b)) { cfg->http_ep_match = b; return MG_OK; }
    if (strcmp(key, "endpoint_search")   == 0 && mg_parse_bool(value, &b)) { cfg->http_ep_search = b; return MG_OK; }
    if (strcmp(key, "endpoint_explore")  == 0 && mg_parse_bool(value, &b)) { cfg->http_ep_explore = b; return MG_OK; }
    if (strcmp(key, "endpoint_classify") == 0 && mg_parse_bool(value, &b)) { cfg->http_ep_classify = b; return MG_OK; }
    if (strcmp(key, "endpoint_insert")   == 0 && mg_parse_bool(value, &b)) { cfg->http_ep_insert = b; return MG_OK; }
    if (strcmp(key, "endpoint_delete")   == 0 && mg_parse_bool(value, &b)) { cfg->http_ep_delete = b; return MG_OK; }
    if (strcmp(key, "endpoint_view")     == 0 && mg_parse_bool(value, &b)) { cfg->http_ep_view = b; return MG_OK; }
    if (strcmp(key, "viewer_path") == 0) {
      return mg_config_set_string(&cfg->http_viewer_path, value);
    }
  }

  return MG_OK;
}

mg_err_t mg_config_load(const char *path, mg_config_t *out) {
  FILE *fp;
  yaml_parser_t parser;
  yaml_event_t event;
  char section[64] = {0};
  char key[64] = {0};
  int depth = 0;
  bool have_parser = false;
  bool done = false;
  mg_err_t err = MG_OK;

  if (!path || !out) {
    return MG_ERR_INVALID_ARG;
  }

  mg_config_defaults(out);
  if (!out->socket_path || !out->db_path || !out->embed_model_path) {
    mg_config_free(out);
    return MG_ERR_OOM;
  }

  fp = fopen(path, "rb");
  if (!fp) {
    mg_config_free(out);
    return MG_ERR_IO;
  }

  if (!yaml_parser_initialize(&parser)) {
    fclose(fp);
    mg_config_free(out);
    return MG_ERR_CONFIG;
  }
  have_parser = true;
  yaml_parser_set_input_file(&parser, fp);

  while (!done) {
    if (!yaml_parser_parse(&parser, &event)) {
      err = MG_ERR_CONFIG;
      break;
    }

    switch (event.type) {
      case YAML_MAPPING_START_EVENT:
        depth++;
        break;
      case YAML_MAPPING_END_EVENT:
        if (depth == 2) {
          key[0] = '\0';
        } else if (depth == 1) {
          section[0] = '\0';
        }
        depth--;
        break;
      case YAML_SCALAR_EVENT: {
        const char *value = (const char *)event.data.scalar.value;
        if (depth == 1) {
          snprintf(section, sizeof(section), "%s", value);
          key[0] = '\0';
        } else if (depth == 2) {
          if (key[0] == '\0') {
            snprintf(key, sizeof(key), "%s", value);
          } else {
            err = mg_config_apply(out, section, key, value);
            key[0] = '\0';
          }
        }
        break;
      }
      case YAML_STREAM_END_EVENT:
        done = true;
        break;
      default:
        break;
    }

    yaml_event_delete(&event);
    if (err != MG_OK) {
      break;
    }
  }

  if (have_parser) {
    yaml_parser_delete(&parser);
  }
  fclose(fp);

  if (err != MG_OK) {
    mg_config_free(out);
  }
  return err;
}
