#!/usr/bin/env sh
set -eu

FLAGS_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/wisper-flow-flags.conf"
EXTRA_FLAGS=""

if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  EXTRA_FLAGS="--ozone-platform=wayland --enable-features=GlobalShortcutsPortal"
fi

if [ -f "$FLAGS_FILE" ]; then
  USER_FLAGS="$(grep -v '^[[:space:]]*#' "$FLAGS_FILE" | tr '\n' ' ')"
  EXTRA_FLAGS="$EXTRA_FLAGS $USER_FLAGS"
fi

# Prefer packaged app path, fallback to /opt/wisper-flow
if [ -x /usr/lib/wisper-flow/wisper-flow ]; then
  BIN="/usr/lib/wisper-flow/wisper-flow"
  # shellcheck disable=SC2086
  exec "$BIN" $EXTRA_FLAGS "$@"
elif [ -x /opt/wisper-flow/wisper-flow ]; then
  BIN="/opt/wisper-flow/wisper-flow"
  # shellcheck disable=SC2086
  exec "$BIN" $EXTRA_FLAGS "$@"
fi

if [ -x /opt/wisper-flow/node_modules/.bin/electron ]; then
  BIN="/opt/wisper-flow/node_modules/.bin/electron"
else
  BIN="$(command -v electron || echo electron)"
fi

if [ -f /opt/wisper-flow/package.json ] || [ -d /opt/wisper-flow ]; then
  APP_DIR="/opt/wisper-flow"
elif [ -f /usr/lib/wisper-flow/package.json ] || [ -d /usr/lib/wisper-flow ]; then
  APP_DIR="/usr/lib/wisper-flow"
else
  APP_DIR="/opt/wisper-flow"
fi

# shellcheck disable=SC2086
exec "$BIN" "$APP_DIR" $EXTRA_FLAGS "$@"
