#!/usr/bin/env bash
# EdgeSSH 一键部署
# 项目本身只需要：Node 22 + 克隆仓库 + 启动（npm ci / build 自动）
# 默认装到脚本所在目录；可作为参数 1 指定安装目录，参数 2 指定备份包还原
#
# 用法：
#   ./deploy.sh                                   # 部署到脚本所在目录
#   ./deploy.sh /opt/edgessh                      # 部署到指定目录
#   ./deploy.sh /opt/edgessh /tmp/backup.tar.gz   # 部署 + 还原旧数据
#   PORT=9000 ./deploy.sh /opt/edgessh            # 自定义端口（默认 8787）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${1:-$SCRIPT_DIR}"
REPO="${REPO:-https://github.com/Yinwii/EdgeSSH.git}"
BACKUP="${2:-}"
PORT="${PORT:-8787}"

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

# .env 初始化（首次部署且用户已通过 PORT 环境变量指定端口时生效；
# 模板默认 PORT=8787，sed 只改这一行，其余配置（GitHub OAuth、APP_ORIGIN 等）保留为模板注释）。
if [[ ! -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/server/.env.example" ]]; then
  echo "[deploy] 未检测到 .env，从 server/.env.example 初始化（PORT=$PORT）"
  sed "s/^PORT=.*/PORT=$PORT/" "$INSTALL_DIR/server/.env.example" > "$INSTALL_DIR/.env"
  echo "[deploy] 其他配置（GitHub OAuth / APP_ORIGIN 等）：编辑 $INSTALL_DIR/.env"
fi

# 端口覆盖（迁移方通过 PORT_OVERRIDE 显式指定时，改写还原出来的 .env）
if [[ -n "${PORT_OVERRIDE:-}" ]]; then
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    sed -i "s/^PORT=.*/PORT=$PORT_OVERRIDE/" "$INSTALL_DIR/.env"
    echo "[deploy] 已按迁移指定覆盖端口：PORT=$PORT_OVERRIDE"
  fi
fi

# 启动（cli.mjs 自动 npm ci + build；会打印监听地址、访问入口）
cd "$INSTALL_DIR"
node server/cli.mjs start

# 收尾提示：实际生效端口 + 外网访问前提
FINAL_PORT="$(grep -s '^PORT=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2)"
FINAL_PORT="${FINAL_PORT:-$PORT}"
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "----------------------------------------------"
echo "  服务端口   : $FINAL_PORT"
[[ -n "$SERVER_IP" ]] && echo "  访问地址   : http://$SERVER_IP:$FINAL_PORT"
echo "  若外网无法访问，请检查防火墙/云安全组是否放行 $FINAL_PORT 端口"
echo "    （如 ufw: ufw allow $FINAL_PORT/tcp）"