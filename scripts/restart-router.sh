#!/usr/bin/env bash
# restart-router.sh — 重启路由（改完配置/key 后执行）
# 用法：bash restart-router.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${ROUTER_PORT:-15730}"

echo "停止旧路由..."
bash "$SCRIPT_DIR/stop-router.sh"
sleep 1

echo "启动新路由..."
nohup bash "$SCRIPT_DIR/start-router.sh" > /tmp/codex-router.log 2>&1 &
disown

# 等待健康检查就绪（healthz 是真实就绪信号，比端口监听更可靠且跨平台）
for i in $(seq 1 15); do
    sleep 1
    if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
        echo "codex-router 已重启，监听 127.0.0.1:$PORT"
        exit 0
    fi
done

echo "重启后 healthz 未就绪，请查看 /tmp/codex-router.log" >&2
exit 1
