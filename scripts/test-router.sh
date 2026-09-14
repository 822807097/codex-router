#!/usr/bin/env bash
# test-router.sh — 改完 key/URL 后的一键验收
# 用法：bash test-router.sh [--skip-official] [--skip-vision]
# 注意：改完环境变量后必须先 restart-router.sh，再跑本测试

set -euo pipefail

PORT="${ROUTER_PORT:-15730}"
BASE="http://127.0.0.1:$PORT"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${ROUTER_CONFIG_PATH:-$SCRIPT_DIR/../config.json}"
SKIP_OFFICIAL=false
SKIP_VISION=false

for arg in "$@"; do
    case $arg in
        --skip-official) SKIP_OFFICIAL=true ;;
        --skip-vision) SKIP_VISION=true ;;
    esac
done

# API key 解析：优先 ROUTER_TEST_KEY；缺省试 router-local（开放模式），
# 401（强制鉴权模式）时自动创建临时测试 key 并在退出时吊销。
# keys/create 响应形状 {ok, key:{key:"sk-router-..."}}——嵌套字段别取错。
TEST_KEY_ID=""
TEST_KEY=""
resolve_test_key() {
    if [ -n "${ROUTER_TEST_KEY:-}" ]; then
        TEST_KEY="$ROUTER_TEST_KEY"
        return 0
    fi
    local probe_code
    probe_code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/models" \
        -H "Authorization: Bearer router-local" --max-time 10)
    if [ "$probe_code" = "200" ]; then
        TEST_KEY="router-local"
        return 0
    fi
    local created
    created=$(curl -s -X POST "$BASE/_admin/api/keys/create" \
        -H "content-type: application/json" \
        -H "origin: $BASE" \
        -d '{"name":"router-test-sh-temp","client":"test"}' --max-time 10) || true
    TEST_KEY_ID=$(printf '%s' "$created" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.key?.id||'')}catch{console.log('')}})")
    TEST_KEY=$(printf '%s' "$created" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.key?.key||'')}catch{console.log('')}})")
    if [ -z "$TEST_KEY" ]; then
        echo "[key] 无法获得测试 Key（强制鉴权模式下创建临时 Key 失败）" >&2
        return 1
    fi
    echo "[key] 强制鉴权模式：已创建临时测试 Key（退出时自动吊销）"
}
cleanup_test_key() {
    if [ -n "$TEST_KEY_ID" ]; then
        curl -s -o /dev/null -X POST "$BASE/_admin/api/keys/revoke" \
            -H "content-type: application/json" -H "origin: $BASE" \
            -d "{\"id\":\"$TEST_KEY_ID\"}" --max-time 10 || true
    fi
}
trap cleanup_test_key EXIT

echo "=== 本地路由模型测试 ==="

# 0. 路由存活 + 测试 Key 解析
if ! curl -sf "$BASE/healthz" >/dev/null 2>&1; then
    echo "[路由] 未运行！请先执行 restart-router.sh" >&2
    exit 1
fi
echo "[路由] 运行中"
resolve_test_key || exit 1

# 1. 环境变量存在性（从实际配置读取名称，绝不打印值）
CONFIG_KEY_NAMES="$(node -e '
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const names = [...(cfg.targets || []), cfg.visionRelay]
  .map((item) => item?.envKey)
  .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name || ""));
process.stdout.write([...new Set(names)].join(" "));
' "$CONFIG_PATH")"
EXTRA_KEY_NAMES="${ROUTER_ENV_KEYS:-}"
KEY_NAMES="$CONFIG_KEY_NAMES ${EXTRA_KEY_NAMES//,/ }"
for k in $KEY_NAMES; do
    if [ -n "${!k:-}" ]; then
        echo "[env] $k 已设置"
    else
        echo "[env] $k 未设置！对应通道会失败" >&2
    fi
done

# 2. 文本通道测试
test_model() {
    local model=$1
    local body="{\"model\":\"$model\",\"store\":false,\"input\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Reply exactly: OK\"}]}]}"
    local http_code response
    # 不用 -f：失败时也要拿到响应体展示真实上游错误（-f 会把 body 吞掉只剩 22 码）
    response=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1/responses" \
        -H "content-type: application/json" \
        -H "Authorization: Bearer $TEST_KEY" \
        -d "$body" \
        --max-time 90 2>&1)
    http_code="${response##*$'\n'}"
    response="${response%$'\n'*}"
    if [ "$http_code" != "200" ]; then
        echo "[FAIL] $model -> HTTP $http_code ${response:0:200}"
        return 1
    fi
    local text
    text=$(printf '%s' "$response" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{let j;try{j=JSON.parse(d)}catch{for(const l of d.split(/\r?\n/)){if(!l.startsWith('data: '))continue;try{const e=JSON.parse(l.slice(6));if(e.type==='response.completed')j=e.response}catch{}}}console.log(j?.output_text||(j?.output||[]).map(m=>(m.content||[]).map(c=>c.text||'').join('')).join(''))})")
    echo "[OK]   $model -> 回复：${text:-OK}"
}

test_model "deepseek-v4-flash"
test_model "qwen3.8-max"

# 3. 视觉中继（可选）
if [ "$SKIP_VISION" = false ]; then
    echo "[视觉中继] 测试跳过（需要生成图片，暂不支持 bash 版）"
fi

# 4. 官方通道（可选）
if [ "$SKIP_OFFICIAL" = false ]; then
    code=''
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/responses" \
        -H "content-type: application/json" \
        -H "Authorization: Bearer $TEST_KEY" \
        -d '{"model":"gpt-5.4-mini","store":false,"stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"Reply exactly: OK"}]}]}' \
        --max-time 25 2>/dev/null)
    case $code in
        200) echo "[OK]   官方通道 -> 200 流式正常" ;;
        429) echo "[OK]   官方通道 -> 429 额度用尽（链路通）" ;;
        *)   echo "[FAIL] 官方通道 -> HTTP $code（检查本地代理是否运行）" >&2 ;;
    esac
fi

echo ""
echo "总结：测试完成"
