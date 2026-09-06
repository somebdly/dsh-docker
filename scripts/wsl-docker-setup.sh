#!/usr/bin/env bash
# WSL2 Ubuntu Docker Engine + docker mcp 一键安装脚本
# 用法（Windows 管理员 PowerShell 或 wsl root）：
#   wsl -d Ubuntu -u root -e bash /mnt/c/<你的插件目录>/scripts/wsl-docker-setup.sh
set -euo pipefail

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== 1/6 系统基础 ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq || apt-get update -y

# 启用 systemd（WSL2 需要）
if [ ! -f /etc/wsl.conf ] || ! grep -q systemd /etc/wsl.conf 2>/dev/null; then
  cat > /etc/wsl.conf <<'EOF'
[boot]
systemd=true
EOF
  log "已启用 systemd（/etc/wsl.conf），稍后 wsl --shutdown 生效"
fi

log "=== 2/6 安装依赖 ==="
apt-get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null 2>&1 || true

log "=== 3/6 安装 Docker Engine ==="
# 优先官方脚本，失败回退清华/阿里镜像
if command -v docker >/dev/null 2>&1; then
  log "docker 已存在: $(docker --version)"
else
  log "尝试官方 get.docker.com ..."
  if curl -fsSL https://get.docker.com -o /tmp/get-docker.sh 2>/dev/null; then
    sh /tmp/get-docker.sh || true
  fi
  if ! command -v docker >/dev/null 2>&1; then
    log "官方脚本失败，使用清华镜像 ..."
    # 清华 TUNA docker-ce 镜像
    curl -fsSL https://mirrors.tuna.tsinghua.edu.cn/docker-ce/linux/ubuntu/gpg \
      -o /usr/share/keyrings/docker-archive-keyring.gpg 2>/dev/null || true
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://mirrors.tuna.tsinghua.edu.cn/docker-ce/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
      > /etc/apt/sources.list.d/docker.list 2>/dev/null || true
    apt-get update -y -qq || true
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || true
  fi
  if ! command -v docker >/dev/null 2>&1; then
    log "ERROR: Docker 安装失败，请检查网络"
    exit 1
  fi
  log "Docker 安装完成: $(docker --version)"
fi

log "=== 4/6 启动 Docker 服务 ==="
# WSL2 + systemd 场景
systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
systemctl enable docker 2>/dev/null || true

log "=== 5/6 安装 docker mcp 插件 ==="
# 二进制已由 Windows 侧拷贝到 /mnt/c/... 或 /root/；动态查找，避免硬编码用户名
SRC_CANDIDATES=(
  "/root/docker-mcp-binary"
)
# 在 Windows 用户目录下查找已拷贝的 docker-mcp 二进制（跨用户通用）
while IFS= read -r found; do
  SRC_CANDIDATES+=("$found")
done < <(find /mnt/c/Users -maxdepth 4 -type f -name docker-mcp 2>/dev/null || true)
DEST_DIR="$HOME/.docker/cli-plugins"
mkdir -p "$DEST_DIR"
INSTALLED=0
for src in "${SRC_CANDIDATES[@]}"; do
  if [ -f "$src" ] && [ -x "$src" ] || [ -f "$src" ]; then
    cp -f "$src" "$DEST_DIR/docker-mcp"
    chmod +x "$DEST_DIR/docker-mcp"
    INSTALLED=1
    log "docker mcp 已从 $src 安装"
    break
  fi
done
# 也装一份到 root 用户
if [ "$HOME" != "/root" ]; then
  mkdir -p /root/.docker/cli-plugins
  if [ "$INSTALLED" = "1" ]; then
    cp -f "$DEST_DIR/docker-mcp" /root/.docker/cli-plugins/docker-mcp 2>/dev/null || true
  fi
fi
if [ "$INSTALLED" != "1" ]; then
  log "ERROR: 未找到 docker-mcp 二进制源文件"
  exit 1
fi

log "=== 6/6 验证 ==="
docker --version
docker run --rm hello-world 2>&1 | tail -5 || true
"$DEST_DIR/docker-mcp" version 2>&1 || "$DEST_DIR/docker-mcp" --version 2>&1 || true
log "=== 完成 ==="
