/* Wire protocol primitives.
 *
 * Frame format on the socket:
 *   [4 bytes  payload length, little-endian uint32]
 *   [N bytes  MessagePack payload]
 *
 * Maximum payload accepted: 16 MiB. Larger frames are rejected as
 * MG_ERR_WIRE without consuming the rest (caller should close the fd).
 */

#include "graft/wire.h"
#include "graft/error.h"

#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#ifdef _WIN32
#  include <winsock2.h>
#  define MG_RECV(fd, buf, n) recv((SOCKET)(fd), (char *)(buf), (int)(n), 0)
#  define MG_SEND(fd, buf, n) send((SOCKET)(fd), (const char *)(buf), (int)(n), 0)
#else
#  include <sys/socket.h>
#  include <unistd.h>
#  define MG_RECV(fd, buf, n) recv((fd), (buf), (n), 0)
#  define MG_SEND(fd, buf, n) send((fd), (buf), (n), 0)
#endif

#define MG_FRAME_MAX (16u * 1024u * 1024u)  /* 16 MiB */

mg_err_t mg_wire_op_from_string(const char *s, mg_op_t *out) {
    if (!s || !out) return MG_ERR_INVALID_ARG;
    if (!strcmp(s, "classify"))    { *out = MG_OP_CLASSIFY;    return MG_OK; }
    if (!strcmp(s, "insert"))      { *out = MG_OP_INSERT;      return MG_OK; }
    if (!strcmp(s, "query"))       { *out = MG_OP_QUERY;       return MG_OK; }
    if (!strcmp(s, "retrieve"))    { *out = MG_OP_RETRIEVE;    return MG_OK; }
    if (!strcmp(s, "explore"))     { *out = MG_OP_EXPLORE;     return MG_OK; }
    if (!strcmp(s, "get"))         { *out = MG_OP_GET;         return MG_OK; }
    if (!strcmp(s, "stats"))       { *out = MG_OP_STATS;       return MG_OK; }
    if (!strcmp(s, "consolidate")) { *out = MG_OP_CONSOLIDATE; return MG_OK; }
    if (!strcmp(s, "delete"))      { *out = MG_OP_DELETE;      return MG_OK; }
    if (!strcmp(s, "view"))        { *out = MG_OP_VIEW;        return MG_OK; }
    if (!strcmp(s, "remote_sync")) { *out = MG_OP_REMOTE_SYNC; return MG_OK; }
    return MG_ERR_INVALID_ARG;
}

const char *mg_wire_op_to_string(mg_op_t op) {
    switch (op) {
        case MG_OP_CLASSIFY:    return "classify";
        case MG_OP_INSERT:      return "insert";
        case MG_OP_QUERY:       return "query";
        case MG_OP_RETRIEVE:    return "retrieve";
        case MG_OP_EXPLORE:     return "explore";
        case MG_OP_GET:         return "get";
        case MG_OP_STATS:       return "stats";
        case MG_OP_CONSOLIDATE: return "consolidate";
        case MG_OP_DELETE:      return "delete";
        case MG_OP_VIEW:        return "view";
        case MG_OP_REMOTE_SYNC: return "remote_sync";
    }
    return NULL;
}

static mg_err_t read_all(int fd, void *buf, size_t n) {
    uint8_t *p = (uint8_t *)buf;
    while (n > 0) {
#ifdef _WIN32
        int got = MG_RECV(fd, p, n);
#else
        ssize_t got = MG_RECV(fd, p, n);
#endif
        if (got == 0)  return MG_ERR_IO;   /* EOF */
        if (got <  0)  return MG_ERR_IO;   /* error or interrupted */
        p += got;
        n -= (size_t)got;
    }
    return MG_OK;
}

static mg_err_t write_all(int fd, const void *buf, size_t n) {
    const uint8_t *p = (const uint8_t *)buf;
    while (n > 0) {
#ifdef _WIN32
        int sent = MG_SEND(fd, p, n);
#else
        ssize_t sent = MG_SEND(fd, p, n);
#endif
        if (sent <= 0) return MG_ERR_IO;
        p += sent;
        n -= (size_t)sent;
    }
    return MG_OK;
}

mg_err_t mg_wire_write_frame(int fd, const void *payload, size_t len) {
    if (len > 0 && !payload) return MG_ERR_INVALID_ARG;
    if (len > MG_FRAME_MAX)  return MG_ERR_INVALID_ARG;

    uint8_t hdr[4];
    uint32_t l = (uint32_t)len;
    hdr[0] = (uint8_t)(l        & 0xff);
    hdr[1] = (uint8_t)((l >> 8)  & 0xff);
    hdr[2] = (uint8_t)((l >> 16) & 0xff);
    hdr[3] = (uint8_t)((l >> 24) & 0xff);

    mg_err_t e = write_all(fd, hdr, 4);
    if (e != MG_OK) return e;
    if (len > 0) e = write_all(fd, payload, len);
    return e;
}

mg_err_t mg_wire_read_frame(int fd, void **out, size_t *out_len) {
    if (!out || !out_len) return MG_ERR_INVALID_ARG;
    *out = NULL;
    *out_len = 0;

    uint8_t hdr[4];
    mg_err_t e = read_all(fd, hdr, 4);
    if (e != MG_OK) return e;

    uint32_t l = (uint32_t)hdr[0]
               | ((uint32_t)hdr[1] << 8)
               | ((uint32_t)hdr[2] << 16)
               | ((uint32_t)hdr[3] << 24);

    if (l > MG_FRAME_MAX) return MG_ERR_WIRE;
    if (l == 0) return MG_OK;

    void *buf = malloc(l);
    if (!buf) return MG_ERR_OOM;

    e = read_all(fd, buf, l);
    if (e != MG_OK) { free(buf); return e; }

    *out     = buf;
    *out_len = l;
    return MG_OK;
}
