#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: wisper-flow-ctl <ptt-start|ptt-stop|toggle|cancel|paste-last|copy-last|show-hub|toggle-hud|reload-theme|status>\n");
        return 1;
    }

    const char *runtime_dir = getenv("XDG_RUNTIME_DIR");
    if (!runtime_dir || !runtime_dir[0]) {
        runtime_dir = "/tmp";
    }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s/wisper-flow.sock", runtime_dir);

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        fprintf(stderr, "wisper-flow daemon not running (%s): %s\n", addr.sun_path, strerror(errno));
        close(fd);
        return 2;
    }

    char msg[256];
    int len = snprintf(msg, sizeof(msg), "%s\n", argv[1]);
    if (len > 0) {
        ssize_t written = write(fd, msg, (size_t)len);
        (void)written;
    }

    char buf[1024];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    if (n > 0) {
        buf[n] = '\0';
        fputs(buf, stdout);
    }

    close(fd);
    return 0;
}
