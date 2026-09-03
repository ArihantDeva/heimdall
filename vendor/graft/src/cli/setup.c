#include "setup.h"

#include <errno.h>
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
#  include <dirent.h>
#  include <unistd.h>
#  define MG_PATH_SEP '/'
#  define mg_mkdir(p) mkdir((p), 0700)
#endif

enum mg_setup_agent {
    MG_SETUP_CLAUDECODE,
    MG_SETUP_CODEX,
    MG_SETUP_OPENCODE
};

#define MG_SETUP_INSTALL_HOOKS 0
#define MG_SETUP_INSTALL_AGENT_INSTRUCTIONS 0

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

static int file_exists(const char *path) {
#ifdef _WIN32
    DWORD a = GetFileAttributesA(path);
    return (a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY)) ? 1 : 0;
#else
    struct stat st;
    return (stat(path, &st) == 0 && S_ISREG(st.st_mode)) ? 1 : 0;
#endif
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
            if (!dir_exists(buf)) {
                if (mg_mkdir(buf) != 0 && !dir_exists(buf)) {
                    buf[i] = saved;
                    return -1;
                }
            }
            buf[i] = saved;
        }
    }
    return 0;
}

static int copy_file(const char *src, const char *dst) {
    char dir[1024];
    if (snprintf(dir, sizeof(dir), "%s", dst) >= (int)sizeof(dir)) return -1;
    if (parent_dir(dir) != 0 || mkdir_p(dir) != 0) return -1;

    FILE *fi = fopen(src, "rb");
    if (!fi) return -1;
    FILE *fo = fopen(dst, "wb");
    if (!fo) {
        fclose(fi);
        return -1;
    }
    char buf[64 * 1024];
    size_t n;
    int rc = 0;
    while ((n = fread(buf, 1, sizeof(buf), fi)) > 0) {
        if (fwrite(buf, 1, n, fo) != n) {
            rc = -1;
            break;
        }
    }
    if (ferror(fi)) rc = -1;
    fclose(fi);
    if (fclose(fo) != 0) rc = -1;
    return rc;
}

static int copy_tree(const char *src, const char *dst) {
    if (!dir_exists(src)) return -1;
    if (mkdir_p(dst) != 0) return -1;

#ifdef _WIN32
    char pattern[1024];
    if (snprintf(pattern, sizeof(pattern), "%s\\*", src) >= (int)sizeof(pattern)) return -1;
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) return -1;
    int rc = 0;
    do {
        const char *name = fd.cFileName;
        if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
        char s[1024], d[1024];
        if (path_join(s, sizeof(s), src, name) != 0 || path_join(d, sizeof(d), dst, name) != 0) {
            rc = -1;
            break;
        }
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (copy_tree(s, d) != 0) {
                rc = -1;
                break;
            }
        } else if (copy_file(s, d) != 0) {
            rc = -1;
            break;
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
    return rc;
#else
    DIR *dir = opendir(src);
    if (!dir) return -1;
    int rc = 0;
    struct dirent *de;
    while ((de = readdir(dir)) != NULL) {
        const char *name = de->d_name;
        if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
        char s[1024], d[1024];
        if (path_join(s, sizeof(s), src, name) != 0 || path_join(d, sizeof(d), dst, name) != 0) {
            rc = -1;
            break;
        }
        if (dir_exists(s)) {
            if (copy_tree(s, d) != 0) {
                rc = -1;
                break;
            }
        } else if (copy_file(s, d) != 0) {
            rc = -1;
            break;
        }
    }
    closedir(dir);
    return rc;
#endif
}

static int ends_with(const char *s, const char *suffix) {
    size_t n, m;
    if (!s || !suffix) return 0;
    n = strlen(s);
    m = strlen(suffix);
    return n >= m && strcmp(s + n - m, suffix) == 0;
}

static int normalize_codex_skill_file(const char *path) {
    FILE *in = fopen(path, "rb");
    if (!in) return -1;
    char tmp[1024];
    if (snprintf(tmp, sizeof(tmp), "%s.tmp", path) >= (int)sizeof(tmp)) {
        fclose(in);
        return -1;
    }
    FILE *out = fopen(tmp, "wb");
    if (!out) {
        fclose(in);
        return -1;
    }

    char line[8192];
    while (fgets(line, sizeof(line), in)) {
        if (!strncmp(line, "description: ", 13) && strncmp(line, "description: >-", 15)) {
            char *desc = line + 13;
            fputs("description: >-\n  ", out);
            fputs(desc, out);
            if (!strchr(desc, '\n')) fputc('\n', out);
        } else {
            fputs(line, out);
        }
    }
    int rc = ferror(in) ? -1 : 0;
    if (fclose(in) != 0) rc = -1;
    if (fclose(out) != 0) rc = -1;
    if (rc != 0) {
        remove(tmp);
        return -1;
    }
    if (remove(path) != 0) {
        remove(tmp);
        return -1;
    }
    if (rename(tmp, path) != 0) {
        remove(tmp);
        return -1;
    }
    return 0;
}

static int normalize_codex_skill_tree(const char *root) {
    if (!dir_exists(root)) return 0;

#ifdef _WIN32
    char pattern[1024];
    if (snprintf(pattern, sizeof(pattern), "%s\\*", root) >= (int)sizeof(pattern)) return -1;
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) return -1;
    int rc = 0;
    do {
        const char *name = fd.cFileName;
        if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
        char p[1024];
        if (path_join(p, sizeof(p), root, name) != 0) { rc = -1; break; }
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (normalize_codex_skill_tree(p) != 0) { rc = -1; break; }
        } else if (ends_with(name, "SKILL.md")) {
            if (normalize_codex_skill_file(p) != 0) { rc = -1; break; }
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
    return rc;
#else
    DIR *dir = opendir(root);
    if (!dir) return -1;
    int rc = 0;
    struct dirent *de;
    while ((de = readdir(dir)) != NULL) {
        const char *name = de->d_name;
        if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
        char p[1024];
        if (path_join(p, sizeof(p), root, name) != 0) { rc = -1; break; }
        if (dir_exists(p)) {
            if (normalize_codex_skill_tree(p) != 0) { rc = -1; break; }
        } else if (ends_with(name, "SKILL.md")) {
            if (normalize_codex_skill_file(p) != 0) { rc = -1; break; }
        }
    }
    closedir(dir);
    return rc;
#endif
}

static int user_home(char *out, size_t cap) {
#ifdef _WIN32
    const char *home = getenv("USERPROFILE");
    if (!home || !*home) home = getenv("LOCALAPPDATA");
#else
    const char *home = getenv("HOME");
#endif
    if (!home || !*home) return -1;
    return (snprintf(out, cap, "%s", home) < (int)cap) ? 0 : -1;
}

static int own_exe_dir(char *out, size_t cap) {
#ifdef _WIN32
    char buf[MAX_PATH];
    DWORD n = GetModuleFileNameA(NULL, buf, sizeof(buf));
    if (n == 0 || n >= sizeof(buf)) return -1;
#else
    char buf[4096];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n <= 0) return -1;
    buf[n] = '\0';
#endif
    if (parent_dir(buf) != 0) return -1;
    return (snprintf(out, cap, "%s", buf) < (int)cap) ? 0 : -1;
}

static int cwd_path(char *out, size_t cap) {
#ifdef _WIN32
    return _getcwd(out, (int)cap) ? 0 : -1;
#else
    return getcwd(out, cap) ? 0 : -1;
#endif
}

static const char *agent_display_name(enum mg_setup_agent agent) {
    switch (agent) {
        case MG_SETUP_CLAUDECODE: return "Claude Code";
        case MG_SETUP_CODEX: return "Codex";
        case MG_SETUP_OPENCODE: return "OpenCode";
    }
    return "agent";
}

#if MG_SETUP_INSTALL_AGENT_INSTRUCTIONS
static const char *agent_project_file(enum mg_setup_agent agent) {
    return agent == MG_SETUP_CLAUDECODE ? "CLAUDE.md" : "AGENTS.md";
}
#endif

static int candidate_standard_dir(char *out, size_t cap, const char *base) {
    char tmp[1024];
    if (path_join(tmp, sizeof(tmp), base, "integrations") != 0) return -1;
    return path_join(out, cap, tmp, "standard");
}

static int find_standard_dir(char *out, size_t cap) {
    const char *env = getenv("GRAFT_INTEGRATIONS_DIR");
    if (env && *env) {
        if (path_join(out, cap, env, "standard") == 0 && dir_exists(out)) return 0;
        if (dir_exists(env)) {
            char entry[1024];
            if (path_join(entry, sizeof(entry), env, "entrypoint.md") == 0 && file_exists(entry)) {
                snprintf(out, cap, "%s", env);
                return 0;
            }
        }
    }

    char base[1024], cand[1024];
    if (own_exe_dir(base, sizeof(base)) == 0) {
        if (candidate_standard_dir(cand, sizeof(cand), base) == 0 && dir_exists(cand)) {
            snprintf(out, cap, "%s", cand);
            return 0;
        }
        char parent[1024];
        if (snprintf(parent, sizeof(parent), "%s", base) < (int)sizeof(parent)
            && parent_dir(parent) == 0) {
            if (candidate_standard_dir(cand, sizeof(cand), parent) == 0 && dir_exists(cand)) {
                snprintf(out, cap, "%s", cand);
                return 0;
            }
            char share[1024], graft[1024], integrations[1024];
            if (path_join(share, sizeof(share), parent, "share") == 0
                && path_join(graft, sizeof(graft), share, "graft") == 0
                && path_join(integrations, sizeof(integrations), graft, "integrations") == 0
                && path_join(cand, sizeof(cand), integrations, "standard") == 0
                && dir_exists(cand)) {
                snprintf(out, cap, "%s", cand);
                return 0;
            }
        }
    }

    if (cwd_path(base, sizeof(base)) == 0
        && candidate_standard_dir(cand, sizeof(cand), base) == 0
        && dir_exists(cand)) {
        snprintf(out, cap, "%s", cand);
        return 0;
    }
    return -1;
}

static int write_text_file(const char *path, const char *text) {
    char dir[1024];
    if (snprintf(dir, sizeof(dir), "%s", path) >= (int)sizeof(dir)) return -1;
    if (parent_dir(dir) != 0 || mkdir_p(dir) != 0) return -1;
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    fputs(text, f);
    return fclose(f) == 0 ? 0 : -1;
}

static void shell_write_quoted(FILE *f, const char *s) {
    fputc('"', f);
    for (; *s; s++) {
        if (*s == '"' || *s == '\\') fputc('\\', f);
        fputc(*s, f);
    }
    fputc('"', f);
}

#if MG_SETUP_INSTALL_AGENT_INSTRUCTIONS
static int print_file_contents(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        if (fwrite(buf, 1, n, stdout) != n) {
            fclose(f);
            return -1;
        }
    }
    int rc = ferror(f) ? -1 : 0;
    fclose(f);
    return rc;
}

static void print_project_snippet(const char *src, enum mg_setup_agent agent) {
    char snippet[1024];
    printf("\nProject instructions to paste into %s:\n\n", agent_project_file(agent));
    printf("-----BEGIN GRAFT PROJECT INSTRUCTIONS-----\n");
    if (path_join(snippet, sizeof(snippet), src, "project-snippet.md") == 0
        && print_file_contents(snippet) == 0) {
        /* ok */
    } else {
        printf("Use `graft query \"<problem restated>\"` before non-trivial technical work.\n");
        printf("After solving a non-obvious reusable problem, run `graft classify --title \"<title>\"`, then `graft insert` with a Markdown body and 2-5 keywords.\n");
    }
    printf("\n-----END GRAFT PROJECT INSTRUCTIONS-----\n\n");
}
#endif

static int enable_codex_hooks_flag(const char *codex_home) {
    char path[1024];
    if (path_join(path, sizeof(path), codex_home, "config.toml") != 0) return -1;
    if (file_exists(path)) {
        FILE *f = fopen(path, "rb");
        if (!f) return -1;
        fseek(f, 0, SEEK_END);
        long len = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (len < 0 || len > 1024 * 1024) {
            fclose(f);
            return -1;
        }
        char *buf = (char *)calloc((size_t)len + 64, 1);
        if (!buf) {
            fclose(f);
            return -1;
        }
        if (fread(buf, 1, (size_t)len, f) != (size_t)len) {
            fclose(f);
            free(buf);
            return -1;
        }
        fclose(f);
        /* Length-tracked builder: an attacker-controlled config.toml with many
         * repeated `[features]` sections or other expansion-triggering lines
         * could overflow a fixed-size buffer. Track capacity strictly and
         * abort cleanly if a write would not fit. */
        size_t cap = (size_t)len * 2u + 256u;
        char *out = (char *)calloc(cap, 1);
        if (!out) {
            free(buf);
            return -1;
        }
        size_t pos = 0;

        #define MG_APPEND_LIT(s) do {                                  \
            size_t _slen = strlen(s);                                  \
            if (_slen + 1 > cap - pos) {                               \
                free(out); free(buf); return -1;                       \
            }                                                          \
            memcpy(out + pos, (s), _slen);                             \
            pos += _slen;                                              \
            out[pos] = '\0';                                           \
        } while (0)

        #define MG_APPEND_BYTES(p, n) do {                             \
            size_t _n = (n);                                           \
            if (_n + 1 > cap - pos) {                                  \
                free(out); free(buf); return -1;                       \
            }                                                          \
            memcpy(out + pos, (p), _n);                                \
            pos += _n;                                                 \
            out[pos] = '\0';                                           \
        } while (0)

        int saw_features = 0, inserted = 0, replaced = 0;
        char *p = buf;
        while (*p) {
            char *line = p;
            char *nl = strchr(p, '\n');
            size_t line_len = nl ? (size_t)(nl - line + 1) : strlen(line);
            p = nl ? nl + 1 : line + line_len;

            while (line_len > 0 && (line[line_len - 1] == '\n' || line[line_len - 1] == '\r')) line_len--;
            char tmp[512];
            size_t copy_len = line_len < sizeof(tmp) - 1 ? line_len : sizeof(tmp) - 1;
            memcpy(tmp, line, copy_len);
            tmp[copy_len] = '\0';
            char *trim = tmp;
            while (*trim == ' ' || *trim == '\t') trim++;

            if (!strncmp(trim, "codex_hooks", 11)) continue;
            if (saw_features && !strncmp(trim, "hooks", 5)) {
                if (!inserted && !replaced) MG_APPEND_LIT("hooks = true\n");
                replaced = 1;
                continue;
            }
            MG_APPEND_BYTES(line, line_len);
            MG_APPEND_LIT("\n");
            if (!strcmp(trim, "[features]")) {
                saw_features = 1;
                if (!replaced) {
                    MG_APPEND_LIT("hooks = true\n");
                    inserted = 1;
                }
            } else if (trim[0] == '[') {
                saw_features = 0;
            }
        }
        if (!inserted && !replaced) MG_APPEND_LIT("\n[features]\nhooks = true\n");

        #undef MG_APPEND_LIT
        #undef MG_APPEND_BYTES

        f = fopen(path, "wb");
        free(buf);
        if (!f) { free(out); return -1; }
        size_t wrote = fwrite(out, 1, pos, f);
        free(out);
        if (wrote != pos) { fclose(f); return -1; }
        return fclose(f) == 0 ? 0 : -1;
    }
    return write_text_file(path, "[features]\nhooks = true\n");
}

static int write_hook_config(const char *path, const char *hook_dir,
                             enum mg_setup_agent agent) {
    char dir[1024];
    if (snprintf(dir, sizeof(dir), "%s", path) >= (int)sizeof(dir)) return -1;
    if (parent_dir(dir) != 0 || mkdir_p(dir) != 0) return -1;

    char query[1024], mark[1024], propose[1024];
    if (path_join(query, sizeof(query), hook_dir, "query_inject.js") != 0
        || path_join(mark, sizeof(mark), hook_dir, "mark_candidate.js") != 0
        || path_join(propose, sizeof(propose), hook_dir, "propose_memoryze.js") != 0) {
        return -1;
    }

    char tmp_js[1024];
    if (path_join(tmp_js, sizeof(tmp_js), dir, ".graft-merge-hooks.js") != 0) return -1;
    FILE *js = fopen(tmp_js, "wb");
    if (!js) return -1;
    fputs(
        "const fs = require('fs');\n"
        "const [configPath, agent, query, mark, propose] = process.argv.slice(2);\n"
        "let doc = {};\n"
        "try {\n"
        "  if (fs.existsSync(configPath)) {\n"
        "    const raw = fs.readFileSync(configPath, 'utf8').replace(/^\\uFEFF/, '').trim();\n"
        "    if (raw) doc = JSON.parse(raw);\n"
        "  }\n"
        "} catch (e) {\n"
        "  console.error(`graft setup: cannot parse ${configPath}: ${e.message}`);\n"
        "  process.exit(2);\n"
        "}\n"
        "if (!doc || Array.isArray(doc) || typeof doc !== 'object') doc = {};\n"
        "if (!doc.hooks || Array.isArray(doc.hooks) || typeof doc.hooks !== 'object') doc.hooks = {};\n"
        "const claude = agent === 'claudecode';\n"
        "function cmd(script, timeout, statusMessage) {\n"
        "  const h = claude\n"
        "    ? { type: 'command', command: 'node', args: [script], timeout }\n"
        "    : { type: 'command', command: `node \"${script.replace(/\"/g, '\\\\\"')}\"`, timeout };\n"
        "  if (statusMessage) h.statusMessage = statusMessage;\n"
        "  return h;\n"
        "}\n"
        "function sameHook(a, script) {\n"
        "  if (!a || a.type !== 'command') return false;\n"
        "  if (Array.isArray(a.args) && a.args.includes(script)) return true;\n"
        "  return typeof a.command === 'string' && a.command.includes(script);\n"
        "}\n"
        "function upsert(event, matcher, hook) {\n"
        "  const groups = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];\n"
        "  const next = [];\n"
        "  let placed = false;\n"
        "  for (const group of groups) {\n"
        "    if (!group || typeof group !== 'object') { next.push(group); continue; }\n"
        "    const hooks = Array.isArray(group.hooks) ? group.hooks : [];\n"
        "    const filtered = hooks.filter(h => !sameHook(h, hook.__script));\n"
        "    const matches = matcher === null ? !Object.prototype.hasOwnProperty.call(group, 'matcher') : group.matcher === matcher;\n"
        "    if (matches) {\n"
        "      next.push({ ...group, hooks: [...filtered, hook] });\n"
        "      placed = true;\n"
        "    } else {\n"
        "      next.push({ ...group, hooks: filtered });\n"
        "    }\n"
        "  }\n"
        "  if (!placed) {\n"
        "    const group = matcher === null ? { hooks: [hook] } : { matcher, hooks: [hook] };\n"
        "    next.push(group);\n"
        "  }\n"
        "  for (const group of next) {\n"
        "    if (group && Array.isArray(group.hooks)) for (const h of group.hooks) delete h.__script;\n"
        "  }\n"
        "  doc.hooks[event] = next;\n"
        "}\n"
        "const q = cmd(query, 10, claude ? undefined : 'graft cache lookup'); q.__script = query;\n"
        "const m = cmd(mark, 5); m.__script = mark;\n"
        "const p = cmd(propose, 5); p.__script = propose;\n"
        "upsert('UserPromptSubmit', null, q);\n"
        "upsert('PostToolUse', claude ? 'Edit|Write|MultiEdit|NotebookEdit' : 'apply_patch', m);\n"
        "upsert('Stop', null, p);\n"
        "fs.writeFileSync(configPath, JSON.stringify(doc, null, 2) + '\\n', { encoding: 'utf8' });\n",
        js);
    if (fclose(js) != 0) {
        remove(tmp_js);
        return -1;
    }

    char cmd[8192];
    FILE *cmdf = tmpfile();
    if (!cmdf) {
        remove(tmp_js);
        return -1;
    }
    fputs("node ", cmdf);
    shell_write_quoted(cmdf, tmp_js);
    fputc(' ', cmdf);
    shell_write_quoted(cmdf, path);
    fputc(' ', cmdf);
    shell_write_quoted(cmdf, agent == MG_SETUP_CLAUDECODE ? "claudecode" : "codex");
    fputc(' ', cmdf);
    shell_write_quoted(cmdf, query);
    fputc(' ', cmdf);
    shell_write_quoted(cmdf, mark);
    fputc(' ', cmdf);
    shell_write_quoted(cmdf, propose);
    long n;
    if (fflush(cmdf) != 0 || fseek(cmdf, 0, SEEK_END) != 0 || (n = ftell(cmdf)) < 0
        || (size_t)n >= sizeof(cmd) || fseek(cmdf, 0, SEEK_SET) != 0) {
        fclose(cmdf);
        remove(tmp_js);
        return -1;
    }
    if (fread(cmd, 1, (size_t)n, cmdf) != (size_t)n) {
        fclose(cmdf);
        remove(tmp_js);
        return -1;
    }
    cmd[n] = '\0';
    fclose(cmdf);
    int rc = system(cmd);
    remove(tmp_js);
    return rc == 0 ? 0 : -1;
}

static int setup_claudecode(const char *src, const char *home) {
    char claude_home[1024], src_skills[1024], dst_skills[1024];
    char src_hooks[1024], dst_hooks_root[1024], dst_hooks[1024], settings[1024];
    if (path_join(claude_home, sizeof(claude_home), home, ".claude") != 0
        || path_join(src_skills, sizeof(src_skills), src, "skills") != 0
        || path_join(dst_skills, sizeof(dst_skills), claude_home, "skills") != 0) {
        return -1;
    }
    if (copy_tree(src_skills, dst_skills) != 0) return -1;
    if (normalize_codex_skill_tree(dst_skills) != 0) return -1;
    if (MG_SETUP_INSTALL_HOOKS) {
        char src_hook_graft[1024];
        if (path_join(src_hooks, sizeof(src_hooks), src, "hooks") != 0
            || path_join(dst_hooks_root, sizeof(dst_hooks_root), claude_home, "hooks") != 0
            || path_join(dst_hooks, sizeof(dst_hooks), dst_hooks_root, "graft") != 0
            || path_join(settings, sizeof(settings), claude_home, "settings.json") != 0
            || path_join(src_hook_graft, sizeof(src_hook_graft), src_hooks, "graft") != 0) {
            return -1;
        }
        if (copy_tree(src_hook_graft, dst_hooks) != 0) return -1;
        if (write_hook_config(settings, dst_hooks, MG_SETUP_CLAUDECODE) != 0) return -1;
        printf("Installed Claude Code hooks to %s\n", dst_hooks);
        printf("Updated %s\n", settings);
    }
    printf("Installed Claude Code skills to %s\n", dst_skills);
    return 0;
}

static int setup_codex(const char *src, const char *home) {
    char codex_home[1024], src_hooks[1024], dst_hooks_root[1024], dst_hooks[1024], hooks_json[1024];
    char src_agents[1024], dst_agents[1024], src_skills_root[1024], dst_skills[1024];
    if (path_join(codex_home, sizeof(codex_home), home, ".codex") != 0
        || path_join(src_skills_root, sizeof(src_skills_root), src, "skills") != 0
        || path_join(dst_skills, sizeof(dst_skills), codex_home, "skills") != 0) {
        return -1;
    }
    if (dir_exists(src_skills_root)) {
        if (copy_tree(src_skills_root, dst_skills) != 0) return -1;
        if (normalize_codex_skill_tree(dst_skills) != 0) return -1;
    }
    if (MG_SETUP_INSTALL_HOOKS) {
        char src_hook_graft[1024];
        if (path_join(src_hooks, sizeof(src_hooks), src, "hooks") != 0
            || path_join(dst_hooks_root, sizeof(dst_hooks_root), codex_home, "hooks") != 0
            || path_join(dst_hooks, sizeof(dst_hooks), dst_hooks_root, "graft") != 0
            || path_join(hooks_json, sizeof(hooks_json), codex_home, "hooks.json") != 0
            || path_join(src_hook_graft, sizeof(src_hook_graft), src_hooks, "graft") != 0) {
            return -1;
        }
        if (copy_tree(src_hook_graft, dst_hooks) != 0) return -1;
        if (write_hook_config(hooks_json, dst_hooks, MG_SETUP_CODEX) != 0) return -1;
        if (enable_codex_hooks_flag(codex_home) != 0) return -1;
        printf("Installed Codex hooks to %s\n", dst_hooks);
        printf("Updated %s\n", hooks_json);
    }
    if (MG_SETUP_INSTALL_AGENT_INSTRUCTIONS) {
        if (path_join(src_agents, sizeof(src_agents), src, "entrypoint.md") != 0
            || path_join(dst_agents, sizeof(dst_agents), codex_home, "AGENTS.md") != 0) {
            return -1;
        }
        if (copy_file(src_agents, dst_agents) != 0) return -1;
        printf("Installed Codex instructions to %s\n", dst_agents);
    }
    if (dir_exists(src_skills_root)) printf("Installed Codex skills to %s\n", dst_skills);
    return 0;
}

static int setup_opencode(const char *src, const char *home) {
    char config_home[1024], opencode_home[1024], src_skills[1024], dst_skills[1024];
    char src_agents[1024], dst_agents[1024];
    if (path_join(config_home, sizeof(config_home), home, ".config") != 0) return -1;

    if (path_join(opencode_home, sizeof(opencode_home), config_home, "opencode") != 0
        || path_join(src_skills, sizeof(src_skills), src, "skills") != 0
        || path_join(dst_skills, sizeof(dst_skills), opencode_home, "skills") != 0) {
        return -1;
    }
    if (copy_tree(src_skills, dst_skills) != 0) return -1;
    if (normalize_codex_skill_tree(dst_skills) != 0) return -1;
    if (MG_SETUP_INSTALL_AGENT_INSTRUCTIONS) {
        if (path_join(src_agents, sizeof(src_agents), src, "entrypoint.md") != 0
            || path_join(dst_agents, sizeof(dst_agents), opencode_home, "AGENTS.md") != 0) {
            return -1;
        }
        if (copy_file(src_agents, dst_agents) != 0) return -1;
        printf("Installed OpenCode instructions to %s\n", dst_agents);
    }
    printf("Installed OpenCode skills to %s\n", dst_skills);
    return 0;
}

static int parse_agent(const char *s, enum mg_setup_agent *agent) {
    if (!strcmp(s, "claudecode") || !strcmp(s, "claude-code") || !strcmp(s, "claude")) {
        *agent = MG_SETUP_CLAUDECODE;
        return 0;
    }
    if (!strcmp(s, "codex")) {
        *agent = MG_SETUP_CODEX;
        return 0;
    }
    if (!strcmp(s, "opencode") || !strcmp(s, "open-code") || !strcmp(s, "open_code")) {
        *agent = MG_SETUP_OPENCODE;
        return 0;
    }
    return -1;
}

int mg_setup_cmd(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: graft setup <claudecode|codex|opencode>\n");
        return 2;
    }
    enum mg_setup_agent agent;
    if (parse_agent(argv[2], &agent) != 0) {
        fprintf(stderr, "unknown setup target: %s\n", argv[2]);
        fprintf(stderr, "usage: graft setup <claudecode|codex|opencode>\n");
        return 2;
    }

    char home[1024], src[1024];
    if (user_home(home, sizeof(home)) != 0) {
        fprintf(stderr, "setup failed: could not resolve user profile directory\n");
        return 1;
    }
    if (find_standard_dir(src, sizeof(src)) != 0) {
        fprintf(stderr,
                "setup failed: could not find integrations/standard (set GRAFT_INTEGRATIONS_DIR)\n");
        return 1;
    }

    int rc;
    if (agent == MG_SETUP_CLAUDECODE) rc = setup_claudecode(src, home);
    else if (agent == MG_SETUP_CODEX) rc = setup_codex(src, home);
    else rc = setup_opencode(src, home);
    if (rc != 0) {
        fprintf(stderr, "setup failed: %s\n", strerror(errno ? errno : EINVAL));
        return 1;
    }
    printf("Restart %s so it reloads the installed skills.\n",
           agent_display_name(agent));
    return 0;
}
