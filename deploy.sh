#!/usr/bin/env bash
# EdgeSSH 一键部署
# 项目本身只需要：Node 22 + 克隆仓库 + 启动（npm ci / build 自动）
# 默认装到脚本所在目录；可作为参数 1 指定安装目录，参数 2 指定备份包还原
#
# 用法：
#   ./deploy.sh                                   # 部署到脚本所在目录
#   ./deploy.sh /opt/edgessh                      # 部署到指定目录
#   ./deploy.sh /opt/edgessh /tmp/backup.tar.gz   # 部署 + 还原旧数据
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${1:-$SCRIPT_DIR}"
REPO="${REPO:-https://github.com/Yinwii/EdgeSSH.git}"
BACKUP="${2:-}"

# Node.js 22（如缺自动装，apt + NodeSource）
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)" -lt 22 ]]; then
  if [[ $EUID -ne 0 ]]; then SUDO=sudo; else SUDO=; fi
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y -qq nodejs
fi

# 仓库：已有则更新，否则克隆
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
  git clone "$REPO" "$INSTALL_DIR"
else
  echo "[deploy] $INSTALL_DIR 已有非 git 内容" >&2; exit 1
fi

# 还原备份（可选）
[[ -n "$BACKUP" && -f "$BACKUP" ]] && tar -xzf "$BACKUP" -C "$INSTALL_DIR"

# 启动（cli.mjs 自动 npm ci + build）
cd "$INSTALL_DIR"
node server/cli.mjs start