#!/usr/bin/env bash
# EdgeSSH 一键状态查询（Linux / macOS）。核心逻辑见 server/cli.mjs。
set -e
cd "$(dirname "$0")"
exec node server/cli.mjs status "$@"