#ifndef GRAFT_HTTP_H
#define GRAFT_HTTP_H

#include "graft/error.h"
#include "graft/ops.h"

/* HTTP layer (REST + viewer). Off by default. When enabled, the daemon
 * spawns a background TCP listener on cfg->http_bind:cfg->http_port and
 * serves a small set of endpoints under /v1/*.
 *
 * Local-first design: defaults bind to 127.0.0.1. Public production
 * exposure should go through the Python OAuth/OIDC gateway.
 *
 * The HTTP layer is a thin transport over the existing op_* handlers:
 * each request is parsed, routed, dispatched as an mpack request through
 * the same dispatcher used by the unix socket, and the mpack response is
 * converted to JSON for the wire.
 */

typedef struct mg_http_server mg_http_server_t;

/* Start the HTTP server in a background thread. Returns MG_OK on success;
 * the returned handle owns the listening socket and the worker thread.
 * No-op (returns MG_OK with *out=NULL) when cfg->http_enabled is false. */
mg_err_t mg_http_start(mg_ctx_t *ctx, mg_http_server_t **out);

/* Stop the HTTP server and join its thread. Safe on NULL. */
void mg_http_stop(mg_http_server_t *srv);

#endif
