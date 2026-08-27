#ifndef GRAFT_CLI_AUTOSTART_H
#define GRAFT_CLI_AUTOSTART_H

#include "graft/error.h"
#include <stddef.h>

/* Auto-start graftd if it's not already listening on socket_path.
 * Locates graftd next to the running CLI binary, spawns it detached with
 * a sane environment, and polls the socket for readiness with a hard
 * deadline. Returns MG_OK if the socket eventually accepts connections.
 *
 * On error, fills err (when non-NULL and err_cap > 0) with a one-line
 * human-readable reason — surface this verbatim to the user so they can
 * fix the underlying problem (missing binary, missing model, etc.). */
mg_err_t mg_autostart_daemon(const char *socket_path, char *err, size_t err_cap);

#endif
