#ifndef GRAFT_LLAMA_BACKEND_H
#define GRAFT_LLAMA_BACKEND_H

#include "graft/error.h"

mg_err_t mg_llama_backend_acquire(void);
void     mg_llama_backend_release(void);

#endif
