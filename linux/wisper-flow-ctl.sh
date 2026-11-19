#!/usr/bin/env sh
set -eu

CMD="${1:-}"
if [ -z "$CMD" ]; then
  echo "Usage: wisper-flow-ctl <ptt-start|ptt-stop|toggle|cancel|paste-last|copy-last|show-hub|toggle-hud|reload-theme|status>" >&2
  exit 1
fi

SOCK="${XDG_RUNTIME_DIR:-/tmp}/wisper-flow.sock"
if [ ! -S "$SOCK" ]; then
  echo "wisper-flow daemon not running ($SOCK)" >&2
  exit 2
fi

if command -v socat >/dev/null 2>&1; then
  printf '%s\n' "$CMD" | socat -t 0.5 - "UNIX-CONNECT:$SOCK"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c '
import os, socket, sys
sock_path = os.environ["SOCK"]
cmd = sys.argv[1] + "\n"
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(1.0)
s.connect(sock_path)
s.sendall(cmd.encode())
try:
    data = s.recv(1024)
    if data:
        sys.stdout.write(data.decode())
except Exception:
    pass
s.close()
' "$CMD"
else
  echo "Need socat or python3 installed for wisper-flow-ctl fallback" >&2
  exit 3
fi
