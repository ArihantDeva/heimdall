#include "graft/llama_backend.h"

#if defined(_WIN32) && !defined(__MINGW32__) && !defined(__MINGW64__)
#include <windows.h>
#else
#include <pthread.h>
#endif

#include <llama.h>

#if defined(_WIN32) && !defined(__MINGW32__) && !defined(__MINGW64__)
typedef SRWLOCK mg_backend_mutex_t;
#define MG_BACKEND_MUTEX_INITIALIZER SRWLOCK_INIT
static int mg_backend_mutex_lock(mg_backend_mutex_t *lock) {
  AcquireSRWLockExclusive(lock);
  return 0;
}
static int mg_backend_mutex_unlock(mg_backend_mutex_t *lock) {
  ReleaseSRWLockExclusive(lock);
  return 0;
}
#else
typedef pthread_mutex_t mg_backend_mutex_t;
#define MG_BACKEND_MUTEX_INITIALIZER PTHREAD_MUTEX_INITIALIZER
static int mg_backend_mutex_lock(mg_backend_mutex_t *lock) {
  return pthread_mutex_lock(lock);
}
static int mg_backend_mutex_unlock(mg_backend_mutex_t *lock) {
  return pthread_mutex_unlock(lock);
}
#endif

static mg_backend_mutex_t g_backend_lock = MG_BACKEND_MUTEX_INITIALIZER;
static int g_backend_refs = 0;

mg_err_t mg_llama_backend_acquire(void) {
  if (mg_backend_mutex_lock(&g_backend_lock) != 0) {
    return MG_ERR_INTERNAL;
  }
  if (g_backend_refs == 0) {
    llama_backend_init();
  }
  g_backend_refs++;
  if (mg_backend_mutex_unlock(&g_backend_lock) != 0) {
    return MG_ERR_INTERNAL;
  }
  return MG_OK;
}

void mg_llama_backend_release(void) {
  if (mg_backend_mutex_lock(&g_backend_lock) != 0) {
    return;
  }
  if (g_backend_refs > 0) {
    g_backend_refs--;
    if (g_backend_refs == 0) {
      llama_backend_free();
    }
  }
  (void)mg_backend_mutex_unlock(&g_backend_lock);
}
