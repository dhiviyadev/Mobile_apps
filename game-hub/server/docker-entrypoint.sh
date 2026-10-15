#!/bin/sh
# Container entrypoint for the game server.
#
# Saved Voxelvale worlds are written to $DATA_DIR. Volumes (Fly.io, Docker named
# volumes) usually mount owned by root, so when started as root this makes the
# directory writable for the unprivileged "node" user and then runs the server
# as that user. Started as any other user, it just runs the command.
# If the directory still is not writable the server logs a warning and keeps
# worlds in memory instead of crashing.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" || echo "warning: could not create $DATA_DIR" >&2
  chown -R node:node "$DATA_DIR" || echo "warning: could not hand $DATA_DIR to the node user" >&2
  exec su-exec node "$@"
fi

exec "$@"
