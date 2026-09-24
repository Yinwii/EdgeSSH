#!/usr/bin/env bash
# EdgeSSH 一键卸载脚本（Linux / macOS）
#
# 用法：
#   ./uninstall.sh             # 完全卸载（停止服务 + 删除运行时数据 + 删除整个项目目录）
#   ./uninstall.sh --keep-code # 仅清理运行时数据，保留源码（可重新初始化后再用）
#
# 默认会把整个项目目录一并删掉。如果只想清理数据但保留源码以便再次部署，请用 --keep-code。
set -euo pipefail

KEEP_CODE=false
for arg in "$@"; do
  case "$arg" in
    --keep-code) KEEP_CODE=true ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "[uninstall] 未知参数: $arg (支持 --keep-code / -h)" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

if [[ $EUID -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  SUDO=sudo
else
  SUDO=
fi

echo "[uninstall] 目标项目目录：$PROJECT_DIR"

# ---- 1) 停止服务（如还在运行）----
echo "[uninstall] 1/4 停止服务 ..."
if [[ -f "$PROJECT_DIR/server/cli.mjs" ]]; then
  (cd "$PROJECT_DIR" && node server/cli.mjs stop) || echo "       [跳过] cli.mjs stop 失败（可能服务未在运行）"
fi

# 兜底：杀残留 workerd / serve.mjs 进程
echo "[uninstall] 2/4 兜底清理残留进程 ..."
pkill -f "$PROJECT_DIR/server/serve.mjs" 2>/dev/null || true
$SUDO pkill -f workerd 2>/dev/null || true

# ---- 3) 删除运行时数据 ----
echo "[uninstall] 3/4 删除运行时数据（server/data、.env、ENCRYPTION_KEY）..."
rm -rf "$PROJECT_DIR/server/data" 2>/dev/null || true
rm -f "$PROJECT_DIR/.env" 2>/dev/null || true

# ---- 4) 全部卸载 / 保留源码 ----
if [[ "$KEEP_CODE" == "false" ]]; then
  echo "[uninstall] 4/4 删除整个项目目录 ..."
  cd /
  $SUDO rm -rf "$PROJECT_DIR"
  echo "[uninstall] 完成。EdgeSSH 已从本机完全移除。"
else
  echo "[uninstall] 4/4 保留源码 ..."
  echo "[uninstall] 完成。源码保留在 $PROJECT_DIR（运行时数据已清理）。"
  echo "  重新部署：curl -fsSL https://raw.githubusercontent.com/Yinwii/EdgeSSH/main/deploy.sh | sudo bash -s -- $PROJECT_DIR"
fi