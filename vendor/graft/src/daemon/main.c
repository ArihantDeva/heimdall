/* graftd — long-running daemon listening on an AF_UNIX socket.
 *
 * Wiring:
 *   parse argv -> config_load -> storage_open + apply_schema
 *                -> embed_init -> verify_init
 *                -> socket_listen
 *                -> accept-loop, thread-per-connection
 *
 * Each accepted client runs handle_client() which loops on
 *   read_frame -> mg_dispatch -> write_frame
 * until the peer closes or an I/O error occurs.
 *
 * Shutdown: SIGINT/SIGTERM set g_shutdown and close the listening fd,
 * which makes the next accept() return -1 and the main loop exits.
 * Per-client threads are detached; outstanding clients will see a
 * read EOF when their fd is closed at shutdown.
 */

#include "graft/ops.h"
#include "graft/wire.h"
#include "graft/storage.h"
#include "graft/embed.h"
#include "graft/verify.h"
#include "graft/rerank.h"
#include "graft/config.h"
#include "graft/error.h"
#include "graft/http.h"
#include "internal.h"

#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <direct.h>
#  define mg_mkdir(p) _mkdir(p)
#  define MG_PATH_SEP '\\'
#else
#  include <unistd.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  define mg_mkdir(p) mkdir((p), 0755)
#  define MG_PATH_SEP '/'
#endif

/* Apply env-var overrides on top of the YAML config. The CLI uses these to
 * point the daemon at a per-profile DB / socket without rewriting the
 * config file. */
static void apply_env_overrides(mg_config_t *cfg) {
    const char *e = getenv("GRAFT_SOCKET");
    if (e && *e) {
        free(cfg->socket_path);
        cfg->socket_path = strdup(e);
    }
    e = getenv("GRAFT_DB_PATH");
    if (e && *e) {
        free(cfg->db_path);
        cfg->db_path = strdup(e);
    }
}

/* Ensure the parent directory of db_path exists so SQLite can create the
 * file on first start (relevant for per-profile DBs under GRAFT_HOME). */
static void ensure_parent_dir(const char *path) {
    if (!path) return;
    char buf[1024];
    size_t n = strlen(path);
    if (n == 0 || n >= sizeof(buf)) return;
    memcpy(buf, path, n + 1);
    /* trim trailing component */
    while (n > 0 && buf[n - 1] != MG_PATH_SEP && buf[n - 1] != '/') n--;
    if (n == 0) return;
    buf[n - 1] = '\0';
    /* mkdir -p */
    for (size_t i = 1; i < strlen(buf); i++) {
        if (buf[i] == MG_PATH_SEP || buf[i] == '/') {
            char saved = buf[i];
            buf[i] = '\0';
            (void)mg_mkdir(buf);
            buf[i] = saved;
        }
    }
    (void)mg_mkdir(buf);
}

static volatile sig_atomic_t g_shutdown  = 0;
static int                   g_listen_fd = -1;
static mg_http_server_t     *g_http_srv  = NULL;

static void on_signal(int sig) {
    (void)sig;
    g_shutdown = 1;
    int fd = g_listen_fd;
    if (fd >= 0) {
        g_listen_fd = -1;
        mg_daemon_socket_close(fd);
    }
}

typedef struct {
    int       fd;
    mg_ctx_t *ctx;
} client_arg_t;

static void *handle_client(void *vp) {
    client_arg_t *ca = (client_arg_t *)vp;
    int       fd  = ca->fd;
    mg_ctx_t *ctx = ca->ctx;
    free(ca);

    for (;;) {
        if (g_shutdown) break;

        void  *req     = NULL;
        size_t req_len = 0;
        if (mg_wire_read_frame(fd, &req, &req_len) != MG_OK) break;

        void  *resp     = NULL;
        size_t resp_len = 0;
        mg_err_t e = mg_dispatch(ctx, req ? req : "", req_len,
                                  &resp, &resp_len);
        free(req);

        if (e == MG_OK && resp && resp_len > 0) {
            (void)mg_wire_write_frame(fd, resp, resp_len);
        }
        free(resp);
        if (e != MG_OK) break;
    }
    mg_daemon_socket_close(fd);
    return NULL;
}

int main(int argc, char **argv) {
    const char *config_path = "./config.example.yaml";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--config") && i + 1 < argc) {
            config_path = argv[++i];
        } else if (!strcmp(argv[i], "--foreground")) {
            /* default; flag accepted for forward-compat */
        } else if (!strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) {
            fprintf(stderr,
                "usage: graftd [--config PATH] [--foreground]\n");
            return 0;
        } else {
            fprintf(stderr, "unknown flag: %s\n", argv[i]);
            return 2;
        }
    }

    mg_config_t cfg;
    mg_err_t err = mg_config_load(config_path, &cfg);
    if (err != MG_OK) {
        fprintf(stderr, "config load failed: %s (path=%s)\n",
                mg_strerror(err), config_path);
        return 1;
    }
    apply_env_overrides(&cfg);
    ensure_parent_dir(cfg.db_path);
    ensure_parent_dir(cfg.socket_path);

    mg_storage_t    *storage = NULL;
    mg_embed_ctx_t  *embed   = NULL;
    mg_verify_ctx_t *verify  = NULL;
    mg_rerank_ctx_t *rerank  = NULL;
    int rc = 1;

    err = mg_storage_open(cfg.db_path, &storage);
    if (err != MG_OK) {
        fprintf(stderr, "storage open failed: %s\n", mg_strerror(err));
        goto cleanup;
    }
    err = mg_storage_apply_schema(storage);
    if (err != MG_OK) {
        fprintf(stderr, "schema apply failed: %s\n", mg_strerror(err));
        goto cleanup;
    }
    err = mg_embed_init(cfg.embed_model_path, cfg.embed_threads,
                         cfg.embed_ctx_size, cfg.hardware_accel,
                         cfg.embed_instances, &embed);
    if (err != MG_OK) {
        fprintf(stderr, "embed init failed: %s\n", mg_strerror(err));
        goto cleanup;
    }
    err = mg_verify_init(&cfg, &verify);
    if (err != MG_OK) {
        fprintf(stderr, "verify init failed: %s\n", mg_strerror(err));
        goto cleanup;
    }
    err = mg_rerank_init(&cfg, verify, &rerank);
    if (err != MG_OK) {
        fprintf(stderr, "rerank init failed: %s\n", mg_strerror(err));
        goto cleanup;
    }

    mg_ctx_t ctx;
    ctx.storage = storage;
    ctx.embed   = embed;
    ctx.verify  = verify;
    ctx.rerank  = rerank;
    ctx.config  = &cfg;

    signal(SIGINT,  on_signal);
    signal(SIGTERM, on_signal);

    g_listen_fd = mg_daemon_socket_listen(cfg.socket_path);
    if (g_listen_fd < 0) {
        fprintf(stderr, "socket listen failed on %s\n", cfg.socket_path);
        goto cleanup;
    }
    fprintf(stderr, "graftd: listening on %s\n", cfg.socket_path);

    /* Optional HTTP layer — off by default. */
    if (mg_http_start(&ctx, &g_http_srv) != MG_OK) {
        fprintf(stderr, "http: start failed\n");
        goto cleanup;
    }

    while (!g_shutdown) {
        int cfd = mg_daemon_socket_accept(g_listen_fd);
        if (cfd < 0) break;

        client_arg_t *ca = (client_arg_t *)malloc(sizeof(*ca));
        if (!ca) { mg_daemon_socket_close(cfd); continue; }
        ca->fd  = cfd;
        ca->ctx = &ctx;

        pthread_t th;
        if (pthread_create(&th, NULL, handle_client, ca) != 0) {
            free(ca);
            mg_daemon_socket_close(cfd);
            continue;
        }
        pthread_detach(th);
    }

    fprintf(stderr, "graftd: shutting down\n");
    if (g_http_srv) {
        mg_http_stop(g_http_srv);
        g_http_srv = NULL;
    }
    if (g_listen_fd >= 0) {
        mg_daemon_socket_close(g_listen_fd);
        g_listen_fd = -1;
    }
#ifdef _WIN32
    DeleteFileA(cfg.socket_path);
#else
    unlink(cfg.socket_path);
#endif
    rc = 0;

cleanup:
    if (rerank)  mg_rerank_shutdown(rerank);
    if (verify)  mg_verify_shutdown(verify);
    if (embed)   mg_embed_shutdown(embed);
    if (storage) mg_storage_close(storage);
    mg_config_free(&cfg);
    mg_daemon_socket_shutdown();
    return rc;
}
