#!/bin/sh
set -e

# When running as root (e.g. Railway with a mounted volume), fix ownership
# of the data directory so the non-root `opententacles` user can write to it,
# then drop privileges. When already running as a non-root user, skip straight
# to exec.
DATA_DIR="${OPENTENTACLES_DATA_DIR:-/data}"

# The Copilot CLI subprocess (spawned by @github/copilot-sdk) writes its own
# config and session state under $HOME/.config/github-copilot. Point HOME at
# the data volume so that state persists across redeploys.
HOME_DIR="${HOME_DIR:-$DATA_DIR/home}"
export HOME="$HOME_DIR"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$HOME_DIR"
  chown -R opententacles:opententacles "$DATA_DIR"
  exec gosu opententacles:opententacles "$@"
fi

mkdir -p "$HOME_DIR"
exec "$@"
