#include "graft/types.h"

#include "blake3.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/time.h>
#include <unistd.h>
#endif

void mg_node_free(mg_node_t *n) {
  if (!n) {
    return;
  }
  free(n->title);
  free(n->body);
  free(n->author);
  n->title = NULL;
  n->body = NULL;
  n->author = NULL;
}

void mg_blake3(const uint8_t *data, size_t len, mg_hash_t out) {
  blake3_hasher hasher;
  if (!out) {
    return;
  }
  blake3_hasher_init(&hasher);
  if (data && len > 0) {
    blake3_hasher_update(&hasher, data, len);
  }
  blake3_hasher_finalize(&hasher, out, MG_HASH_BYTES);
}

static int fill_random(uint8_t *buf, size_t len) {
#ifdef _WIN32
  typedef LONG (WINAPI *bcrypt_gen_random_fn)(void *, unsigned char *, unsigned long, unsigned long);
  HMODULE bcrypt = LoadLibraryA("bcrypt.dll");
  if (bcrypt) {
    bcrypt_gen_random_fn gen = (bcrypt_gen_random_fn)(void *)GetProcAddress(bcrypt, "BCryptGenRandom");
    if (gen && gen(NULL, buf, (unsigned long)len, 0x00000002UL) == 0) {
      FreeLibrary(bcrypt);
      return 1;
    }
    FreeLibrary(bcrypt);
  }
#else
  int fd = open("/dev/urandom", O_RDONLY);
  if (fd >= 0) {
    size_t done = 0;
    while (done < len) {
      ssize_t n = read(fd, buf + done, len - done);
      if (n <= 0) {
        break;
      }
      done += (size_t)n;
    }
    close(fd);
    if (done == len) {
      return 1;
    }
  }
#endif
  return 0;
}

static int64_t unix_ms(void) {
#ifdef _WIN32
  FILETIME ft;
  ULARGE_INTEGER uli;
  GetSystemTimeAsFileTime(&ft);
  uli.LowPart = ft.dwLowDateTime;
  uli.HighPart = ft.dwHighDateTime;
  return (int64_t)((uli.QuadPart / 10000ULL) - 11644473600000ULL);
#else
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return ((int64_t)tv.tv_sec * 1000) + ((int64_t)tv.tv_usec / 1000);
#endif
}

void mg_uuidv7(mg_node_id_t out) {
  static uint64_t fallback_counter = 0;
  uint8_t rnd[10];
  uint64_t ts;
  size_t i;

  if (!out) {
    return;
  }
  if (!fill_random(rnd, sizeof(rnd))) {
    uint64_t seed = (uint64_t)time(NULL) ^ (++fallback_counter * 0x9e3779b97f4a7c15ULL);
    for (i = 0; i < sizeof(rnd); ++i) {
      seed ^= seed << 13;
      seed ^= seed >> 7;
      seed ^= seed << 17;
      rnd[i] = (uint8_t)(seed >> 8);
    }
  }

  ts = (uint64_t)unix_ms() & 0x0000FFFFFFFFFFFFULL;
  out[0] = (uint8_t)(ts >> 40);
  out[1] = (uint8_t)(ts >> 32);
  out[2] = (uint8_t)(ts >> 24);
  out[3] = (uint8_t)(ts >> 16);
  out[4] = (uint8_t)(ts >> 8);
  out[5] = (uint8_t)ts;
  out[6] = (uint8_t)(0x70U | (rnd[0] & 0x0FU));
  out[7] = rnd[1];
  out[8] = (uint8_t)(0x80U | (rnd[2] & 0x3FU));
  memcpy(out + 9, rnd + 3, 7);
}
