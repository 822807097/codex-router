#!/usr/bin/env bash
# lib-port-pid.sh — 跨平台查监听端口的 PID（macOS/Linux 用 lsof，Windows Git Bash 用 netstat）
# 用法：source 本文件后调用 router_pid <port>
# 输出：监听该端口的第一个 PID（无则输出空串）

router_pid() {
    local port="$1" pid=""
    if command -v lsof >/dev/null 2>&1; then
        pid=$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null | head -n1 || true)
    elif command -v netstat >/dev/null 2>&1; then
        # Windows netstat 形如：TCP  127.0.0.1:15730  0.0.0.0:0  LISTENING  12345
        pid=$(netstat -ano 2>/dev/null | awk -v p=":$port" '$1=="TCP" && $2 ~ p"$" && $4=="LISTENING" {print $5; exit}')
    fi
    echo "$pid"
}

# port_listening <port> — 端口是否仍处于 LISTEN（跨平台，用于等待释放/就绪）
port_listening() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti :"$port" -sTCP:LISTEN >/dev/null 2>&1
    else
        netstat -ano 2>/dev/null | awk -v p=":$port" '$1=="TCP" && $2 ~ p"$" && $4=="LISTENING" {found=1; exit} END {exit found?0:1}'
    fi
}
