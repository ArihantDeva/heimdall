/* graft view — open the 3D viewer in the browser.
 *
 * On the first invocation, the viewer SPA is not built yet, so this command
 * auto-builds it (npm install + npm run build) before opening the browser.
 * Subsequent invocations skip straight to opening the URL.
 *
 * Viewer-source resolution order:
 *   1. $GRAFT_VIEWER_DIR explicit override.
 *   2. <install_root>/viewer/ derived from argv[0] (user install layout).
 *   3. ./viewer/ relative to cwd (developer / source-tree layout).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "view.h"

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#define PATH_SEP '\\'
#define PATH_SEP_S "\\"
#else
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>
#define PATH_SEP '/'
#define PATH_SEP_S "/"
#endif

static int path_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0;
}

/* Strip the trailing filename component from `path` in place. */
static void strip_last(char *path) {
    char *p = strrchr(path, PATH_SEP);
#ifdef _WIN32
    /* on Windows accept both separators */
    char *q = strrchr(path, '/');
    if (q && (!p || q > p)) p = q;
#endif
    if (p) *p = '\0';
}

/* Locate the viewer source directory. Writes the absolute (or cwd-relative)
 * path to `out`. Returns 0 on success, -1 if no candidate exists. */
static int resolve_viewer_dir(const char *argv0, char *out, size_t outsz) {
    const char *env_override = getenv("GRAFT_VIEWER_DIR");
    if (env_override && *env_override) {
        snprintf(out, outsz, "%s", env_override);
        return path_exists(out) ? 0 : -1;
    }

    char base[1024] = "";
#ifdef _WIN32
    if (GetModuleFileNameA(NULL, base, (DWORD)sizeof(base)) == 0) base[0] = '\0';
#else
    if (argv0 && argv0[0] == '/') {
        snprintf(base, sizeof(base), "%s", argv0);
    }
#endif
    if (base[0]) {
        /* base = <root>/bin/graft[.exe] → strip filename, then "bin" */
        strip_last(base);
        strip_last(base);
        snprintf(out, outsz, "%s%cviewer", base, PATH_SEP);
        if (path_exists(out)) return 0;
    }

    /* Dev / source-tree fallback */
    if (path_exists("viewer")) {
        snprintf(out, outsz, "viewer");
        return 0;
    }
    return -1;
}

/* Split a whitespace-separated command into argv tokens (no quoting or
 * escaping support). The viewer code only invokes literal commands like
 * "npm install" or "npm run build" — this keeps the parser tiny and safe.
 * Writes pointers into `buf` (which is modified in place) and returns the
 * argc count, or -1 if the command would overflow `max_args` tokens. */
static int split_args(char *buf, char **argv, int max_args) {
    int argc = 0;
    char *p = buf;
    while (*p) {
        while (*p == ' ' || *p == '\t') p++;
        if (!*p) break;
        if (argc >= max_args - 1) return -1;
        argv[argc++] = p;
        while (*p && *p != ' ' && *p != '\t') p++;
        if (*p) { *p = '\0'; p++; }
    }
    argv[argc] = NULL;
    return argc;
}

/* Run `what` inside `dir` without invoking a shell. `dir` can contain
 * arbitrary attacker-controlled characters (it ultimately comes from
 * GRAFT_VIEWER_DIR or argv[0]); we pass it as the child's working directory,
 * never as part of a command-line string. */
static int run_in_dir(const char *dir, const char *what, const char *label) {
    fprintf(stderr, "  %s...\n", label);

    char cmd_buf[256];
    if ((size_t)snprintf(cmd_buf, sizeof(cmd_buf), "%s", what) >= sizeof(cmd_buf)) {
        fprintf(stderr, "  %s failed (command too long).\n", label);
        return -1;
    }
    char *argv[16];
    int argc = split_args(cmd_buf, argv, 16);
    if (argc <= 0) {
        fprintf(stderr, "  %s failed (empty command).\n", label);
        return -1;
    }

#ifdef _WIN32
    /* Rebuild a properly-quoted command line for CreateProcessA from the
     * already-split argv (safe: contents are literal, no metachars). */
    char cmdline[1024];
    size_t off = 0;
    for (int i = 0; i < argc; i++) {
        int n = snprintf(cmdline + off, sizeof(cmdline) - off,
                         "%s\"%s\"", i ? " " : "", argv[i]);
        if (n < 0 || (size_t)n >= sizeof(cmdline) - off) {
            fprintf(stderr, "  %s failed (command line too long).\n", label);
            return -1;
        }
        off += (size_t)n;
    }

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));

    /* Use NULL application name + parsed cmdline so PATH resolution finds
     * npm.cmd / npm.exe; the *dir* argument controls only the cwd. */
    if (!CreateProcessA(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, dir,
                        &si, &pi)) {
        fprintf(stderr, "  %s failed to launch (err %lu).\n", label,
                (unsigned long)GetLastError());
        return -1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    int rc = (int)code;
    if (rc != 0) fprintf(stderr, "  %s failed (exit %d).\n", label, rc);
    return rc;
#else
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "  %s fork failed: %s\n", label, strerror(errno));
        return -1;
    }
    if (pid == 0) {
        if (chdir(dir) != 0) _exit(127);
        execvp(argv[0], argv);
        _exit(127);
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) {
            fprintf(stderr, "  %s waitpid failed: %s\n", label, strerror(errno));
            return -1;
        }
    }
    int rc = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    if (rc != 0) fprintf(stderr, "  %s failed (exit %d).\n", label, rc);
    return rc;
#endif
}

static int ensure_viewer_built(const char *viewer_dir) {
    char dist_index[1200];
    snprintf(dist_index, sizeof(dist_index),
             "%s%sdist%sindex.html", viewer_dir, PATH_SEP_S, PATH_SEP_S);
    if (path_exists(dist_index)) return 0;

    char package_json[1200];
    snprintf(package_json, sizeof(package_json),
             "%s%spackage.json", viewer_dir, PATH_SEP_S);
    if (!path_exists(package_json)) {
        fprintf(stderr, "Viewer source at %s is missing package.json — skipping auto-build.\n", viewer_dir);
        return -1;
    }

    fprintf(stderr, "Building viewer SPA at %s (first run, ~30s)...\n", viewer_dir);

    /* npm install — idempotent; skip if node_modules already populated. */
    char node_modules[1200];
    snprintf(node_modules, sizeof(node_modules),
             "%s%snode_modules", viewer_dir, PATH_SEP_S);
    if (!path_exists(node_modules)) {
        if (run_in_dir(viewer_dir, "npm install", "npm install") != 0) {
            fprintf(stderr, "Hint: ensure Node.js + npm are on PATH, then retry.\n");
            return -1;
        }
    }

    if (run_in_dir(viewer_dir, "npm run build", "npm run build") != 0) return -1;

    if (!path_exists(dist_index)) {
        fprintf(stderr, "Build finished but %s still missing.\n", dist_index);
        return -1;
    }
    fprintf(stderr, "  viewer built.\n");
    return 0;
}

int mg_view_cmd(int argc, char **argv) {
    int port = 9977;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--port") && i + 1 < argc) port = atoi(argv[++i]);
    }

    char viewer_dir[1024] = "";
    if (resolve_viewer_dir(argv[0], viewer_dir, sizeof(viewer_dir)) == 0) {
        if (ensure_viewer_built(viewer_dir) != 0) {
            fprintf(stderr,
                    "Continuing anyway — graftd may still serve a pre-built bundle elsewhere.\n");
        }
    } else {
        fprintf(stderr,
                "Note: viewer source not found locally; relying on whatever graftd serves at viewer_path.\n");
    }

    char url[128];
    snprintf(url, sizeof(url), "http://127.0.0.1:%d/", port);
    fprintf(stderr, "Opening %s — requires `http.enabled: true` in config.yaml.\n", url);

    /* `url` is built from a fixed scheme/host and an int port — no attacker
     * surface — but we still avoid system() so the helper command can't be
     * shell-interpolated should this format ever change. */
#ifdef _WIN32
    /* ShellExecuteA handles the http:// scheme directly via the registered
     * default browser; no shell parsing of `url`. */
    HINSTANCE h = ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);
    return ((INT_PTR)h > 32) ? 0 : -1;
#else
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
#  ifdef __APPLE__
        char *open_argv[] = { "open", (char *)url, NULL };
        execvp("open", open_argv);
#  else
        char *open_argv[] = { "xdg-open", (char *)url, NULL };
        execvp("xdg-open", open_argv);
#  endif
        _exit(127);
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) return -1;
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
#endif
}
