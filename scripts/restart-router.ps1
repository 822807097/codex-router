# restart-router.ps1 — 无感重启路由（不打断在跑任务）
# 原理：先优雅停止旧进程（/_admin/shutdown 或 Ctrl+C → SIGINT 排空），
#       确认旧进程退出、端口释放后，再启动新进程接管。
# 新版正常运行模式不暴露进程控制端点（安全设计），因此用控制台 Ctrl+C 事件触发 SIGINT。
$ErrorActionPreference = 'Stop'

# Send-CtrlC 会 FreeConsole/AttachConsole，非交互或重定向下控制台句柄可能失效，
# Write-Host 届时抛「句柄无效 0x6」（2026-09-08 实测）——打印失败不得中断排空/强杀。
function Say($msg, [ConsoleColor]$color = 'Gray') {
    try { Write-Host $msg -ForegroundColor $color } catch { }
}

$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
$here = $PSScriptRoot
# 兼容两种目录布局（scripts/ 子目录 或 与 mjs 同目录）
$router = Join-Path $here '..\codex-router.mjs'
if (-not (Test-Path $router)) { $router = Join-Path $here 'codex-router.mjs' }
$cfgPath = Join-Path (Split-Path $router) 'config.json'

# Ctrl+C 事件需要附加到目标进程的控制台；目标进程必须拥有独立控制台（Start-Process 默认新建）。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RouterCtrlC {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
}
'@

function Send-CtrlC($targetPid) {
    # 发送前让本进程忽略 Ctrl+C，避免被同一控制台广播信号中断；
    # 目标进程（node）不受影响，仍会收到 SIGINT 走优雅排空。
    [RouterCtrlC]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
    try {
        [RouterCtrlC]::FreeConsole() | Out-Null
        $attached = [RouterCtrlC]::AttachConsole([uint32]$targetPid)
        if (-not $attached) { return $false }
        # 进程组 0 = 目标控制台内所有进程（路由进程无子进程，仅它自己）
        $sent = [RouterCtrlC]::GenerateConsoleCtrlEvent(0, 0)
        return $sent
    } finally {
        [RouterCtrlC]::FreeConsole() | Out-Null
        [RouterCtrlC]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
    }
}

# 1. 优雅停止旧进程（存在时）
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $oldPids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($oldPid in $oldPids) {
        Say "停止旧进程 PID=$oldPid（优雅排空，在跑任务将继续完成）"
        # 1a. 兼容仍提供关闭端点的实例
        try {
            Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/_admin/shutdown" -TimeoutSec 3 | Out-Null
            Say "已通过 /_admin/shutdown 通知优雅退出"
        } catch {
            # 新版无此端点（404），继续走 Ctrl+C
        }
        # 1b. 进程仍在则发送 Ctrl+C（触发 SIGINT → gracefulExit）
        if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
            if (Send-CtrlC $oldPid) { Say "已发送 Ctrl+C（SIGINT）触发优雅排空" }
            else { Say "无法附加目标进程控制台，请检查进程状态" Yellow }
        }
    }
    # 1c. 等待旧进程排空退出（路由内部有 10 分钟安全阀）。
    # 事件循环冻结的进程不响应 SIGINT（2026-09-08 实测）：优雅窗口 40 秒后
    # 强制结束，避免 restart 卡满 600 秒超时、用户以为脚本死了。
    $graceDeadline = (Get-Date).AddSeconds(40)
    $forceDeadline = (Get-Date).AddSeconds(600)
    foreach ($oldPid in $oldPids) {
        $forceStopped = $false
        while (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
            if ((Get-Date) -gt $forceDeadline) { Say "等待旧进程排空超时，请稍后重试" Red; exit 1 }
            if (-not $forceStopped -and (Get-Date) -gt $graceDeadline) {
                Say "PID=$oldPid 未在优雅窗口内退出（疑似事件循环冻结），强制结束" Yellow
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                $forceStopped = $true
            }
            Start-Sleep -Milliseconds 500
        }
    }
} else {
    Say "旧进程未运行，直接启动新进程"
}

# 2. 注入环境变量（从 Machine/User 读取 config 里声明的 envKey）
$env:CODEX_HOME = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$env:ROUTER_LOG = Join-Path (Split-Path $router) 'router.log'
function Get-EnvAny($n) { $v = [Environment]::GetEnvironmentVariable($n, 'Process'); if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'User') }; if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'Machine') }; $v }
$keySet = @{}
if (Test-Path $cfgPath) {
    # 显式 UTF8：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 解码，会把中文注释读坏导致 JSON 解析失败
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($t in @($cfg.targets)) { if ($t.envKey) { $keySet[$t.envKey] = $true } }
    if ($cfg.visionRelay.envKey) { $keySet[$cfg.visionRelay.envKey] = $true }
}
foreach ($k in $keySet.Keys) { $v = Get-EnvAny $k; if ($v) { Set-Item "env:$k" $v } }

# 3. 直接后台启动 node（比隐藏 powershell 更可靠）
# 控制台输出落盘（out/err 必须分文件）：崩溃/启动错误不再无声丢失，便于事后定位。
$routerDir = Split-Path $router
$consoleOut = Join-Path $routerDir 'router-console.out.log'
$consoleErr = Join-Path $routerDir 'router-console.err.log'
# 显式指定工作目录：计划任务等场景默认 CWD 是 System32，相对路径会解析到系统目录。
Start-Process -WindowStyle Hidden node -ArgumentList "`"$router`"" -WorkingDirectory $routerDir -RedirectStandardOutput $consoleOut -RedirectStandardError $consoleErr | Out-Null

# 4. 等待新进程监听就绪
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
        if ($h.ok) { Say "codex-router 已无感重启，监听 127.0.0.1:$port"; exit 0 }
    } catch { }
}
Say "重启后未检测到监听，请手动运行 start-router.ps1 查看报错" Red
exit 1
exit 1
