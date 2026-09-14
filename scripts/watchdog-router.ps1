# watchdog-router.ps1 — 路由自愈守护（建议由计划任务每 1 分钟调用）
# 以 /healthz 的 HTTP 响应作为健康标准（端口在听但事件循环冻结的进程算故障，
# 2026-09-08 崩溃正是这种形态——用端口探测会漏检）；连续 2 次失败才调用
# restart-router.ps1 无感重启，单一瞬断不误杀。
$ErrorActionPreference = 'SilentlyContinue'
$here = $PSScriptRoot
$port = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 15730 }
$saveRoot = Split-Path (Resolve-Path (Join-Path $here '..'))
$logPath = Join-Path $saveRoot 'router-watchdog.log'
$restartScript = Join-Path $here 'restart-router.ps1'
$stateFile = Join-Path $here '.watchdog-state'
# 维护标记：restart/stop 脚本在停止~就绪窗口写入——排空期 healthz 必失败是预期，
# watchdog 此刻拉起会与人为操作打架（结构冲突，2026-09-13 审查定论）。
# 生命周期闭环：start 启动成功清除标记；此处对超龄标记（>15 分钟）按残留清除
# （覆盖 restart 异常退出/Ctrl+C 残留导致 watchdog 永久静默的反向风险）。
$maintenanceMarker = Join-Path $here '.watchdog-maintenance'
if (Test-Path $maintenanceMarker) {
    $markerAgeMin = -1
    try {
        $stamp = (Get-Content $maintenanceMarker -Raw -ErrorAction Stop) -replace '^[^\d]*','' -replace '\s.*$',''
        if ($stamp) { $markerAgeMin = ((Get-Date) - [datetime]$stamp).TotalMinutes }
    } catch { }
    if ($markerAgeMin -ge 0 -and $markerAgeMin -lt 15) {
        # 维护中：不计数不重启（保留既有 state，退出后下次巡检自然恢复判定）
        exit 0
    }
    Remove-Item $maintenanceMarker -Force -ErrorAction SilentlyContinue
    Log "维护标记超龄（${markerAgeMin} 分钟）按残留清除，恢复守护判定"
}

function Log($msg) {
    $line = "{0} {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

$ok = $false
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 8
    $ok = [bool]$h.ok
} catch { $ok = $false }

$failCount = 0
if (Test-Path $stateFile) { $failCount = [int](Get-Content $stateFile -ErrorAction Stop) }

if ($ok) {
    if ($failCount -ne 0) { Log "健康检查恢复（此前连续失败 $failCount 次），状态清零" }
    Set-Content -Path $stateFile -Value '0' -Encoding UTF8
    exit 0
}

$failCount += 1
Set-Content -Path $stateFile -Value $failCount -Encoding UTF8
Log "健康检查失败（第 $failCount 次连续失败）"
if ($failCount -lt 2) { exit 0 }  # 单次瞬时失败不重启，连续两次才动手

Log "触发重启：调用 restart-router.ps1"
try {
    $out = & $restartScript 2>&1 | Out-String
    Log ("restart 输出: " + $out.Trim())
} catch {
    Log ("restart 调用异常: " + $_.Exception.Message)
}
Set-Content -Path $stateFile -Value '0' -Encoding UTF8
exit 0
