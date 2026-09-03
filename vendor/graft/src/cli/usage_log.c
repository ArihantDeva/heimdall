/* graft CLI — usage logging + analytics.
 *
 * The CLI appends one JSON line per invocation to a usage log file so the
 * user (and `graft analytics`) can later answer: "is the graph actually
 * paying off?" — i.e. is the cache hit rate high enough that we're saving
 * agent reasoning time, or are we just hoarding nodes that never get reused?
 *
 * Storage location: `$GRAFT_USAGE_LOG`, else `$HOME/.graft/usage.jsonl`
 * (POSIX) or `%LOCALAPPDATA%\graft\usage.jsonl` (Windows). The file is
 * append-only newline-delimited JSON; aggregation streams it once.
 *
 * The aggregator does NOT depend on a JSON library: each line follows a
 * fixed schema that we both write and read, so a tiny scanner is enough.
 * If the file format ever drifts, lines that fail to parse are skipped.
 */

#include "usage_log.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <ctype.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <direct.h>
#  define MG_PATH_SEP '\\'
#  define mg_mkdir(p) _mkdir(p)
#else
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <unistd.h>
#  define MG_PATH_SEP '/'
#  define mg_mkdir(p) mkdir((p), 0755)
#endif

/* ---- path resolution ---- */

int mg_usage_log_path(char *out, size_t cap) {
    const char *env = getenv("GRAFT_USAGE_LOG");
    if (env && *env) {
        if (snprintf(out, cap, "%s", env) >= (int)cap) return -1;
        return 0;
    }
    const char *mh = getenv("GRAFT_HOME");
    char dir[1024];
    if (mh && *mh) {
        if (snprintf(dir, sizeof(dir), "%s", mh) >= (int)sizeof(dir)) return -1;
    } else {
#ifdef _WIN32
        const char *base = getenv("USERPROFILE");
        if (!base || !*base) base = getenv("LOCALAPPDATA");
        if (!base || !*base) return -1;
        if (snprintf(dir, sizeof(dir), "%s%c.graft", base, MG_PATH_SEP)
            >= (int)sizeof(dir)) return -1;
#else
        const char *home = getenv("HOME");
        if (!home || !*home) return -1;
        if (snprintf(dir, sizeof(dir), "%s/.graft", home) >= (int)sizeof(dir))
            return -1;
#endif
    }
    (void)mg_mkdir(dir);
    if (snprintf(out, cap, "%s%cusage.jsonl", dir, MG_PATH_SEP) >= (int)cap)
        return -1;
    return 0;
}

/* ---- write ---- */

static void write_quoted(FILE *f, const char *s) {
    fputc('"', f);
    if (s) {
        for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
            unsigned char c = *p;
            switch (c) {
                case '"':  fputs("\\\"", f); break;
                case '\\': fputs("\\\\", f); break;
                case '\n': fputs("\\n",  f); break;
                case '\r': fputs("\\r",  f); break;
                case '\t': fputs("\\t",  f); break;
                default:
                    if (c < 0x20) fprintf(f, "\\u%04x", c);
                    else          fputc(c, f);
            }
        }
    }
    fputc('"', f);
}

void mg_usage_log_append(const char *op,
                         int          status,
                         int          latency_ms,
                         const char  *hit,
                         const char  *id_hex) {
    char path[1024];
    if (mg_usage_log_path(path, sizeof(path)) != 0) return;
    FILE *f = fopen(path, "ab");
    if (!f) return;

    long long ts = (long long)time(NULL);
    fprintf(f, "{\"ts\":%lld,\"op\":", ts);
    write_quoted(f, op ? op : "");
    fprintf(f, ",\"status\":%d,\"latency_ms\":%d,\"hit\":", status, latency_ms);
    if (hit && *hit) write_quoted(f, hit);
    else             fputs("null", f);
    fputs(",\"id_hex\":", f);
    if (id_hex && *id_hex) write_quoted(f, id_hex);
    else                   fputs("null", f);
    fputs("}\n", f);
    fclose(f);
}

/* ---- analytics: streaming aggregator ---- */

/* Parse one field value. Caller positions `p` after the colon.
 * On return *out_p points just past the value (and past trailing comma if any).
 * Quoted strings are copied (unescaped naively — we only emit a fixed grammar
 * so we don't need to handle every JSON corner case). */
static int parse_quoted(const char **p, char *out, size_t cap) {
    if (**p != '"') return -1;
    (*p)++;
    size_t i = 0;
    while (**p && **p != '"') {
        char c = **p;
        if (c == '\\' && (*p)[1]) {
            (*p)++;
            char esc = **p;
            switch (esc) {
                case 'n': c = '\n'; break;
                case 'r': c = '\r'; break;
                case 't': c = '\t'; break;
                default:  c = esc;  break;
            }
        }
        if (i + 1 < cap) out[i++] = c;
        (*p)++;
    }
    if (**p != '"') return -1;
    (*p)++;
    if (i < cap) out[i] = '\0';
    else if (cap > 0) out[cap - 1] = '\0';
    return 0;
}

static int parse_int(const char **p, long long *out) {
    char *end = NULL;
    long long v = strtoll(*p, &end, 10);
    if (end == *p) return -1;
    *p = end;
    *out = v;
    return 0;
}

/* Skip to value of given key inside one line (single-pass). Returns 1 if
 * found and `*p` is left at the start of the value, 0 if not found. */
static int seek_field(const char *line, const char *key, const char **out_p) {
    char needle[64];
    int n = snprintf(needle, sizeof(needle), "\"%s\":", key);
    if (n <= 0 || (size_t)n >= sizeof(needle)) return 0;
    const char *q = strstr(line, needle);
    if (!q) return 0;
    *out_p = q + n;
    return 1;
}

#define MG_TOP_N 10

typedef struct {
    char     id_hex[64];
    int      count;
} reuse_t;

static void bump_reuse(reuse_t *top, const char *id_hex) {
    if (!id_hex || !*id_hex) return;
    for (int i = 0; i < MG_TOP_N; i++) {
        if (top[i].count == 0) {
            snprintf(top[i].id_hex, sizeof(top[i].id_hex), "%s", id_hex);
            top[i].count = 1;
            return;
        }
        if (strcmp(top[i].id_hex, id_hex) == 0) {
            top[i].count++;
            return;
        }
    }
    /* full: replace the smallest if our (implicit count of 1) is smaller —
     * not strictly correct, but a good enough O(n) approximation for a TUI
     * report, given the cardinality of reused nodes is small in practice. */
    int min_i = 0;
    for (int i = 1; i < MG_TOP_N; i++)
        if (top[i].count < top[min_i].count) min_i = i;
    if (top[min_i].count <= 1) {
        snprintf(top[min_i].id_hex, sizeof(top[min_i].id_hex), "%s", id_hex);
        top[min_i].count = 1;
    }
}

static int reuse_cmp(const void *a, const void *b) {
    return ((const reuse_t *)b)->count - ((const reuse_t *)a)->count;
}

int mg_usage_analytics(int argc, char **argv) {
    /* options: --since Nd|Nh, --seconds-per-hit N */
    long long since_seconds = 0;     /* 0 = unlimited */
    int       seconds_per_hit = 60;  /* default estimate */
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--since") && i + 1 < argc) {
            const char *s = argv[++i];
            char *end = NULL;
            long n = strtol(s, &end, 10);
            long long mult = 86400; /* default: days */
            if (end && *end == 'h') mult = 3600;
            else if (end && *end == 'd') mult = 86400;
            else if (end && *end == 's') mult = 1;
            since_seconds = (long long)n * mult;
        } else if (!strcmp(argv[i], "--seconds-per-hit") && i + 1 < argc) {
            seconds_per_hit = atoi(argv[++i]);
        }
    }

    char path[1024];
    if (mg_usage_log_path(path, sizeof(path)) != 0) {
        fprintf(stderr, "no usage log path resolvable\n");
        return 1;
    }
    FILE *f = fopen(path, "rb");
    if (!f) {
        fputs("{\n  \"path\": ", stdout); write_quoted(stdout, path);
        fputs(",\n  \"events\": 0,\n  \"note\": \"no log yet - run any graft command first\"\n}\n", stdout);
        return 0;
    }

    long long now = (long long)time(NULL);
    long long min_ts = since_seconds > 0 ? now - since_seconds : 0;

    long long n_total = 0, n_query = 0, n_insert = 0, n_retrieve = 0,
              n_explore = 0, n_classify = 0, n_get = 0, n_other = 0;
    long long n_strong = 0, n_weak = 0, n_miss = 0;
    long long sum_latency_ms = 0;
    long long sum_query_latency_ms = 0;
    long long n_errors = 0;
    long long first_ts = 0, last_ts = 0;
    reuse_t   top[MG_TOP_N] = { 0 };

    char line[8192];
    while (fgets(line, sizeof(line), f)) {
        const char *p = NULL;
        long long ts = 0;
        if (seek_field(line, "ts", &p) && parse_int(&p, &ts) == 0) {
            if (ts < min_ts) continue;
            if (first_ts == 0 || ts < first_ts) first_ts = ts;
            if (ts > last_ts) last_ts = ts;
        } else continue;

        char op[32] = { 0 };
        if (seek_field(line, "op", &p)) (void)parse_quoted(&p, op, sizeof(op));

        long long status = 0;
        if (seek_field(line, "status", &p)) (void)parse_int(&p, &status);
        if (status != 0) n_errors++;

        long long latency = 0;
        if (seek_field(line, "latency_ms", &p)) (void)parse_int(&p, &latency);
        sum_latency_ms += latency;

        char hit[16] = { 0 };
        if (seek_field(line, "hit", &p)) {
            if (*p == '"') (void)parse_quoted(&p, hit, sizeof(hit));
        }

        char id_hex[64] = { 0 };
        if (seek_field(line, "id_hex", &p)) {
            if (*p == '"') (void)parse_quoted(&p, id_hex, sizeof(id_hex));
        }

        n_total++;
        if      (!strcmp(op, "query"))    { n_query++; sum_query_latency_ms += latency; }
        else if (!strcmp(op, "insert"))   { n_insert++; }
        else if (!strcmp(op, "retrieve")) { n_retrieve++; }
        else if (!strcmp(op, "explore"))  { n_explore++; }
        else if (!strcmp(op, "classify")) { n_classify++; }
        else if (!strcmp(op, "get"))      { n_get++; }
        else                              { n_other++; }

        if      (!strcmp(hit, "STRONG")) { n_strong++; bump_reuse(top, id_hex); }
        else if (!strcmp(hit, "WEAK"))   { n_weak++;   }
        else if (!strcmp(hit, "MISS"))   { n_miss++;   }
    }
    fclose(f);

    qsort(top, MG_TOP_N, sizeof(top[0]), reuse_cmp);

    long long n_query_with_hit = n_strong + n_weak + n_miss;
    double hit_rate = n_query_with_hit > 0
        ? (double)n_strong / (double)n_query_with_hit
        : 0.0;
    long long est_seconds_saved = n_strong * seconds_per_hit;
    double insert_to_query = n_query > 0 ? (double)n_insert / (double)n_query : 0.0;
    double avg_latency = n_total > 0 ? (double)sum_latency_ms / (double)n_total : 0.0;
    double avg_query_latency = n_query > 0
        ? (double)sum_query_latency_ms / (double)n_query
        : 0.0;

    fputs("{\n  \"path\": ", stdout);
    write_quoted(stdout, path);
    fputs(",\n", stdout);
    printf("  \"window\": {\"first_ts\": %lld, \"last_ts\": %lld, \"since_seconds\": %lld},\n",
           first_ts, last_ts, since_seconds);
    printf("  \"events\": {\"total\": %lld, \"errors\": %lld},\n", n_total, n_errors);
    printf("  \"by_op\": {\"query\": %lld, \"retrieve\": %lld, \"explore\": %lld, "
           "\"insert\": %lld, \"classify\": %lld, \"get\": %lld, \"other\": %lld},\n",
           n_query, n_retrieve, n_explore, n_insert, n_classify, n_get, n_other);
    printf("  \"cache\": {\"strong\": %lld, \"weak\": %lld, \"miss\": %lld, "
           "\"hit_rate\": %.3f},\n",
           n_strong, n_weak, n_miss, hit_rate);
    printf("  \"latency_ms\": {\"avg_all\": %.1f, \"avg_query\": %.1f},\n",
           avg_latency, avg_query_latency);
    printf("  \"insert_to_query_ratio\": %.3f,\n", insert_to_query);
    printf("  \"estimated_seconds_saved\": %lld,\n", est_seconds_saved);
    printf("  \"top_reused_nodes\": [");
    int first = 1;
    for (int i = 0; i < MG_TOP_N; i++) {
        if (top[i].count == 0) continue;
        printf("%s\n    {\"id_hex\": \"%s\", \"hits\": %d}",
               first ? "" : ",", top[i].id_hex, top[i].count);
        first = 0;
    }
    printf("%s]\n}\n", first ? "" : "\n  ");
    return 0;
}
