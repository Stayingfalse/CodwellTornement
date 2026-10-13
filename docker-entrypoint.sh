#!/bin/sh
# Make sure the data folder is writable by the unprivileged "node" user
# (files written by older images were owned by root), then run the bot as it.
# Node drops the privileges itself, so the image needs no extra packages.
set -e
mkdir -p /app/data
chown -R node:node /app/data 2>/dev/null || true
exec node -e "process.setgid('node'); process.setuid('node'); require('/app/src/index.js')"
