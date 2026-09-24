#!/usr/bin/env bash
# EdgeSSH 一键升级脚本（Linux / macOS）
# 流程：git pull → npm ci → npm run build:server → 重启服务
# 任意一步失败立即停止，不影响现有服务的运行状态。
set -euo pipefail

cd "$(dirname "$0")"

if ! node server/cli.mjs update; then
  echo
  echo "[update.sh] 升级失败，服务保持升级前的状态未变。" >&2
  exit 1
fi