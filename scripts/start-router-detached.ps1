# start-router-detached.ps1 — 后台独立启动路由（进程脱离启动它的终端/会话）
# 场景：此前用前台 bash/终端拉起的路由，会话被清理（关闭终端、自动化会话结束、
# 远程 shell 断开）时进程被连带杀死——表现为「路由无声消失、无任何崩溃日志」。
# 本脚本用 Start-Process 创建独立进程树，日志落盘，重启机器前持续可用。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\start-router-detached.ps1
# 停止：powershell -ExecutionPolicy Bypass -File scripts\stop-router.ps1（或面板「优雅重启」）

$ErrorActionPreference = 'Stop'

$port = if ($env:ROUTER_PORT) { $env:ROUTER_PORT } else { 15730 }

# 已在监听则跳过（幂等）
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "端口 $port 已有进程监听（PID $($listening[0].OwningProcess)），跳过启动"
    exit 0
}

$scriptDir = $PSScriptRoot
$router = Join-Path $scriptDir '..\codex-router.mjs'
if (-not (Test-Path $router)) { $router = Join-Path $scriptDir 'codex-router.mjs' }
if (-not (Test-Path $router)) { throw "找不到 codex-router.mjs" }

# Node 版本预检（与 start-router.sh 同款：node:sqlite 需 v23.4+）
$nodeVersion = ''
try { $nodeVersion = (node -v).Trim() } catch { $nodeVersion = '' }
$nodeMajor = 0
if ($nodeVersion -match '^v?(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 23) {
    throw "Node.js 版本过低（$nodeVersion）。需要 v23.4+（推荐 LTS v24）：https://nodejs.org"
}

# 环境注入：CODEX_HOME + 配置里引用的全部 envKey（User/Machine 双作用域补齐）
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$env:CODEX_HOME = $codexHome

function Get-EnvAny($name) {
    $v = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'User') }
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'Machine') }
    return $v
}

$cfgPath = if ($env:ROUTER_CONFIG_PATH) { $env:ROUTER_CONFIG_PATH } else { Join-Path $scriptDir '..\config.json' }
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $scriptDir 'config.json' }
$keySet = @{}
if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($t in @($cfg.targets)) { if ($t.envKey) { $keySet[$t.envKey] = $true } }
    if ($cfg.visionRelay.envKey) { $keySet[$cfg.visionRelay.envKey] = $true }
}
if ($env:ROUTER_ENV_KEYS) { foreach ($k in $env:ROUTER_ENV_KEYS.Split(',')) { $keySet[$k.Trim()] = $true } }
foreach ($k in $keySet.Keys) {
    $v = Get-EnvAny $k
    if ($v) { Set-Item "env:$k" $v } else { Write-Host "警告: 环境变量 $k 未设置，对应通道会失败" -ForegroundColor Yellow }
}

$env:ROUTER_LOG = if ($env:ROUTER_LOG) { $env:ROUTER_LOG } else { Join-Path $scriptDir '..\router.log' }

# 日志落盘（stdout/stderr 分文件，滚动由外部清理）
$logOut = Join-Path $scriptDir '..\router-detached.out.log'
$logErr = Join-Path $scriptDir '..\router-detached.err.log'

$process = Start-Process -FilePath 'node' `
    -ArgumentList "`"$router`"" `
    -WorkingDirectory (Split-Path $router -Parent) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr `
    -PassThru

Start-Sleep -Seconds 4
$alive = -not $process.HasExited
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($alive -and $listening) {
    Write-Host "codex-router 已独立启动（PID $($process.Id)，端口 $port）——脱离本会话，终端/自动化结束不影响运行"
    Write-Host "日志：$logOut / $logErr"
} elseif ($alive) {
    Write-Host "进程已启动（PID $($process.Id)）但端口 $port 尚未监听，请稍后查看 $logErr"
} else {
    Write-Host "启动失败（进程已退出），请查看 $logErr" -ForegroundColor Red
    exit 1
}
