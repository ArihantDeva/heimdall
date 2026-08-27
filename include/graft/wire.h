#ifndef GRAFT_WIRE_H
#define GRAFT_WIRE_H

#include "graft/error.h"
#include <stddef.h>
#include <stdint.h>

/* Wire format: lunghezza (uint32_t LE) + payload MessagePack.
 * Payload e' una mappa con chiavi:
 *   "op"      string  ("classify"|"insert"|"query"|"retrieve"|"explore"|"get"|"stats"|"consolidate")
 *   "args"    map     (op-specific)
 *
 * Risposta: mappa
 *   "status"  int     (0 = MG_OK, altrimenti mg_err_t)
 *   "error"   string  (presente solo se status!=0)
 *   "result"  any     (op-specific)
 */

typedef enum {
  MG_OP_CLASSIFY = 1,
  MG_OP_INSERT,
  MG_OP_QUERY,
  MG_OP_RETRIEVE,
  MG_OP_EXPLORE,
  MG_OP_GET,
  MG_OP_STATS,
  MG_OP_CONSOLIDATE,
  MG_OP_DELETE,
  MG_OP_VIEW,
  MG_OP_REMOTE_SYNC
} mg_op_t;

mg_err_t mg_wire_op_from_string(const char *s, mg_op_t *out);
const char *mg_wire_op_to_string(mg_op_t op);

/* Helper: scrivi un frame (4 byte len + payload) su fd. */
mg_err_t mg_wire_write_frame(int fd, const void *payload, size_t len);

/* Helper: leggi un frame. Alloca *out (free dopo). */
mg_err_t mg_wire_read_frame(int fd, void **out, size_t *out_len);

#endif
