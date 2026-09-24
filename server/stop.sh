#!/bin/sh
# EdgeSSH 一键停止（Linux / macOS）。核心逻辑见 server/cli.mjs。
set -e
cd "$(dirname "$0")/.."
exec node server/cli.mjs stop "$@"
