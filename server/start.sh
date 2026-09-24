#!/bin/sh
# EdgeSSH 一键启动（Linux / macOS）。核心逻辑见 server/cli.mjs，支持 --rebuild。
set -e
cd "$(dirname "$0")/.."
exec node server/cli.mjs start "$@"
