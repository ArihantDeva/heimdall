/* Cross-platform AF_UNIX stream socket helpers.
 *
 * Windows >= 1803 supports AF_UNIX via <afunix.h>; sockets are returned
 * as SOCKET (uint64) but we narrow to int for the public mg_wire_* API.
 * For paths < 100 bytes (typical), this fits and we accept the truncation
 * risk — long paths in any case fail sun_path's 108-byte limit on POSIX.
 */

#include "internal.h"

#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#  include <winsock2.h>
#  include <afunix.h>
#  include <ws2tcpip.h>
#  include <windows.h>
#  define MG_INVALID_SOCK INVALID_SOCKET
#  define MG_CLOSE_SOCK(s) closesocket((SOCKET)(s))
typedef SOCKET mg_sock_t;
#else
#  include <sys/types.h>
#  include <sys/socket.h>
#  include <sys/stat.h>
#  include <sys/un.h>
#  include <unistd.h>
#  include <errno.h>
#  define MG_INVALID_SOCK (-1)
#  define MG_CLOSE_SOCK(s) close((s))
typedef int mg_sock_t;
#endif

void mg_daemon_socket_init(void) {
#ifdef _WIN32
    static int inited = 0;
    if (!inited) {
        WSADATA wd;
        (void)WSAStartup(MAKEWORD(2, 2), &wd);
        inited = 1;
    }
#endif
}

void mg_daemon_socket_shutdown(void) {
#ifdef _WIN32
    WSACleanup();
#endif
}

void mg_daemon_socket_close(int fd) {
    if (fd < 0) return;
    MG_CLOSE_SOCK((mg_sock_t)fd);
}

static int fill_addr(struct sockaddr_un *addr, const char *path) {
    memset(addr, 0, sizeof(*addr));
    addr->sun_family = AF_UNIX;
    size_t cap = sizeof(addr->sun_path) - 1;
    if (strlen(path) > cap) return -1;
    memcpy(addr->sun_path, path, strlen(path));
    return 0;
}

int mg_daemon_socket_listen(const char *path) {
    if (!path) return -1;
    mg_daemon_socket_init();

#ifdef _WIN32
    DeleteFileA(path);
#else
    unlink(path);
#endif

    mg_sock_t s = socket(AF_UNIX, SOCK_STREAM, 0);
    if (s == MG_INVALID_SOCK) return -1;

    struct sockaddr_un addr;
    if (fill_addr(&addr, path) != 0) { MG_CLOSE_SOCK(s); return -1; }

#ifndef _WIN32
    /* Restrict the socket file to the owner: clamp permissions with umask
     * before bind() (which creates the inode), then chmod 0600 as a
     * defense-in-depth follow-up in case the umask was already wider. */
    mode_t old_umask = umask(0177);
#endif

    int bind_rc = bind(s, (struct sockaddr *)&addr, sizeof(addr));

#ifndef _WIN32
    umask(old_umask);
#endif

    if (bind_rc != 0) {
        MG_CLOSE_SOCK(s); return -1;
    }

#ifndef _WIN32
    if (chmod(path, 0600) != 0) {
        MG_CLOSE_SOCK(s);
        unlink(path);
        return -1;
    }
#endif

    if (listen(s, 16) != 0) {
        MG_CLOSE_SOCK(s); return -1;
    }
    return (int)s;
}

int mg_daemon_socket_accept(int listen_fd) {
    mg_sock_t c = accept((mg_sock_t)listen_fd, NULL, NULL);
    if (c == MG_INVALID_SOCK) return -1;
    return (int)c;
}

mg_err_t mg_daemon_socket_connect(const char *path, int *out_fd) {
    if (!path || !out_fd) return MG_ERR_INVALID_ARG;
    mg_daemon_socket_init();

    mg_sock_t s = socket(AF_UNIX, SOCK_STREAM, 0);
    if (s == MG_INVALID_SOCK) return MG_ERR_IO;

    struct sockaddr_un addr;
    if (fill_addr(&addr, path) != 0) { MG_CLOSE_SOCK(s); return MG_ERR_INVALID_ARG; }

    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        MG_CLOSE_SOCK(s); return MG_ERR_IO;
    }
    *out_fd = (int)s;
    return MG_OK;
}
