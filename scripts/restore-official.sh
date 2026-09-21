#!/usr/bin/env bash
# restore-official.sh — 一键恢复 Codex 官方配置
# 动作：从 config.toml 移除 model_provider/model_catalog_json/[model_providers.router]，
#       停止路由。跑完请完全重启 Codex 桌面端。

set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CFG="$CODEX_HOME/config.toml"

if [ ! -f "$CFG" ]; then
    echo "错误：$CFG 不存在" >&2
    exit 1
fi

# 备份
BAK="$CFG.bak-$(date +%Y%m%d-%H%M%S)"
cp "$CFG" "$BAK"
echo "已备份：$BAK"

# 单趟 awk 完成清理（段感知，GNU/BSD awk 行为一致）：
#   只剥顶层（首个段头之前）的 model_provider / model_catalog_json 行——项目级
#   [projects.*] 里的同名键保留，与 JS 版（codex-desktop-config.mjs
#   stripRouterDefaultToToml）语义一致；**保留 [model_providers.router] 段**——
#   历史会话 rollout 元数据持久化了 model_provider:"router"，段被删旧对话打开时报
#   「Model provider `router` not found」（审查 #23：此前脚本删段与 JS 行为相悖）。
#   段头/键名锚点允许前导空白（与 JS filterTopLevelLines/isTomlSectionHeader 对齐，
#   审查 #24/#27）；注意不能用 sed + \s（macOS BSD sed 把 \s 当字面 s，会静默删不掉）。
awk '
    /^[[:space:]]*\[/ { intable = 1 }
    !intable && (/^[[:space:]]*model_provider[[:space:]]*=/ || /^[[:space:]]*model_catalog_json[[:space:]]*=/) { next }
    { print }
' "$CFG" > "$CFG.tmp" && cat "$CFG.tmp" > "$CFG" && rm -f "$CFG.tmp"

echo "config.toml 已恢复官方状态"

# 停止路由
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/stop-router.sh"

echo ""
echo "完成。请完全重启 Codex 桌面端，选择器将回到纯官方模型。"
echo "想恢复自定义模型组合：运行 restore-custom.sh"
