#include "graft/error.h"

const char *mg_strerror(mg_err_t e) {
  switch (e) {
    case MG_OK: return "ok";
    case MG_ERR_INVALID_ARG: return "invalid argument";
    case MG_ERR_NOT_FOUND: return "not found";
    case MG_ERR_DUPLICATE: return "duplicate";
    case MG_ERR_STORAGE: return "storage error";
    case MG_ERR_EMBED: return "embedding error";
    case MG_ERR_WIRE: return "wire error";
    case MG_ERR_IO: return "i/o error";
    case MG_ERR_OOM: return "out of memory";
    case MG_ERR_CONFIG: return "config error";
    case MG_ERR_INTERNAL: return "internal error";
    default: return "unknown error";
  }
}
