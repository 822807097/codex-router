#!/usr/bin/env bash
# restore-custom.sh — 一键恢复自定义模型组合
# 动作：向 config.toml 写回 model_provider/model_catalog_json/[model_providers.router]，
#       拉起路由。跑完请完全重启 Codex 桌面端。

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

# 段感知守卫：只认「顶层」（首个段头之前）的 model_provider / model_catalog_json；
# 项目级同名键不算已存在。两个键都要查——本脚本成对写入，陈旧的孤立
# model_catalog_json 不处理会在插入后产生重复键（审查 #22）
if ! awk '/^[[:space:]]*\[/{t=1} !t && (/^[[:space:]]*model_provider[[:space:]]*=/ || /^[[:space:]]*model_catalog_json[[:space:]]*=/) {found=1} END{exit !found}' "$CFG"; then
    # 顶层必须有 model = 行才能定位插入点；没有就明确报错（否则会插进项目段并谎报成功）
    if ! awk '/^\[/{t=1} !t && /^model[[:space:]]*=/{found=1} END{exit !found}' "$CFG"; then
        echo "错误：config.toml 顶层没有 model = 行，无法定位插入点。请改用管理面板「一键接入路由」。" >&2
        exit 1
    fi
    # 插在顶层 model = "..." 行之后。
    # 用 ENVIRON 而非 -v 传路径：awk 的 -v 会处理转义序列（Windows 反斜杠路径的 \t/\n
    # 会被变成 TAB/换行写坏 config.toml），ENVIRON 原样传递。
    export CODEX_HOME
    awk '
        /^[[:space:]]*\[/ { intable = 1 }
        !intable && !done && /^[[:space:]]*model[[:space:]]*=/ {
            # TOML 基本字符串要求正斜杠：Windows 反斜杠路径（\U \t 等）会被当
            # 转义序列写坏 config.toml（与 restore-custom.ps1 / codex-desktop-config.mjs 对齐）
            p = ENVIRON["CODEX_HOME"] "/models.json"
            gsub(/\\/, "/", p)
            print
            print "model_provider = \"router\""
            print "model_catalog_json = \"" p "\""
            done = 1
            next
        }
        { print }
    ' "$CFG" > "$CFG.tmp" && cat "$CFG.tmp" > "$CFG" && rm -f "$CFG.tmp"
    echo "已写回 model_provider / model_catalog_json"
else
    echo "顶层 model_provider / model_catalog_json 已存在，跳过"
fi

# 检查是否已有 [model_providers.router]
if ! grep -q '^[[:space:]]*\[model_providers\.router\]' "$CFG"; then
    cat >> "$CFG" <<'EOF'

# --- Local routing proxy: official via local proxy tunnel, third-party direct, vision relay ---
[model_providers.router]
name = "LocalRouter"
base_url = "http://127.0.0.1:15730/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
EOF
    echo "已写回 [model_providers.router] 段"
else
    echo "router 段已存在，跳过"
fi

# 启动路由
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/restart-router.sh"

echo ""
echo "完成。请完全重启 Codex 桌面端，选择器将显示官方 + 自定义全部模型。"
