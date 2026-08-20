#ifndef GRAFT_ERROR_H
#define GRAFT_ERROR_H

typedef enum {
  MG_OK              = 0,
  MG_ERR_INVALID_ARG = 1,
  MG_ERR_NOT_FOUND   = 2,
  MG_ERR_DUPLICATE   = 3,
  MG_ERR_STORAGE     = 4,
  MG_ERR_EMBED       = 5,
  MG_ERR_WIRE        = 6,
  MG_ERR_IO          = 7,
  MG_ERR_OOM         = 8,
  MG_ERR_CONFIG      = 9,
  MG_ERR_INTERNAL    = 99
} mg_err_t;

const char *mg_strerror(mg_err_t e);

#endif
