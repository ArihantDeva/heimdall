#ifndef GRAFT_CLI_USAGE_LOG_H
#define GRAFT_CLI_USAGE_LOG_H

#include <stdint.h>
#include <stddef.h>

/* Append one usage record as a single JSON line to the usage log file.
 * The log path resolves to:
 *   - $GRAFT_USAGE_LOG (if set), else
 *   - $HOME/.graft/usage.jsonl    (POSIX), or
 *   - %LOCALAPPDATA%/graft/usage.jsonl (Windows).
 *
 * `op`, `hit`, `id_hex` may be NULL/empty. `latency_ms` and `status` are
 * always written. The record schema is:
 *   {"ts":<unix-seconds>,"op":"...","status":<int>,"latency_ms":<int>,
 *    "hit":"STRONG"|"WEAK"|"MISS"|null,"id_hex":"..."|null}
 *
 * Best-effort: failures to write are silently ignored — the user's command
 * has already succeeded by the time we log. */
void mg_usage_log_append(const char *op,
                         int          status,
                         int          latency_ms,
                         const char  *hit,
                         const char  *id_hex);

/* Resolve the usage log path. Returns 0 on success, fills `out` (cap >= 1).
 * Returns -1 if no path can be resolved (no HOME and no LOCALAPPDATA). */
int mg_usage_log_path(char *out, size_t cap);

/* Run the `graft analytics` command: read the usage log, aggregate, and
 * print a JSON-ish summary to stdout. Returns 0 on success. */
int mg_usage_analytics(int argc, char **argv);

#endif
