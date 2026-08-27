#include "upgrade.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <direct.h>
#  include <windows.h>
#  define MG_PATH_SEP '\\'
#  define mg_mkdir(p) _mkdir(p)
#else
#  include <unistd.h>
#  define MG_PATH_SEP '/'
#  define mg_mkdir(p) mkdir((p), 0700)
#endif

#ifndef GRAFT_VERSION
#  define GRAFT_VERSION "0.0.0-dev"
#endif
#ifndef GRAFT_REPOSITORY
#  define GRAFT_REPOSITORY "AEndrix03/Graft"
#endif

static int path_join(char *out, size_t cap, const char *a, const char *b) {
    int n = snprintf(out, cap, "%s%c%s", a, MG_PATH_SEP, b);
    return (n > 0 && (size_t)n < cap) ? 0 : -1;
}

static int parent_dir(char *path) {
    size_t n = strlen(path);
    while (n > 0 && path[n - 1] != '/' && path[n - 1] != '\\') n--;
    if (n == 0) return -1;
    path[n - 1] = '\0';
    return 0;
}

static int dir_exists(const char *path) {
#ifdef _WIN32
    DWORD a = GetFileAttributesA(path);
    return (a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY)) ? 1 : 0;
#else
    struct stat st;
    return (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) ? 1 : 0;
#endif
}

static int mkdir_p(const char *path) {
    char buf[1024];
    size_t n = strlen(path);
    if (n == 0 || n >= sizeof(buf)) return -1;
    memcpy(buf, path, n + 1);
    for (size_t i = 1; i <= n; i++) {
        if (i == n || buf[i] == '/' || buf[i] == '\\') {
            char saved = buf[i];
            buf[i] = '\0';
            if (!dir_exists(buf) && mg_mkdir(buf) != 0 && !dir_exists(buf)) {
                buf[i] = saved;
                return -1;
            }
            buf[i] = saved;
        }
    }
    return 0;
}

static int own_exe_path(char *out, size_t cap) {
#ifdef _WIN32
    DWORD n = GetModuleFileNameA(NULL, out, (DWORD)cap);
    return (n > 0 && (size_t)n < cap) ? 0 : -1;
#else
    ssize_t n = readlink("/proc/self/exe", out, cap - 1);
    if (n <= 0 || (size_t)n >= cap) return -1;
    out[n] = '\0';
    return 0;
#endif
}

static int read_file(const char *path, char **out) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }
    long len = ftell(f);
    if (len < 0 || len > 16 * 1024 * 1024) { fclose(f); return -1; }
    if (fseek(f, 0, SEEK_SET) != 0) { fclose(f); return -1; }
    char *buf = (char *)calloc((size_t)len + 1, 1);
    if (!buf) { fclose(f); return -1; }
    if (fread(buf, 1, (size_t)len, f) != (size_t)len) {
        free(buf);
        fclose(f);
        return -1;
    }
    fclose(f);
    *out = buf;
    return 0;
}

static int write_text(const char *path, const char *text) {
    char dir[1024];
    if (snprintf(dir, sizeof(dir), "%s", path) >= (int)sizeof(dir)) return -1;
    if (parent_dir(dir) != 0 || mkdir_p(dir) != 0) return -1;
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    fputs(text, f);
    return fclose(f) == 0 ? 0 : -1;
}

static int run_cmd(const char *cmd) {
    return system(cmd) == 0 ? 0 : -1;
}

static const char *skip_v(const char *s) {
    return (s && (*s == 'v' || *s == 'V')) ? s + 1 : s;
}

static int parse_semver(const char *s, int out[3]) {
    s = skip_v(s);
    if (!s || !isdigit((unsigned char)*s)) return -1;
    char *end = NULL;
    long a = strtol(s, &end, 10);
    if (!end || *end != '.') return -1;
    long b = strtol(end + 1, &end, 10);
    if (!end || *end != '.') return -1;
    long c = strtol(end + 1, &end, 10);
    if (a < 0 || b < 0 || c < 0 || a > 9999 || b > 9999 || c > 9999) return -1;
    out[0] = (int)a; out[1] = (int)b; out[2] = (int)c;
    return 0;
}

static int compare_semver(const char *a, const char *b) {
    int av[3], bv[3];
    if (parse_semver(a, av) != 0 || parse_semver(b, bv) != 0)
        return strcmp(skip_v(a), skip_v(b));
    for (int i = 0; i < 3; i++) {
        if (av[i] < bv[i]) return -1;
        if (av[i] > bv[i]) return 1;
    }
    return 0;
}

static int json_string_after(const char *json, const char *key, char *out, size_t cap) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return -1;
    p = strchr(p + strlen(needle), ':');
    if (!p) return -1;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != '"') return -1;
    p++;
    size_t n = 0;
    while (*p && *p != '"' && n + 1 < cap) {
        if (*p == '\\' && p[1]) p++;
        out[n++] = *p++;
    }
    out[n] = '\0';
    return n > 0 ? 0 : -1;
}

static int release_asset_url(const char *json, const char *asset_name, char *out, size_t cap) {
    char needle[256];
    snprintf(needle, sizeof(needle), "\"name\":\"%s\"", asset_name);
    const char *p = strstr(json, needle);
    if (!p) {
        snprintf(needle, sizeof(needle), "\"name\": \"%s\"", asset_name);
        p = strstr(json, needle);
    }
    if (!p) return -1;
    p = strstr(p, "\"browser_download_url\"");
    if (!p) return -1;
    return json_string_after(p, "browser_download_url", out, cap);
}

static int shell_quote(const char *s, char *out, size_t cap) {
#ifdef _WIN32
    size_t pos = 0;
    if (pos + 2 >= cap) return -1;
    out[pos++] = '"';
    for (; *s; s++) {
        if (*s == '"' || *s == '`' || *s == '$') {
            if (pos + 2 >= cap) return -1;
            out[pos++] = '`';
        }
        if (pos + 2 >= cap) return -1;
        out[pos++] = *s;
    }
    out[pos++] = '"';
    out[pos] = '\0';
#else
    size_t pos = 0;
    if (pos + 2 >= cap) return -1;
    out[pos++] = '\'';
    for (; *s; s++) {
        if (*s == '\'') {
            if (pos + 4 >= cap) return -1;
            memcpy(out + pos, "'\\''", 4);
            pos += 4;
        } else {
            if (pos + 2 >= cap) return -1;
            out[pos++] = *s;
        }
    }
    out[pos++] = '\'';
    out[pos] = '\0';
#endif
    return 0;
}

static int download_to(const char *url, const char *path) {
    char qurl[2048], qpath[1024], cmd[4096];
    if (shell_quote(url, qurl, sizeof(qurl)) != 0 ||
        shell_quote(path, qpath, sizeof(qpath)) != 0) return -1;
    snprintf(cmd, sizeof(cmd), "curl -fsSL -H \"User-Agent: graft-upgrade\" -o %s %s", qpath, qurl);
    return run_cmd(cmd);
}

static int expected_sha(const char *sums_path, const char *asset_name, char out[65]) {
    FILE *f = fopen(sums_path, "rb");
    if (!f) return -1;
    char line[2048];
    int ok = -1;
    while (fgets(line, sizeof(line), f)) {
        if (strstr(line, asset_name) && strlen(line) >= 64) {
            memcpy(out, line, 64);
            out[64] = '\0';
            ok = 0;
            break;
        }
    }
    fclose(f);
    return ok;
}

static int verify_sha256(const char *file, const char *hash) {
    char qfile[1024], cmd[4096];
    if (shell_quote(file, qfile, sizeof(qfile)) != 0) return -1;
#ifdef _WIN32
    snprintf(cmd, sizeof(cmd),
             "powershell -NoProfile -Command \"$h=(Get-FileHash -Algorithm SHA256 -Path %s).Hash.ToLower(); if ($h -ne '%s') { exit 1 }\"",
             qfile, hash);
#else
    snprintf(cmd, sizeof(cmd), "printf '%%s  %%s\\n' '%s' %s | sha256sum -c -", hash, qfile);
#endif
    return run_cmd(cmd);
}

static const char *platform_asset(void) {
#ifdef _WIN32
    return "graft-windows-x86_64.zip";
#elif defined(__APPLE__) && (defined(__aarch64__) || defined(__arm64__))
    return "graft-macos-arm64.tar.gz";
#elif defined(__APPLE__)
    return "graft-macos-x86_64.tar.gz";
#elif defined(__aarch64__)
    return "graft-linux-aarch64.tar.gz";
#else
    return "graft-linux-x86_64.tar.gz";
#endif
}

static int install_root(char *out, size_t cap) {
    char exe[1024], dir[1024];
    if (own_exe_path(exe, sizeof(exe)) != 0) return -1;
    snprintf(dir, sizeof(dir), "%s", exe);
    if (parent_dir(dir) != 0) return -1;
    const char *base = strrchr(dir, MG_PATH_SEP);
    base = base ? base + 1 : dir;
    if (strcmp(base, "bin") != 0) {
        fprintf(stderr, "upgrade works only from an installed layout (<root>%cbin%cgraft)\n",
                MG_PATH_SEP, MG_PATH_SEP);
        return -1;
    }
    if (parent_dir(dir) != 0) return -1;
    return snprintf(out, cap, "%s", dir) < (int)cap ? 0 : -1;
}

static int make_temp_dir(char *out, size_t cap) {
#ifdef _WIN32
    char base[MAX_PATH], name[1024];
    if (!GetTempPathA(sizeof(base), base)) return -1;
    snprintf(name, sizeof(name), "%sgraft-upgrade-%lu", base, (unsigned long)GetCurrentProcessId());
    if (mkdir_p(name) != 0) return -1;
    return snprintf(out, cap, "%s", name) < (int)cap ? 0 : -1;
#else
    const char *tmp = getenv("TMPDIR");
    if (!tmp || !*tmp) tmp = "/tmp";
    char tmpl[1024];
    snprintf(tmpl, sizeof(tmpl), "%s/graft-upgrade-XXXXXX", tmp);
    if (!mkdtemp(tmpl)) return -1;
    return snprintf(out, cap, "%s", tmpl) < (int)cap ? 0 : -1;
#endif
}

static int extract_archive(const char *archive, const char *dst) {
    char qarchive[1024], qdst[1024], cmd[4096];
    if (shell_quote(archive, qarchive, sizeof(qarchive)) != 0 ||
        shell_quote(dst, qdst, sizeof(qdst)) != 0) return -1;
#ifdef _WIN32
    snprintf(cmd, sizeof(cmd), "powershell -NoProfile -Command \"Expand-Archive -Force -Path %s -DestinationPath %s\"", qarchive, qdst);
#else
    snprintf(cmd, sizeof(cmd), "mkdir -p %s && tar -xzf %s -C %s", qdst, qarchive, qdst);
#endif
    return run_cmd(cmd);
}

static int apply_payload(const char *payload, const char *root, const char *tmp) {
    char qpayload[1024], qroot[1024], cmd[4096];
    if (shell_quote(payload, qpayload, sizeof(qpayload)) != 0 ||
        shell_quote(root, qroot, sizeof(qroot)) != 0) return -1;
#ifdef _WIN32
    char script[1024];
    if (path_join(script, sizeof(script), tmp, "apply-upgrade.ps1") != 0) return -1;
    char text[4096];
    snprintf(text, sizeof(text),
             "$ErrorActionPreference='Stop'\n"
             "Wait-Process -Id %lu -ErrorAction SilentlyContinue\n"
             "Copy-Item -Recurse -Force -Path '%s\\*' -Destination '%s'\n"
             "Remove-Item -Recurse -Force '%s'\n",
             (unsigned long)GetCurrentProcessId(), payload, root, tmp);
    if (write_text(script, text) != 0) return -1;
    snprintf(cmd, sizeof(cmd),
             "powershell -NoProfile -Command \"Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ''%s'''\"",
             script);
    if (run_cmd(cmd) != 0) return -1;
    printf("Upgrade staged. Files will be replaced after this graft process exits.\n");
    return 0;
#else
    snprintf(cmd, sizeof(cmd), "cp -R %s/. %s/", qpayload, qroot);
    return run_cmd(cmd);
#endif
}

static int ask_confirm(const char *cur, const char *next) {
    char line[32];
    printf("Upgrade graft %s -> %s? [y/N] ", cur, next);
    fflush(stdout);
    if (!fgets(line, sizeof(line), stdin)) return 0;
    return line[0] == 'y' || line[0] == 'Y';
}

int mg_upgrade_cmd(int argc, char **argv) {
    int assume_yes = 0, check_only = 0;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--yes") || !strcmp(argv[i], "-y")) assume_yes = 1;
        else if (!strcmp(argv[i], "--check")) check_only = 1;
        else {
            fprintf(stderr, "usage: graft upgrade [--check] [--yes]\n");
            return 2;
        }
    }

    const char *repo = getenv("GRAFT_UPGRADE_REPO");
    if (!repo || !*repo) repo = GRAFT_REPOSITORY;
    char api_url[512];
    const char *api_env = getenv("GRAFT_UPGRADE_LATEST_URL");
    if (api_env && *api_env) snprintf(api_url, sizeof(api_url), "%s", api_env);
    else snprintf(api_url, sizeof(api_url), "https://api.github.com/repos/%s/releases/latest", repo);

    char tmp[1024], latest_json[1024];
    if (make_temp_dir(tmp, sizeof(tmp)) != 0 ||
        path_join(latest_json, sizeof(latest_json), tmp, "latest.json") != 0) {
        fprintf(stderr, "upgrade: failed to create temp directory\n");
        return 1;
    }
    if (download_to(api_url, latest_json) != 0) {
        fprintf(stderr, "upgrade: failed to fetch latest release from %s\n", api_url);
        return 1;
    }
    char *json = NULL;
    if (read_file(latest_json, &json) != 0) {
        fprintf(stderr, "upgrade: failed to read GitHub release response\n");
        return 1;
    }

    char tag[128];
    if (json_string_after(json, "tag_name", tag, sizeof(tag)) != 0) {
        free(json);
        fprintf(stderr, "upgrade: latest release has no tag_name\n");
        return 1;
    }
    if (compare_semver(GRAFT_VERSION, tag) >= 0) {
        printf("graft is up to date (%s).\n", GRAFT_VERSION);
        free(json);
        return 0;
    }
    printf("Latest graft release: %s (current: %s)\n", tag, GRAFT_VERSION);
    if (check_only) {
        free(json);
        return 0;
    }
    if (!assume_yes && !ask_confirm(GRAFT_VERSION, tag)) {
        free(json);
        printf("Upgrade cancelled.\n");
        return 0;
    }

    const char *asset = platform_asset();
    char asset_url[2048], sums_url[2048];
    if (release_asset_url(json, asset, asset_url, sizeof(asset_url)) != 0 ||
        release_asset_url(json, "SHA256SUMS", sums_url, sizeof(sums_url)) != 0) {
        free(json);
        fprintf(stderr, "upgrade: release %s does not contain %s and SHA256SUMS\n", tag, asset);
        return 1;
    }
    free(json);

    char archive[1024], sums[1024], payload[1024], root[1024];
    if (path_join(archive, sizeof(archive), tmp, asset) != 0 ||
        path_join(sums, sizeof(sums), tmp, "SHA256SUMS") != 0 ||
        path_join(payload, sizeof(payload), tmp, "payload") != 0 ||
        install_root(root, sizeof(root)) != 0) {
        fprintf(stderr, "upgrade: failed to resolve paths\n");
        return 1;
    }
    printf("Downloading %s...\n", asset);
    if (download_to(asset_url, archive) != 0 || download_to(sums_url, sums) != 0) {
        fprintf(stderr, "upgrade: download failed\n");
        return 1;
    }
    char hash[65];
    if (expected_sha(sums, asset, hash) != 0 || verify_sha256(archive, hash) != 0) {
        fprintf(stderr, "upgrade: SHA256 verification failed for %s\n", asset);
        return 1;
    }
    printf("Verified SHA256 %s\n", hash);
    if (extract_archive(archive, payload) != 0) {
        fprintf(stderr, "upgrade: failed to extract %s\n", asset);
        return 1;
    }
    if (apply_payload(payload, root, tmp) != 0) {
        fprintf(stderr, "upgrade: failed to apply payload to %s\n", root);
        return 1;
    }
#ifndef _WIN32
    printf("Upgraded graft %s -> %s.\n", GRAFT_VERSION, tag);
#endif
    return 0;
}
