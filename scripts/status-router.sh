#!/usr/bin/env bash
# status-router.sh — 查看路由状态（PID + 健康检查）
# 用法：bash status-router.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${ROUTER_PORT:-15730}"

# shellcheck source=lib-port-pid.sh
source "$SCRIPT_DIR/lib-port-pid.sh"

PID=$(router_pid "$PORT")

if [ -n "$PID" ]; then
    echo "codex-router 运行中 PID=$PID"
else
    echo "codex-router 未在运行"
fi

if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "healthz: ok"
else
    echo "healthz: 无响应"
fi
