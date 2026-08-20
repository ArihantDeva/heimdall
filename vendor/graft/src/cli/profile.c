/* graft CLI — profile management.
 *
 * A profile tenant-isolates the graph: each profile gets its own SQLite
 * DB file and its own daemon listening on its own socket.
 *
 *   <GRAFT_HOME>/profiles/<name>/graft.db   — the per-profile DB
 *
 * Socket path:
 *   POSIX  : /tmp/graft-<name>.sock
 *   Windows: <GRAFT_HOME>\sockets\<name>.sock
 *
 * The CLI is the only component that knows about profiles. Before
 * connecting to (or auto-starting) the daemon, main.c sets GRAFT_SOCKET
 * and GRAFT_DB_PATH in its own env, which the daemon honors as
 * overrides on top of the YAML config.
 *
 * Export/import use a plain file copy (the file IS a SQLite DB carrying
 * the full graph). Both operations refuse when a daemon is running on
 * the affected profile, to avoid copying mid-write WAL state.
 */

#include "profile.h"
#include "autostart.h"
#include "../daemon/internal.h"
#include "graft/error.h"
#include "graft/storage.h"
#include "graft/wire.h"
#include "mpack.h"

#include <ctype.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <direct.h>
#  include <process.h>
#  define MG_PATH_SEP '\\'
#  define mg_mkdir(p) _mkdir(p)
#  define mg_unlink(p) _unlink(p)
#  define mg_setenv(k, v) _putenv_s((k), (v))
#  define mg_getpid() _getpid()
#  define mg_sleep_sec(s) Sleep((DWORD)((s) * 1000))
#else
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <sys/wait.h>
#  include <fcntl.h>
#  include <unistd.h>
#  include <dirent.h>
#  include <errno.h>
#  define MG_PATH_SEP '/'
#  define mg_mkdir(p) mkdir((p), 0755)
#  define mg_unlink(p) unlink(p)
#  define mg_setenv(k, v) setenv((k), (v), 1)
#  define mg_getpid() getpid()
#  define mg_sleep_sec(s) sleep((unsigned)(s))
#endif

#define MG_AUTOSYNC_DEFAULT_INTERVAL 300

static int profile_usage(void);

/* ---------- helpers ---------- */

/* Print a string as a JSON-quoted value. Escapes \, ", \n, \r, \t and any
 * control char < 0x20. Crucial on Windows where paths contain backslashes
 * — without this the emitted JSON breaks any json.loads on the consumer. */
static void print_json_str(const char *s) {
    fputc('"', stdout);
    if (s) {
        for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
            unsigned char c = *p;
            switch (c) {
                case '"':  fputs("\\\"", stdout); break;
                case '\\': fputs("\\\\", stdout); break;
                case '\n': fputs("\\n",  stdout); break;
                case '\r': fputs("\\r",  stdout); break;
                case '\t': fputs("\\t",  stdout); break;
                default:
                    if (c < 0x20) printf("\\u%04x", c);
                    else          fputc((int)c, stdout);
            }
        }
    }
    fputc('"', stdout);
}

static int file_exists(const char *p) {
#ifdef _WIN32
    DWORD a = GetFileAttributesA(p);
    return (a != INVALID_FILE_ATTRIBUTES) ? 1 : 0;
#else
    struct stat st;
    return (stat(p, &st) == 0) ? 1 : 0;
#endif
}

static int dir_exists(const char *p) {
#ifdef _WIN32
    DWORD a = GetFileAttributesA(p);
    return (a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY)) ? 1 : 0;
#else
    struct stat st;
    return (stat(p, &st) == 0 && S_ISDIR(st.st_mode)) ? 1 : 0;
#endif
}

/* mkdir -p — create each intermediate component. Returns 0 on success. */
static int mkdir_p(const char *path) {
    char buf[1024];
    size_t n = strlen(path);
    if (n >= sizeof(buf)) return -1;
    memcpy(buf, path, n + 1);
    for (size_t i = 1; i <= n; i++) {
        if (i == n || buf[i] == MG_PATH_SEP) {
            char saved = buf[i];
            buf[i] = '\0';
            if (!dir_exists(buf)) {
                if (mg_mkdir(buf) != 0) {
                    /* race-tolerant: another caller may have created it */
                    if (!dir_exists(buf)) {
                        buf[i] = saved;
                        return -1;
                    }
                }
            }
            buf[i] = saved;
        }
    }
    return 0;
}

static int rmdir_recursive(const char *path) {
#ifdef _WIN32
    char pattern[1024];
    int pn = snprintf(pattern, sizeof(pattern), "%s\\*", path);
    if (pn < 0 || (size_t)pn >= sizeof(pattern)) {
        fprintf(stderr, "warning: path too long, skipping: %s\n", path);
        return -1;
    }
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pattern, &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (!strcmp(fd.cFileName, ".") || !strcmp(fd.cFileName, "..")) continue;
            char child[1024];
            int cn = snprintf(child, sizeof(child), "%s\\%s", path, fd.cFileName);
            if (cn < 0 || (size_t)cn >= sizeof(child)) {
                /* Truncated path would target the wrong file — skip it
                 * rather than risk deleting an unrelated entry. */
                fprintf(stderr, "warning: path too long, skipping: %s\\%s\n",
                        path, fd.cFileName);
                continue;
            }
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                rmdir_recursive(child);
            else
                DeleteFileA(child);
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
    return RemoveDirectoryA(path) ? 0 : -1;
#else
    DIR *d = opendir(path);
    if (d) {
        struct dirent *de;
        while ((de = readdir(d))) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            char child[1024];
            int cn = snprintf(child, sizeof(child), "%s/%s", path, de->d_name);
            if (cn < 0 || (size_t)cn >= sizeof(child)) {
                fprintf(stderr, "warning: path too long, skipping: %s/%s\n",
                        path, de->d_name);
                continue;
            }
            struct stat st;
            if (stat(child, &st) == 0) {
                if (S_ISDIR(st.st_mode)) rmdir_recursive(child);
                else                     unlink(child);
            }
        }
        closedir(d);
    }
    return rmdir(path);
#endif
}

static int copy_file(const char *src, const char *dst) {
    FILE *fi = fopen(src, "rb");
    if (!fi) return -1;
    FILE *fo = fopen(dst, "wb");
    if (!fo) { fclose(fi); return -1; }
    char buf[64 * 1024];
    size_t n;
    int rc = 0;
    while ((n = fread(buf, 1, sizeof(buf), fi)) > 0) {
        if (fwrite(buf, 1, n, fo) != n) { rc = -1; break; }
    }
    if (ferror(fi)) rc = -1;
    fclose(fi);
    if (fclose(fo) != 0) rc = -1;
    return rc;
}

/* SQLite header magic — first 16 bytes of any SQLite DB file. */
static int looks_like_sqlite(const char *path) {
    static const char magic[] = "SQLite format 3";
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    char buf[16] = { 0 };
    size_t n = fread(buf, 1, 16, f);
    fclose(f);
    return (n >= 16 && memcmp(buf, magic, 15) == 0 && buf[15] == 0) ? 1 : 0;
}

/* Probe whether a daemon is currently listening on `socket_path`. */
static int daemon_running(const char *socket_path) {
    int fd = -1;
    if (mg_daemon_socket_connect(socket_path, &fd) == MG_OK) {
        mg_daemon_socket_close(fd);
        return 1;
    }
    return 0;
}

/* ---------- name validation ---------- */

int mg_profile_name_valid(const char *name) {
    if (!name) return -1;
    size_t n = strlen(name);
    if (n == 0 || n > 64) return -1;
    for (size_t i = 0; i < n; i++) {
        char c = name[i];
        if (!(isalnum((unsigned char)c) || c == '_' || c == '-')) return -1;
    }
    return 0;
}

/* ---------- path resolution ---------- */

int mg_profile_home(char *out, size_t cap) {
    const char *env = getenv("GRAFT_HOME");
    if (env && *env) {
        if (snprintf(out, cap, "%s", env) >= (int)cap) return -1;
    } else {
#ifdef _WIN32
        const char *base = getenv("USERPROFILE");
        if (!base || !*base) base = getenv("LOCALAPPDATA");
        if (!base || !*base) return -1;
        if (snprintf(out, cap, "%s\\.graft", base) >= (int)cap) return -1;
#else
        const char *home = getenv("HOME");
        if (!home || !*home) return -1;
        if (snprintf(out, cap, "%s/.graft", home) >= (int)cap) return -1;
#endif
    }
    if (mkdir_p(out) != 0) return -1;
    return 0;
}

int mg_profile_active(char *out, size_t cap) {
    const char *env = getenv("GRAFT_PROFILE");
    if (env && *env && mg_profile_name_valid(env) == 0) {
        if (snprintf(out, cap, "%s", env) >= (int)cap) return -1;
        return 0;
    }
    if (snprintf(out, cap, "%s", MG_PROFILE_DEFAULT) >= (int)cap) return -1;
    return 0;
}

int mg_profile_dir(const char *name, char *out, size_t cap, int create) {
    char home[1024];
    if (mg_profile_home(home, sizeof(home)) != 0) return -1;
    if (snprintf(out, cap, "%s%cprofiles%c%s", home, MG_PATH_SEP, MG_PATH_SEP, name) >= (int)cap)
        return -1;
    if (create && mkdir_p(out) != 0) return -1;
    return 0;
}

int mg_profile_db_path(const char *name, char *out, size_t cap, int create) {
    char dir[1024];
    if (mg_profile_dir(name, dir, sizeof(dir), create) != 0) return -1;
    if (snprintf(out, cap, "%s%cgraft.db", dir, MG_PATH_SEP) >= (int)cap) return -1;
    return 0;
}

int mg_profile_socket_path(const char *name, char *out, size_t cap, int create) {
#ifdef _WIN32
    char home[1024];
    if (mg_profile_home(home, sizeof(home)) != 0) return -1;
    char dir[1024];
    if (snprintf(dir, sizeof(dir), "%s\\sockets", home) >= (int)sizeof(dir)) return -1;
    if (create && mkdir_p(dir) != 0) return -1;
    if (snprintf(out, cap, "%s\\%s.sock", dir, name) >= (int)cap) return -1;
    (void)create;
    return 0;
#else
    (void)create;
    if (snprintf(out, cap, "/tmp/graft-%s.sock", name) >= (int)cap) return -1;
    return 0;
#endif
}

int mg_profile_exists(const char *name) {
    if (mg_profile_name_valid(name) != 0) return 0;
    char dir[1024];
    if (mg_profile_dir(name, dir, sizeof(dir), 0) != 0) return 0;
    return dir_exists(dir);
}

/* ---------- subcommands ---------- */

static int cmd_list(void) {
    char home[1024];
    if (mg_profile_home(home, sizeof(home)) != 0) {
        fprintf(stderr, "cannot resolve GRAFT_HOME\n");
        return 1;
    }
    char active[128];
    mg_profile_active(active, sizeof(active));

    char profiles_dir[1024];
    int pdn = snprintf(profiles_dir, sizeof(profiles_dir), "%s%cprofiles", home, MG_PATH_SEP);
    if (pdn < 0 || (size_t)pdn >= sizeof(profiles_dir)) {
        fprintf(stderr, "GRAFT_HOME path too long to derive profiles dir\n");
        return 1;
    }
    if (!dir_exists(profiles_dir)) (void)mkdir_p(profiles_dir);

    fputs("{\n  \"home\": ", stdout); print_json_str(home);
    fputs(",\n  \"active\": ", stdout); print_json_str(active);
    fputs(",\n  \"profiles\": [", stdout);
    int first = 1;

#ifdef _WIN32
    char pat[1024];
    int patn = snprintf(pat, sizeof(pat), "%s\\*", profiles_dir);
    if (patn < 0 || (size_t)patn >= sizeof(pat)) {
        fputs(first ? "]\n}\n" : "\n  ]\n}\n", stdout);
        fprintf(stderr, "warning: profiles dir path too long: %s\n", profiles_dir);
        return 1;
    }
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pat, &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
            if (!strcmp(fd.cFileName, ".") || !strcmp(fd.cFileName, "..")) continue;
            fputs(first ? "\n    " : ",\n    ", stdout);
            print_json_str(fd.cFileName);
            first = 0;
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
#else
    DIR *d = opendir(profiles_dir);
    if (d) {
        struct dirent *de;
        while ((de = readdir(d))) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            char child[1024];
            int cn = snprintf(child, sizeof(child), "%s/%s", profiles_dir, de->d_name);
            if (cn < 0 || (size_t)cn >= sizeof(child)) {
                fprintf(stderr, "warning: path too long, skipping: %s/%s\n",
                        profiles_dir, de->d_name);
                continue;
            }
            if (!dir_exists(child)) continue;
            fputs(first ? "\n    " : ",\n    ", stdout);
            print_json_str(de->d_name);
            first = 0;
        }
        closedir(d);
    }
#endif
    fputs(first ? "]\n}\n" : "\n  ]\n}\n", stdout);
    return 0;
}

static int cmd_current(void) {
    char active[128];
    mg_profile_active(active, sizeof(active));
    fputs("{\n  \"active\": ", stdout);
    print_json_str(active);
    fputs("\n}\n", stdout);
    return 0;
}

static int cmd_add(const char *name) {
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name (allowed: [a-zA-Z0-9_-]{1,64})\n");
        return 2;
    }
    if (mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' already exists\n", name);
        return 1;
    }
    char dir[1024];
    if (mg_profile_dir(name, dir, sizeof(dir), 1) != 0) {
        fprintf(stderr, "failed to create profile dir\n");
        return 1;
    }
    fputs("{\n  \"created\": ", stdout); print_json_str(name);
    fputs(",\n  \"dir\": ", stdout);     print_json_str(dir);
    fputs("\n}\n", stdout);
    return 0;
}

static int cmd_remove(const char *name, int yes) {
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!strcmp(name, MG_PROFILE_DEFAULT)) {
        fprintf(stderr, "profile 'default' cannot be removed\n");
        return 1;
    }
    if (!mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' does not exist\n", name);
        return 1;
    }
    char sock[1024];
    if (mg_profile_socket_path(name, sock, sizeof(sock), 0) == 0
        && daemon_running(sock)) {
        fprintf(stderr, "a daemon is currently running for profile '%s' — stop it first\n",
                name);
        return 1;
    }
    if (!yes) {
        fprintf(stderr, "About to permanently delete profile '%s' and ALL its data.\n", name);
        fprintf(stderr, "Type the profile name again to confirm: ");
        fflush(stderr);
        char buf[128] = { 0 };
        if (!fgets(buf, sizeof(buf), stdin)) return 1;
        size_t l = strlen(buf);
        while (l > 0 && (buf[l - 1] == '\n' || buf[l - 1] == '\r')) buf[--l] = '\0';
        if (strcmp(buf, name) != 0) {
            fprintf(stderr, "confirmation did not match — aborted\n");
            return 1;
        }
    }
    char dir[1024];
    if (mg_profile_dir(name, dir, sizeof(dir), 0) != 0) return 1;
    if (rmdir_recursive(dir) != 0) {
        fprintf(stderr, "failed to remove %s\n", dir);
        return 1;
    }
    fputs("{\n  \"removed\": ", stdout); print_json_str(name);
    fputs("\n}\n", stdout);
    return 0;
}

static int detect_shell_syntax(const char *hint, char *out, size_t cap) {
    /* Returns the env-export syntax for the current shell. Honors --shell flag
     * if given; otherwise sniffs from $SHELL / OS. */
    if (hint) {
        if (!strcmp(hint, "bash") || !strcmp(hint, "zsh") || !strcmp(hint, "sh")) {
            snprintf(out, cap, "posix"); return 0;
        }
        if (!strcmp(hint, "fish")) { snprintf(out, cap, "fish"); return 0; }
        if (!strcmp(hint, "powershell") || !strcmp(hint, "pwsh")) {
            snprintf(out, cap, "powershell"); return 0;
        }
        if (!strcmp(hint, "cmd")) { snprintf(out, cap, "cmd"); return 0; }
    }
    /* On Windows the binary may still be invoked from a POSIX-ish shell
     * (Git Bash, MSYS2, WSL, Cygwin). Trust $SHELL when present — it tells
     * us what the user actually typed in. Only fall back to PowerShell when
     * there's no signal, which is the typical native-Windows case. */
    const char *sh = getenv("SHELL");
    if (sh && *sh) {
        if (strstr(sh, "fish"))                                       snprintf(out, cap, "fish");
        else if (strstr(sh, "bash") || strstr(sh, "zsh") || strstr(sh, "sh")) snprintf(out, cap, "posix");
        else                                                          snprintf(out, cap, "posix");
        return 0;
    }
#ifdef _WIN32
    snprintf(out, cap, "powershell");
#else
    snprintf(out, cap, "posix");
#endif
    return 0;
}

static int cmd_set(const char *name, const char *shell_hint) {
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!mg_profile_exists(name) && strcmp(name, MG_PROFILE_DEFAULT) != 0) {
        fprintf(stderr, "profile '%s' does not exist (run: graft profile add %s)\n",
                name, name);
        return 1;
    }
    /* Print the export line for the detected shell. The CLI cannot mutate
     * the parent shell's env directly, so the user pipes this into eval /
     * Invoke-Expression. To make it persistent, the user adds the printed
     * line to their shell rc file themselves. */
    char syntax[16];
    detect_shell_syntax(shell_hint, syntax, sizeof(syntax));
    if (!strcmp(syntax, "fish")) {
        printf("set -x GRAFT_PROFILE %s\n", name);
    } else if (!strcmp(syntax, "powershell")) {
        printf("$env:GRAFT_PROFILE = '%s'\n", name);
    } else if (!strcmp(syntax, "cmd")) {
        printf("set GRAFT_PROFILE=%s\n", name);
    } else {
        printf("export GRAFT_PROFILE=%s\n", name);
    }
    fprintf(stderr,
        "Apply to the current shell:\n"
        "  bash/zsh/fish:  eval \"$(graft profile set %s)\"\n"
        "  PowerShell:     graft profile set %s | Out-String | Invoke-Expression\n",
        name, name);
    return 0;
}

static int cmd_export(const char *name, const char *path) {
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!path || !*path) {
        fprintf(stderr, "--path is required\n");
        return 2;
    }
    if (!mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' does not exist\n", name);
        return 1;
    }
    char sock[1024];
    if (mg_profile_socket_path(name, sock, sizeof(sock), 0) == 0
        && daemon_running(sock)) {
        fprintf(stderr,
            "a daemon is currently running for profile '%s' — stop it first to "
            "guarantee a consistent export\n", name);
        return 1;
    }
    char db[1024];
    if (mg_profile_db_path(name, db, sizeof(db), 0) != 0) return 1;
    if (!file_exists(db)) {
        fprintf(stderr, "profile '%s' has no DB yet (nothing to export)\n", name);
        return 1;
    }
    if (copy_file(db, path) != 0) {
        fprintf(stderr, "copy failed: %s -> %s\n", db, path);
        return 1;
    }
    fputs("{\n  \"exported\": ", stdout); print_json_str(name);
    fputs(",\n  \"from\": ", stdout);     print_json_str(db);
    fputs(",\n  \"to\": ", stdout);       print_json_str(path);
    fputs("\n}\n", stdout);
    return 0;
}

static int cmd_import(const char *name, const char *path, int force) {
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!path || !*path || !file_exists(path)) {
        fprintf(stderr, "--file does not exist: %s\n", path ? path : "(none)");
        return 1;
    }
    if (!looks_like_sqlite(path)) {
        fprintf(stderr,
            "file does not look like a graft profile (missing SQLite "
            "header). Aborting to avoid corrupting the profile.\n");
        return 1;
    }
    if (mg_profile_exists(name)) {
        char sock[1024];
        if (mg_profile_socket_path(name, sock, sizeof(sock), 0) == 0
            && daemon_running(sock)) {
            fprintf(stderr,
                "profile '%s' is currently in use by a running daemon — stop it first\n",
                name);
            return 1;
        }
        if (!force) {
            fprintf(stderr,
                "profile '%s' already exists. Pass --force to overwrite its DB.\n",
                name);
            return 1;
        }
    }
    char db[1024];
    if (mg_profile_db_path(name, db, sizeof(db), 1) != 0) return 1;
    if (copy_file(path, db) != 0) {
        fprintf(stderr, "copy failed: %s -> %s\n", path, db);
        return 1;
    }
    fputs("{\n  \"imported\": ", stdout); print_json_str(name);
    fputs(",\n  \"from\": ", stdout);     print_json_str(path);
    fputs(",\n  \"to\": ", stdout);       print_json_str(db);
    fputs("\n}\n", stdout);
    return 0;
}

static int ensure_profile_file_schema(const char *path) {
    mg_storage_t *s = NULL;
    mg_err_t err = mg_storage_open(path, &s);
    if (err == MG_OK) err = mg_storage_apply_schema(s);
    if (s) mg_storage_close(s);
    return err == MG_OK ? 0 : -1;
}

static int cmd_merge(const char *into_name, const char *from_path, int overwrite) {
    if (mg_profile_name_valid(into_name) != 0) {
        fprintf(stderr, "invalid target profile name\n");
        return 2;
    }
    if (!from_path || !*from_path || !file_exists(from_path)) {
        fprintf(stderr, "--from does not exist: %s\n", from_path ? from_path : "(none)");
        return 1;
    }
    if (!looks_like_sqlite(from_path)) {
        fprintf(stderr,
            "--from is not a graft profile file (missing SQLite header)\n");
        return 1;
    }
    if (ensure_profile_file_schema(from_path) != 0) {
        fprintf(stderr, "schema apply failed on source\n");
        return 1;
    }
    if (!mg_profile_exists(into_name)) {
        fprintf(stderr,
            "target profile '%s' does not exist (run: graft profile add %s)\n",
            into_name, into_name);
        return 1;
    }

    /* Refuse if a daemon owns the target — we'd corrupt the WAL. */
    char sock[1024];
    if (mg_profile_socket_path(into_name, sock, sizeof(sock), 0) == 0
        && daemon_running(sock)) {
        fprintf(stderr,
            "daemon for profile '%s' is running — stop it first\n", into_name);
        return 1;
    }

    char db[1024];
    if (mg_profile_db_path(into_name, db, sizeof(db), 1) != 0) return 1;

    mg_storage_t *s = NULL;
    if (mg_storage_open(db, &s) != MG_OK) {
        fprintf(stderr, "cannot open target DB: %s\n", db);
        return 1;
    }
    if (mg_storage_apply_schema(s) != MG_OK) {
        fprintf(stderr, "schema apply failed on target\n");
        mg_storage_close(s);
        return 1;
    }

    int64_t n_before = 0, kw_before = 0, e_before = 0;
    (void)mg_storage_count(s, MG_STORAGE_COUNT_NODES,    &n_before);
    (void)mg_storage_count(s, MG_STORAGE_COUNT_KEYWORDS, &kw_before);
    (void)mg_storage_count(s, MG_STORAGE_COUNT_EDGES,    &e_before);

    mg_err_t err = mg_storage_merge_from(s, from_path, overwrite);

    int64_t n_after = 0, kw_after = 0, e_after = 0;
    (void)mg_storage_count(s, MG_STORAGE_COUNT_NODES,    &n_after);
    (void)mg_storage_count(s, MG_STORAGE_COUNT_KEYWORDS, &kw_after);
    (void)mg_storage_count(s, MG_STORAGE_COUNT_EDGES,    &e_after);
    mg_storage_close(s);

    if (err != MG_OK) {
        fprintf(stderr, "merge failed: %s\n", mg_strerror(err));
        return 1;
    }

    fputs("{\n  \"merged_into\": ", stdout); print_json_str(into_name);
    fputs(",\n  \"from\": ", stdout);        print_json_str(from_path);
    fputs(",\n  \"on_conflict\": ", stdout); print_json_str(overwrite ? "overwrite" : "skip");
    printf(",\n  \"added\": {\"nodes\": %lld, \"keywords\": %lld, \"edges\": %lld},\n"
           "  \"target_totals\": {\"nodes\": %lld, \"keywords\": %lld, \"edges\": %lld}\n}\n",
           (long long)(n_after - n_before),
           (long long)(kw_after - kw_before),
           (long long)(e_after - e_before),
           (long long)n_after, (long long)kw_after, (long long)e_after);
    return 0;
}

static int remote_meta_path(const char *name, char *out, size_t cap, int create) {
    char dir[1024];
    if (mg_profile_dir(name, dir, sizeof(dir), create) != 0) return -1;
    if (snprintf(out, cap, "%s%cremote.conf", dir, MG_PATH_SEP) >= (int)cap) return -1;
    return 0;
}

static int read_remote_meta(const char *name, char *url, size_t url_cap,
                            char *token, size_t token_cap) {
    char path[1024];
    if (remote_meta_path(name, path, sizeof(path), 0) != 0) return -1;
    FILE *fp = fopen(path, "rb");
    if (!fp) return -1;
    if (url && url_cap) url[0] = '\0';
    if (token && token_cap) token[0] = '\0';
    char line[2048];
    while (fgets(line, sizeof(line), fp)) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = '\0';
        nl = strchr(line, '\r');
        if (nl) *nl = '\0';
        if (!strncmp(line, "url=", 4) && url && url_cap) {
            strncpy(url, line + 4, url_cap - 1);
            url[url_cap - 1] = '\0';
        } else if (!strncmp(line, "token=", 6) && token && token_cap) {
            strncpy(token, line + 6, token_cap - 1);
            token[token_cap - 1] = '\0';
        }
    }
    fclose(fp);
    return (url && *url) ? 0 : -1;
}

static int write_remote_meta(const char *name, const char *url, const char *token) {
    char path[1024];
    if (remote_meta_path(name, path, sizeof(path), 1) != 0) return -1;
    FILE *fp = fopen(path, "wb");
    if (!fp) return -1;
#ifndef _WIN32
    /* This file may hold a remote auth token. Tighten permissions to the
     * owning user before writing any bytes; on Windows the default ACL
     * inherits from %USERPROFILE% which is already per-user. */
    (void)fchmod(fileno(fp), 0600);
#endif
    fprintf(fp, "url=%s\n", url ? url : "");
    if (token && *token) fprintf(fp, "token=%s\n", token);
    return fclose(fp) == 0 ? 0 : -1;
}

static int is_http_url(const char *s) {
    return s && (!strncmp(s, "http://", 7) || !strncmp(s, "https://", 8));
}

static int cmd_remote_bind(const char *name, const char *url, const char *token) {
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!url || !*url) {
        fprintf(stderr, "--url is required\n");
        return 2;
    }
    if (!mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' does not exist (run: graft profile add %s)\n",
                name, name);
        return 1;
    }
    if (!is_http_url(url) && !file_exists(url)) {
        fprintf(stderr, "remote file does not exist: %s\n", url);
        return 1;
    }
    if (!is_http_url(url) && !looks_like_sqlite(url)) {
        fprintf(stderr, "remote file is not a graft SQLite profile: %s\n", url);
        return 1;
    }
    if (write_remote_meta(name, url, token) != 0) {
        fprintf(stderr, "failed to write remote metadata\n");
        return 1;
    }
    fputs("{\n  \"bound\": ", stdout); print_json_str(name);
    fputs(",\n  \"url\": ", stdout); print_json_str(url);
    fputs("\n}\n", stdout);
    return 0;
}

static int cmd_remote_detach(const char *name) {
    char path[1024];
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' does not exist\n", name);
        return 1;
    }
    if (remote_meta_path(name, path, sizeof(path), 0) != 0) return 1;
    if (file_exists(path) && mg_unlink(path) != 0) {
        fprintf(stderr, "failed to remove remote metadata: %s\n", path);
        return 1;
    }
    fputs("{\n  \"detached\": ", stdout); print_json_str(name);
    fputs("\n}\n", stdout);
    return 0;
}

static int cmd_remote_status(const char *name) {
    char url[1024], token[1024];
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' does not exist\n", name);
        return 1;
    }
    if (read_remote_meta(name, url, sizeof(url), token, sizeof(token)) != 0) {
        fputs("{\n  \"profile\": ", stdout); print_json_str(name);
        fputs(",\n  \"remote\": null\n}\n", stdout);
        return 0;
    }
    fputs("{\n  \"profile\": ", stdout); print_json_str(name);
    fputs(",\n  \"remote\": {\"url\": ", stdout); print_json_str(url);
    fputs(", \"token\": ", stdout); print_json_str(token[0] ? "set" : "none");
    fputs("}\n}\n", stdout);
    return 0;
}

/* ---------- daemon-routed sync helpers ----------
 *
 * The sync used to open the local DB directly from the CLI, which forced
 * the user to stop the daemon first. Now the CLI sends a `remote_sync`
 * frame to the per-profile daemon (auto-starting it if absent), and the
 * daemon performs the pull+push using its already-open storage handle.
 * Net effect: the user can `sync` while actively using the profile.
 */

static int apply_profile_env_for(const char *name) {
    char sock[1024], db[1024];
    if (mg_profile_socket_path(name, sock, sizeof(sock), 1) != 0) return -1;
    if (mg_profile_db_path(name, db, sizeof(db), 1) != 0) return -1;
    if (mg_setenv("GRAFT_SOCKET", sock) != 0) return -1;
    if (mg_setenv("GRAFT_DB_PATH", db) != 0) return -1;
    return 0;
}

static int connect_or_autostart(const char *sock_path, int *out_fd) {
    if (mg_daemon_socket_connect(sock_path, out_fd) == MG_OK) return 0;
    char err[256] = { 0 };
    if (mg_autostart_daemon(sock_path, err, sizeof(err)) != MG_OK) {
        fprintf(stderr, "auto-start failed: %s\n", err);
        return -1;
    }
    if (mg_daemon_socket_connect(sock_path, out_fd) != MG_OK) {
        fprintf(stderr, "connect failed after auto-start: %s\n", sock_path);
        return -1;
    }
    return 0;
}

static int send_remote_sync(const char *sock_path, const char *url,
                             int64_t *out_pulled, int64_t *out_deleted,
                             int64_t *out_pushed, char *err, size_t err_cap) {
    if (err && err_cap) err[0] = '\0';

    char  *req     = NULL;
    size_t req_len = 0;
    mpack_writer_t w;
    mpack_writer_init_growable(&w, &req, &req_len);
    mpack_start_map(&w, 2);
    mpack_write_cstr(&w, "op");
    mpack_write_cstr(&w, "remote_sync");
    mpack_write_cstr(&w, "args");
    mpack_start_map(&w, 1);
    mpack_write_cstr(&w, "url");
    mpack_write_cstr(&w, url);
    mpack_finish_map(&w);
    mpack_finish_map(&w);
    if (mpack_writer_destroy(&w) != mpack_ok) {
        free(req);
        if (err) snprintf(err, err_cap, "encode failed");
        return -1;
    }

    int fd = -1;
    if (connect_or_autostart(sock_path, &fd) != 0) {
        free(req);
        if (err) snprintf(err, err_cap, "connect failed");
        return -1;
    }
    if (mg_wire_write_frame(fd, req, req_len) != MG_OK) {
        mg_daemon_socket_close(fd);
        free(req);
        if (err) snprintf(err, err_cap, "send failed");
        return -1;
    }
    free(req);

    void  *resp     = NULL;
    size_t resp_len = 0;
    if (mg_wire_read_frame(fd, &resp, &resp_len) != MG_OK) {
        mg_daemon_socket_close(fd);
        if (err) snprintf(err, err_cap, "recv failed");
        return -1;
    }
    mg_daemon_socket_close(fd);

    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char *)resp, resp_len);
    mpack_tree_parse(&tree);
    int rc = 0;
    if (mpack_tree_error(&tree) != mpack_ok) {
        rc = -1;
        if (err) snprintf(err, err_cap, "decode failed");
    } else {
        mpack_node_t root = mpack_tree_root(&tree);
        mpack_node_t st = mpack_node_map_cstr_optional(root, "status");
        int status_int = 0;
        if (!mpack_node_is_missing(st) && !mpack_node_is_nil(st))
            status_int = (int)mpack_node_int(st);
        if (status_int != 0) {
            rc = -1;
            mpack_node_t en = mpack_node_map_cstr_optional(root, "error");
            if (err && err_cap) {
                if (!mpack_node_is_missing(en) && mpack_node_type(en) == mpack_type_str) {
                    size_t l = mpack_node_strlen(en);
                    if (l >= err_cap) l = err_cap - 1;
                    memcpy(err, mpack_node_str(en), l);
                    err[l] = '\0';
                } else {
                    snprintf(err, err_cap, "daemon status=%d", status_int);
                }
            }
        } else {
            mpack_node_t r = mpack_node_map_cstr_optional(root, "result");
            if (!mpack_node_is_missing(r) && mpack_node_type(r) == mpack_type_map) {
                mpack_node_t pn = mpack_node_map_cstr_optional(r, "pulled");
                mpack_node_t dn = mpack_node_map_cstr_optional(r, "deleted");
                mpack_node_t un = mpack_node_map_cstr_optional(r, "pushed");
                if (out_pulled  && !mpack_node_is_missing(pn)) *out_pulled  = mpack_node_i64(pn);
                if (out_deleted && !mpack_node_is_missing(dn)) *out_deleted = mpack_node_i64(dn);
                if (out_pushed  && !mpack_node_is_missing(un)) *out_pushed  = mpack_node_i64(un);
            }
        }
    }
    mpack_tree_destroy(&tree);
    free(resp);
    return rc;
}

static int cmd_remote_sync(const char *name) {
    char url[1024], token[1024], sock[1024];
    (void)token;
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' does not exist\n", name);
        return 1;
    }
    if (read_remote_meta(name, url, sizeof(url), token, sizeof(token)) != 0) {
        fprintf(stderr, "profile '%s' is not bound to a remote\n", name);
        return 1;
    }
    if (is_http_url(url)) {
        fprintf(stderr, "HTTP remote sync is not available in this build; bind a SQLite profile file path\n");
        return 1;
    }
    if (!file_exists(url) || !looks_like_sqlite(url)) {
        fprintf(stderr, "remote file is not a graft SQLite profile: %s\n", url);
        return 1;
    }
    if (ensure_profile_file_schema(url) != 0) {
        fprintf(stderr, "schema apply failed on remote\n");
        return 1;
    }
    if (apply_profile_env_for(name) != 0) {
        fprintf(stderr, "failed to resolve profile paths\n");
        return 1;
    }
    if (mg_profile_socket_path(name, sock, sizeof(sock), 1) != 0) return 1;

    int64_t pulled = 0, deleted = 0, pushed = 0;
    char err[256] = { 0 };
    if (send_remote_sync(sock, url, &pulled, &deleted, &pushed, err, sizeof(err)) != 0) {
        fprintf(stderr, "remote sync failed: %s\n", err[0] ? err : "(no detail)");
        return 1;
    }

    fputs("{\n  \"profile\": ", stdout); print_json_str(name);
    fputs(",\n  \"remote\": ", stdout); print_json_str(url);
    printf(",\n  \"pulled\": %lld,\n  \"deleted\": %lld,\n  \"pushed\": %lld\n}\n",
           (long long)pulled, (long long)deleted, (long long)pushed);
    return 0;
}

/* ---------- autosync worker (--auto / --stop / --worker-loop) ---------- */

static int autosync_pid_path(const char *name, char *out, size_t cap, int create) {
    char dir[1024];
    if (mg_profile_dir(name, dir, sizeof(dir), create) != 0) return -1;
    if (snprintf(out, cap, "%s%cautosync.pid", dir, MG_PATH_SEP) >= (int)cap) return -1;
    return 0;
}

static int autosync_log_path(const char *name, char *out, size_t cap, int create) {
    char dir[1024];
    if (mg_profile_dir(name, dir, sizeof(dir), create) != 0) return -1;
    if (snprintf(out, cap, "%s%cautosync.log", dir, MG_PATH_SEP) >= (int)cap) return -1;
    return 0;
}

static long long read_autosync_pid(const char *name) {
    char path[1024];
    if (autosync_pid_path(name, path, sizeof(path), 0) != 0) return 0;
    FILE *fp = fopen(path, "r");
    if (!fp) return 0;
    long long pid = 0;
    if (fscanf(fp, "%lld", &pid) != 1) pid = 0;
    fclose(fp);
    return pid;
}

static int process_alive(long long pid) {
    if (pid <= 0) return 0;
#ifdef _WIN32
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
    if (!h) return 0;
    DWORD ec = 0;
    int alive = (GetExitCodeProcess(h, &ec) && ec == STILL_ACTIVE) ? 1 : 0;
    CloseHandle(h);
    return alive;
#else
    if (kill((pid_t)pid, 0) == 0) return 1;
    return (errno == EPERM) ? 1 : 0;
#endif
}

static int own_exe_path(char *out, size_t cap) {
#ifdef _WIN32
    DWORD n = GetModuleFileNameA(NULL, out, (DWORD)cap);
    return (n == 0 || n >= cap) ? -1 : 0;
#elif defined(__APPLE__)
    char raw[4096];
    uint32_t rl = (uint32_t)sizeof(raw);
    if (_NSGetExecutablePath(raw, &rl) != 0) return -1;
    char resolved[4096];
    const char *p = realpath(raw, resolved);
    if (snprintf(out, cap, "%s", p ? p : raw) >= (int)cap) return -1;
    return 0;
#else
    ssize_t n = readlink("/proc/self/exe", out, cap - 1);
    if (n <= 0) return -1;
    out[n] = '\0';
    return 0;
#endif
}

#ifdef _WIN32
static int spawn_autosync_worker(const char *exe, const char *name, int interval,
                                  char *err, size_t err_cap) {
    char interval_s[32];
    snprintf(interval_s, sizeof(interval_s), "%d", interval);
    char cmdline[2048];
    snprintf(cmdline, sizeof(cmdline),
             "\"%s\" profile remote sync %s --worker-loop --interval %s",
             exe, name, interval_s);

    STARTUPINFOA si = { 0 };
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = { 0 };
    if (!CreateProcessA(exe, cmdline, NULL, NULL, FALSE,
                        DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                        NULL, NULL, &si, &pi)) {
        snprintf(err, err_cap, "CreateProcess failed (%lu)",
                 (unsigned long)GetLastError());
        return -1;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
#else
static int spawn_autosync_worker(const char *exe, const char *name, int interval,
                                  char *err, size_t err_cap) {
    char interval_s[32];
    snprintf(interval_s, sizeof(interval_s), "%d", interval);
    pid_t pid = fork();
    if (pid < 0) {
        snprintf(err, err_cap, "fork failed: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        if (setsid() < 0) _exit(127);
        pid_t pid2 = fork();
        if (pid2 < 0) _exit(127);
        if (pid2 > 0) _exit(0);
        int devnull = open("/dev/null", O_RDONLY);
        if (devnull >= 0) { dup2(devnull, 0); close(devnull); }
        /* stdout/stderr are redirected by the worker once it resolves the
         * log path; until then we leave them attached to whatever inherited
         * from the parent. */
        char *const argv[] = {
            (char *)exe,
            (char *)"profile", (char *)"remote", (char *)"sync",
            (char *)name, (char *)"--worker-loop",
            (char *)"--interval", interval_s,
            NULL
        };
        execvp(exe, argv);
        _exit(127);
    }
    int st = 0;
    (void)waitpid(pid, &st, 0);
    return 0;
}
#endif

static int cmd_remote_sync_auto(const char *name, int interval) {
    if (interval <= 0) interval = MG_AUTOSYNC_DEFAULT_INTERVAL;

    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' does not exist\n", name);
        return 1;
    }
    char url[1024], token[1024];
    if (read_remote_meta(name, url, sizeof(url), token, sizeof(token)) != 0) {
        fprintf(stderr, "profile '%s' is not bound to a remote (bind one with `graft profile remote bind` first)\n", name);
        return 1;
    }
    (void)token;

    /* Refuse to start a second worker for the same profile — they would
     * both fight for the same log/pid file and double the sync rate. */
    long long old_pid = read_autosync_pid(name);
    if (old_pid > 0 && process_alive(old_pid)) {
        fprintf(stderr, "an autosync worker is already running for profile '%s' (pid %lld). "
                        "Use `graft profile remote sync %s --stop` to stop it first.\n",
                name, old_pid, name);
        return 1;
    }
    if (old_pid > 0) {
        char pidp[1024];
        if (autosync_pid_path(name, pidp, sizeof(pidp), 0) == 0) mg_unlink(pidp);
    }

    if (apply_profile_env_for(name) != 0) {
        fprintf(stderr, "failed to resolve profile paths\n");
        return 1;
    }

    char exe[1024];
    if (own_exe_path(exe, sizeof(exe)) != 0) {
        fprintf(stderr, "cannot resolve self exe path\n");
        return 1;
    }

    char err[256] = { 0 };
    if (spawn_autosync_worker(exe, name, interval, err, sizeof(err)) != 0) {
        fprintf(stderr, "spawn failed: %s\n", err);
        return 1;
    }

    /* Wait briefly for the worker to write its pid file. */
    long long pid = 0;
    for (int i = 0; i < 40; i++) {
        pid = read_autosync_pid(name);
        if (pid > 0) break;
#ifdef _WIN32
        Sleep(100);
#else
        struct timespec ts = { 0, 100 * 1000 * 1000L };
        nanosleep(&ts, NULL);
#endif
    }

    char log[1024];
    autosync_log_path(name, log, sizeof(log), 1);

    fputs("{\n  \"autosync\": \"started\",\n  \"profile\": ", stdout);
    print_json_str(name);
    printf(",\n  \"pid\": %lld,\n  \"interval\": %d", pid, interval);
    fputs(",\n  \"log\": ", stdout); print_json_str(log);
    fputs("\n}\n", stdout);
    return 0;
}

static int cmd_remote_sync_stop(const char *name) {
    if (mg_profile_name_valid(name) != 0) {
        fprintf(stderr, "invalid profile name\n");
        return 2;
    }
    if (!mg_profile_exists(name)) {
        fprintf(stderr, "profile '%s' does not exist\n", name);
        return 1;
    }
    long long pid = read_autosync_pid(name);
    if (pid <= 0) {
        fputs("{\n  \"autosync\": \"not_running\",\n  \"profile\": ", stdout);
        print_json_str(name);
        fputs("\n}\n", stdout);
        return 0;
    }
    if (!process_alive(pid)) {
        char pidp[1024];
        if (autosync_pid_path(name, pidp, sizeof(pidp), 0) == 0) mg_unlink(pidp);
        fputs("{\n  \"autosync\": \"stale\",\n  \"profile\": ", stdout);
        print_json_str(name);
        printf(",\n  \"pid\": %lld\n}\n", pid);
        return 0;
    }
#ifdef _WIN32
    HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, (DWORD)pid);
    if (!h) {
        fprintf(stderr, "cannot open process %lld: err=%lu\n",
                pid, (unsigned long)GetLastError());
        return 1;
    }
    BOOL ok = TerminateProcess(h, 0);
    CloseHandle(h);
    if (!ok) {
        fprintf(stderr, "TerminateProcess failed (%lu)\n",
                (unsigned long)GetLastError());
        return 1;
    }
#else
    if (kill((pid_t)pid, SIGTERM) != 0) {
        fprintf(stderr, "kill failed: %s\n", strerror(errno));
        return 1;
    }
    for (int i = 0; i < 30; i++) {
        if (!process_alive(pid)) break;
        struct timespec ts = { 0, 100 * 1000 * 1000L };
        nanosleep(&ts, NULL);
    }
#endif
    char pidp[1024];
    if (autosync_pid_path(name, pidp, sizeof(pidp), 0) == 0 && file_exists(pidp))
        mg_unlink(pidp);

    fputs("{\n  \"autosync\": \"stopped\",\n  \"profile\": ", stdout);
    print_json_str(name);
    printf(",\n  \"pid\": %lld\n}\n", pid);
    return 0;
}

static volatile sig_atomic_t g_worker_stop = 0;
static void worker_on_signal(int sig) { (void)sig; g_worker_stop = 1; }

static int cmd_remote_sync_worker(const char *name, int interval) {
    if (interval <= 0) interval = MG_AUTOSYNC_DEFAULT_INTERVAL;

    char log[1024], pidp[1024];
    if (autosync_log_path(name, log, sizeof(log), 1) != 0) return 1;
    if (autosync_pid_path(name, pidp, sizeof(pidp), 1) != 0) return 1;

    /* All worker output goes to the per-profile log; the user asked
     * explicitly that the worker not write to the parent's console. */
    (void)freopen(log, "a", stderr);
    (void)freopen(log, "a", stdout);
#ifndef _WIN32
    {
        int fd = open("/dev/null", O_RDONLY);
        if (fd >= 0) { dup2(fd, 0); close(fd); }
    }
#endif

    FILE *pf = fopen(pidp, "w");
    if (pf) {
        fprintf(pf, "%lld\n", (long long)mg_getpid());
        fclose(pf);
    }

    signal(SIGTERM, worker_on_signal);
    signal(SIGINT,  worker_on_signal);

    fprintf(stderr, "[autosync %s] worker started pid=%lld interval=%ds\n",
            name, (long long)mg_getpid(), interval);
    fflush(stderr);

    while (!g_worker_stop) {
        /* Sleep in 1s chunks so SIGTERM is responsive. */
        for (int i = 0; i < interval && !g_worker_stop; i++) mg_sleep_sec(1);
        if (g_worker_stop) break;

        time_t now = time(NULL);
        struct tm tm;
#ifdef _WIN32
        gmtime_s(&tm, &now);
#else
        gmtime_r(&now, &tm);
#endif
        char ts[32];
        strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%SZ", &tm);

        char url[1024], token[1024], sock[1024];
        (void)token;
        if (read_remote_meta(name, url, sizeof(url), token, sizeof(token)) != 0) {
            fprintf(stderr, "[%s] remote.conf missing (detach?), worker exiting\n", ts);
            fflush(stderr);
            break;
        }
        if (is_http_url(url)) {
            fprintf(stderr, "[%s] HTTP remote not supported in this build, exiting\n", ts);
            fflush(stderr);
            break;
        }
        if (!file_exists(url) || !looks_like_sqlite(url)) {
            fprintf(stderr, "[%s] remote unavailable: %s — will retry next tick\n",
                    ts, url);
            fflush(stderr);
            continue;
        }
        if (mg_profile_socket_path(name, sock, sizeof(sock), 1) != 0) {
            fprintf(stderr, "[%s] cannot resolve socket path\n", ts);
            fflush(stderr);
            continue;
        }

        int64_t pulled = 0, deleted = 0, pushed = 0;
        char err[256] = { 0 };
        if (send_remote_sync(sock, url, &pulled, &deleted, &pushed,
                              err, sizeof(err)) != 0) {
            fprintf(stderr, "[%s] sync failed: %s\n", ts, err[0] ? err : "(no detail)");
        } else {
            fprintf(stderr, "[%s] sync ok pulled=%lld deleted=%lld pushed=%lld\n",
                    ts, (long long)pulled, (long long)deleted, (long long)pushed);
        }
        fflush(stderr);
    }

    fprintf(stderr, "[autosync %s] worker stopping\n", name);
    fflush(stderr);
    mg_unlink(pidp);
    return 0;
}

static int cmd_remote(int argc, char **argv) {
    if (argc < 5) return profile_usage();
    const char *action = argv[3];
    const char *name = argv[4];
    if (!strcmp(action, "bind")) {
        const char *url = NULL, *token = NULL;
        for (int i = 5; i < argc; i++) {
            if      (!strcmp(argv[i], "--url") && i + 1 < argc) url = argv[++i];
            else if (!strcmp(argv[i], "--token") && i + 1 < argc) token = argv[++i];
        }
        return cmd_remote_bind(name, url, token);
    }
    if (!strcmp(action, "detach")) return cmd_remote_detach(name);
    if (!strcmp(action, "status")) return cmd_remote_status(name);
    if (!strcmp(action, "sync")) {
        int auto_flag = 0, stop_flag = 0, worker_loop = 0;
        int interval = MG_AUTOSYNC_DEFAULT_INTERVAL;
        for (int i = 5; i < argc; i++) {
            if      (!strcmp(argv[i], "--auto"))         auto_flag   = 1;
            else if (!strcmp(argv[i], "--stop"))         stop_flag   = 1;
            else if (!strcmp(argv[i], "--worker-loop")) worker_loop  = 1;
            else if (!strcmp(argv[i], "--interval") && i + 1 < argc)
                interval = atoi(argv[++i]);
        }
        if (stop_flag)   return cmd_remote_sync_stop(name);
        if (worker_loop) return cmd_remote_sync_worker(name, interval);
        if (auto_flag)   return cmd_remote_sync_auto(name, interval);
        return cmd_remote_sync(name);
    }
    return profile_usage();
}

/* ---------- dispatcher ---------- */

static int profile_usage(void) {
    fprintf(stderr,
        "usage:\n"
        "  graft profile list\n"
        "  graft profile current\n"
        "  graft profile add    <name>\n"
        "  graft profile remove <name> [--yes]\n"
        "  graft profile set    <name> [--shell bash|zsh|fish|powershell|cmd]\n"
        "  graft profile export <name> --path <file>\n"
        "  graft profile import --name <name> --file <file> [--force]\n"
        "  graft profile merge  --into <name> --from <file> [--overwrite]\n"
        "  graft profile remote <bind|detach|status|sync> <name> [--url <file-or-url>] [--token T]\n"
        "  graft profile remote sync <name> [--auto [--interval SEC]] | [--stop]\n");
    return 2;
}

int mg_profile_cmd(int argc, char **argv) {
    if (argc < 3) return profile_usage();
    const char *sub = argv[2];

    if (!strcmp(sub, "list"))    return cmd_list();
    if (!strcmp(sub, "current")) return cmd_current();

    if (!strcmp(sub, "add")) {
        if (argc < 4) return profile_usage();
        return cmd_add(argv[3]);
    }
    if (!strcmp(sub, "remove") || !strcmp(sub, "rm")) {
        if (argc < 4) return profile_usage();
        const char *name = argv[3];
        int yes = 0;
        for (int i = 4; i < argc; i++) {
            if (!strcmp(argv[i], "--yes") || !strcmp(argv[i], "-y")) yes = 1;
        }
        return cmd_remove(name, yes);
    }
    if (!strcmp(sub, "set")) {
        if (argc < 4) return profile_usage();
        const char *name = argv[3];
        const char *shell = NULL;
        for (int i = 4; i < argc; i++) {
            if (!strcmp(argv[i], "--shell") && i + 1 < argc) shell = argv[++i];
        }
        return cmd_set(name, shell);
    }
    if (!strcmp(sub, "export")) {
        if (argc < 4) return profile_usage();
        const char *name = argv[3];
        const char *path = NULL;
        for (int i = 4; i < argc; i++) {
            if (!strcmp(argv[i], "--path") && i + 1 < argc) path = argv[++i];
        }
        return cmd_export(name, path);
    }
    if (!strcmp(sub, "import")) {
        const char *name = NULL, *path = NULL;
        int force = 0;
        for (int i = 3; i < argc; i++) {
            if      (!strcmp(argv[i], "--name") && i + 1 < argc) name = argv[++i];
            else if (!strcmp(argv[i], "--file") && i + 1 < argc) path = argv[++i];
            else if (!strcmp(argv[i], "--force")) force = 1;
        }
        if (!name || !path) return profile_usage();
        return cmd_import(name, path, force);
    }
    if (!strcmp(sub, "merge")) {
        const char *into = NULL, *from = NULL;
        int overwrite = 0;
        for (int i = 3; i < argc; i++) {
            if      (!strcmp(argv[i], "--into") && i + 1 < argc) into = argv[++i];
            else if (!strcmp(argv[i], "--from") && i + 1 < argc) from = argv[++i];
            else if (!strcmp(argv[i], "--overwrite")) overwrite = 1;
        }
        if (!into || !from) return profile_usage();
        return cmd_merge(into, from, overwrite);
    }
    if (!strcmp(sub, "remote")) {
        return cmd_remote(argc, argv);
    }
    return profile_usage();
}
