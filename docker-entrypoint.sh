#!/bin/sh
set -e

# When running as root (e.g. Railway with a mounted volume), fix ownership
# of the data directory so the non-root `opententacles` user can write to it,
# then drop privileges. When already running as a non-root user, skip straight
# to exec.
DATA_DIR="${OPENTENTACLES_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R opententacles:opententacles "$DATA_DIR"
  exec su-exec opententacles:opententacles "$@"
fi

exec "$@"
