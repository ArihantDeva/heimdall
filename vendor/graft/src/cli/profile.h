#ifndef GRAFT_CLI_PROFILE_H
#define GRAFT_CLI_PROFILE_H

#include <stddef.h>

/* Profiles tenant-isolate the memory graph. Each profile is a directory
 * under GRAFT_HOME (`$HOME/.graft` POSIX, same on Windows)
 * holding its own SQLite DB and getting its own daemon listening on its
 * own AF_UNIX socket.
 *
 * The active profile is whatever $GRAFT_PROFILE says, or "default" if
 * the env var is unset. `graft profile set <name>` does NOT mutate
 * persistent state — it just prints the export line so the user can apply
 * it to the current shell. This keeps the rules dead simple: env or default.
 *
 * The "default" profile is auto-created on first daemon start and cannot
 * be removed.
 *
 * The CLI is the only component that knows about profiles. The daemon just
 * honors GRAFT_SOCKET / GRAFT_DB_PATH env overrides set by the CLI.
 */

#define MG_PROFILE_DEFAULT "default"

/* Resolve GRAFT_HOME. Creates the directory if missing. */
int  mg_profile_home(char *out, size_t cap);

/* Resolve the active profile name. Always returns 0 (falls back to "default"). */
int  mg_profile_active(char *out, size_t cap);

/* Compute paths for a given profile. All return 0 on success.
 * `dir`   = <home>/profiles/<name>
 * `db`    = <home>/profiles/<name>/graft.db
 * `sock`  = <home>/sockets/<name>.sock
 * Parent dirs are created when needed. */
int  mg_profile_dir       (const char *name, char *out, size_t cap, int create);
int  mg_profile_db_path   (const char *name, char *out, size_t cap, int create);
int  mg_profile_socket_path(const char *name, char *out, size_t cap, int create);

/* Return 1 if a profile with that name exists on disk, else 0. */
int  mg_profile_exists(const char *name);

/* Validate a profile name: [a-zA-Z0-9_-]{1,64}. Returns 0 on valid. */
int  mg_profile_name_valid(const char *name);

/* Dispatcher for `graft profile <subcommand> ...`.
 * argv[0]=graft, argv[1]=profile, argv[2]=subcommand, ... */
int  mg_profile_cmd(int argc, char **argv);

#endif
