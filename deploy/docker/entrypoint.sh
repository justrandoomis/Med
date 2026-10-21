#!/bin/sh
# MedLevo container entrypoint (PID 1 is tini). A persistent disk (Render, a Docker volume) may be mounted
# root-owned: as root, make sure the data directory exists and belongs to the unprivileged «node» user, then drop
# privileges for good. The server itself never runs as root.
set -eu
DATA="${MEDLEVO_DATA_DIR:-/var/data/medlevo}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # the disk root too, so a restore can create its new directory BESIDE the live data (same disk)
  chown node:node "$DATA" "$(dirname "$DATA")" 2>/dev/null || true
  # anything a root shell left behind inside the data directory (stops at the first match; quick when none)
  if [ -n "$(find "$DATA" -xdev ! -user node -print -quit 2>/dev/null)" ]; then
    chown -R node:node "$DATA"
  fi
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all -- "$@"
fi
exec "$@"
