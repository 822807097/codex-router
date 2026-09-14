#!/usr/bin/env bash
# stop-router.sh — 优雅停止路由（不打断在跑任务）
# 发送 SIGTERM（新版入口走 gracefulExit 排空），等待端口释放；
# 绝不 kill -9 强杀。路由内部有 10 分钟排空安全阀兜底。
# Windows/Git Bash 说明：原生 node 进程收不到 MSYS 的 SIGTERM，
# 此时退化为 taskkill（无 /F，先请求关闭），仍失败则提示改用 restart-router.ps1。
# 用法：bash stop-router.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${ROUTER_PORT:-15730}"
WAIT_SECONDS="${ROUTER_STOP_WAIT_SECONDS:-600}"

# shellcheck source=lib-port-pid.sh
source "$SCRIPT_DIR/lib-port-pid.sh"

PID=$(router_pid "$PORT")

if [ -z "$PID" ]; then
    echo "codex-router 未在运行"
    # 维护标记：明确停机时让 watchdog 跳过拉起（人为停止 ≠ 故障死亡）
    mkdir -p "$SCRIPT_DIR"
    touch "$SCRIPT_DIR/.watchdog-maintenance"
    exit 0
fi

echo "停止 codex-router (PID: $PID)，优雅排空在跑任务..."
# Windows 原生 node 进程收不到 MSYS 的 SIGTERM（2026-09-13 对抗审查实锤：
# kill -TERM 不投递、taskkill 无 /F 对控制台进程失败——两条路都触发不了
# gracefulExit）。Windows 下委托 stop-router.ps1（AttachConsole+CTRL_EVENT 方案）。
# 维护标记在停止完成后保留（stop = 保持停止，watchdog 不得拉起；
# start-router 启动成功或标记 TTL 过期后自动解除）
mkdir -p "$SCRIPT_DIR"
touch "$SCRIPT_DIR/.watchdog-maintenance"
if command -v powershell.exe >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/stop-router.ps1" ]; then
    MSYS_NO_PATHCONV=1 powershell.exe -ExecutionPolicy Bypass -File "$SCRIPT_DIR/stop-router.ps1"
    exit $?
fi
if kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
elif command -v taskkill >/dev/null 2>&1; then
    taskkill //PID "$PID" >/dev/null 2>&1 || true
fi

# 等待端口释放（跨平台：不用 kill -0，Windows 原生 PID 不适用）
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while port_listening "$PORT"; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
        echo "等待排空超时（${WAIT_SECONDS} 秒），端口仍被占用；请稍后重试或使用 restart-router.ps1" >&2
        exit 1
    fi
    sleep 1
done

echo "codex-router 已优雅退出"
