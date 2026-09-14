# 全量审查与修复报告（2026-09-13）

- 范围：全项目（核心路由链路 / 管理面 API / 前端面板 / 支撑子系统 / 运维脚本）
- 方法：4 个并行新鲜眼睛代理分区深审（只读）→ 汇总去重 → 逐条修复 → 全量回归 → 对抗复审
- 计划文档：docs/plan-2026-09-13-full-audit-and-fix.md

## 一、修复清单（按分区）

### 核心路由链路（lib/router-handler.mjs、official-incremental、transport、response-pipeline 等）

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| C1 | P1 | 官方增量被 4xx 拒绝后回退引用从未赋值的 `officialIncBase`，实际发送 delta-only 请求（静默丢上下文） | 增量改写前保存基线快照（previous_response_id/input/store） |
| C2 | P1 | 官方增量缓存无字节上限（256×3.7MB≈1GB 可 OOM）且 config 开关未接线 | store 加 maxBytes(64MB) 字节淘汰 + 单条超限不入缓存；codex-router 传入 `officialIncremental` 配置；router-config 新增校验段 |
| C3 | P1 | 429 冷却分型修复漏掉 catch 路径：chat/桥接通道 429 仍用文本启发式，有余量账号被误封 30 分钟 | catch 路径统一走 decide429Cooldown 分型 |
| C4 | P1 | 内置工具桥：裸 fetch 不走代理/不接请求 abort；SSE 回写无 destroyed 守卫（可积累成进程熔断停机）；SSE 中途出错不收尾客户端挂死 | 改走 transport rawHttpsRequest（代理/超时/abort 一致）；循环与回写全程 destroyed 守卫 + noop error 监听；出错收尾 end() |
| C5 | P2 | pipeChatCompletionsResponse 第 6 参数（429 观察器）死代码，假防线 | 接入：JSON flush 与 SSE flush 均回调（前 64KB 快照） |
| C6 | P2 | chat 透传 usage 扫描裸 Buffer.toString，多字节跨 chunk → U+FFFD 漏统计 | 改 StringDecoder |
| C7 | P2 | 增量续聊把 response.failed/incomplete 的 id 绑定为续聊基线 | 仅 status==='completed' 才 attachResponse |
| C9 | P2 | 最终错误回写缺 destroyed 守卫（窄窗口可触发未捕获异常计入熔断） | 回写前统一 `destroyed/writableEnded` 复核 |
| C10 | P2 | token 统计 target 字段被污染为「model -> target」复合串，Dashboard 通道聚合失真 | 三个 pipe 函数新增 targetName 参数，统计用纯通道名 |
| C11 | P3 | 重复头（数组形态）retry-after 被丢弃 | 抽 retryAfterSeconds() 取首个可用值，5 处消费点统一 |
| C12 | P3 | readStreamSnippet 自身异常顶替原失败（丢 quotaObservation） | 包 try/catch 返回已读片段 |
| C16 | P3 | chat 透传无 tokenTracker 早退分支缺 error 监听 | 补监听 |
| C19 | P3 | SSE 终态后事件零容忍（宽松上游可触发销毁已完整响应） | 降级为忽略 |
| F2b | P1 | 【设计缺陷】整条代理链路不支持带认证代理：parseProxyUrl 丢账密、socks5 仅 NO_AUTH、HTTP CONNECT 无 Proxy-Authorization；前端 socks5/http 凭据也被静默丢弃 | transport 实现 RFC 1929 用户名密码子协商 + Proxy-Authorization Basic；parseProxyUrl 提取账密；前端 buildUrl 补 userinfo（ss 改 base64url 形态防特殊字符破坏链接）；新增 4 个真实 TCP 握手测试 |

### 管理面 API（lib/admin-api.mjs、api-keys、auth/*）

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| A1 | P1 | accounts/set-proxy 只写内存不落库（死代码佐证未写完），重启丢账号代理配置；set-priority 同类 | 两处补 persistAccount 落库 |
| A2 | P1 | fetch-models 拉取入库与模型删除联动清理绕过 revision/互斥锁：并发写丢更新；损坏目录文件按空池重建会抹掉整个池 | fetch-models 改 revision CAS（损坏跳过入库）+ 新文件走 prepareJsonWrite；删除联动纳入 codexDesktopMutex |
| A3 | P2 | /requests 的 limit 参数恒失效（url 已被剥查询串） | 从原始 req.url 解析 + 1..500 钳制；顺带修详情端点 decodeURIComponent 裸抛 |
| A5 | P2 | unsync-codex 路径脱敏正则笔误（`\^` 字面量）本地路径照常泄漏 | 改正确转义 |
| A7 | P2 | accounts/add 手动导入写死代理兜底 10808（OAuth 路径已修此处漏改） | 对齐：仅显式配置才启用 |
| A15 | P2 | vendor-presets 空 match 拼接产生空前缀分支正则（可劫持全部模型） | 空 match 直接用扩展式 |
| A11 | P3 | clearCooldown 可复活 auth_expired 账号（401 循环） | 仅接受 cooldown/suspect |
| A12 | P3 | requires_openai_auth 裸 /true/ 替换可误伤 | 精确整行匹配重写 |
| A13 | P3 | service/restart 双脚本并存时双重重启 | 命中即 break |
| A17 | P3 | chat-guard 只切开关不带阈值 → 400 | 缺省沿用现有值/默认 40 万 |
| A18 | P3 | accounts/delete 无 id 校验、不存在也 200 | 校验 + 404 语义 |
| A6 | P2 | credentials-vault 明文 token 写盘未收紧权限 | tmp 0600 + fd 写入（POSIX 生效，Windows 无害） |
| A10 | P3 | 探针 key 每次重启轮换，revoked 行无限累积 | rotate 前整体 DELETE |

### 支撑子系统（db、json-file-store、桥接、同步器等）

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| S1 | P2 | 复读坍缩最坏 O(n×1168)，16MB 聚合可冻结事件循环数十秒 | 256KB 扫描窗上限（尾部窗口） |
| S2 | P2 | 谷歌桥 functionResponse.name 回退 call_id，与 functionCall.name 不配对（契约级数据错误） | 从 assistant tool_calls 建 id→name 映射回填 |
| S3 | P2 | 会话同步 rollout 非原子覆盖写 + 打开不存在 sqlite 产生空库副作用 | tmp+rename 原子替换；sqlite 不存在跳过 |
| S4 | P2 | Dashboard 热力图/堆叠图 UTC 数据 + 本地时区标签错位一天 | 标签统一从 dayStr（UTC）派生 |
| S5 | P2 | TOML bearer token 转义不全（只删引号不处理反斜杠）+ 校验器对非法转义失明 | tomlEscape 完整转义（\、\"、控制字符）三处插值 + scanLine 校验转义后继字符 |
| S6 | P2 | google-channel readAll 无字节上限（流式形态可无界读入内存） | 64KB 错误体 / 32MB 整读上限 |
| S8 | P3 | token-tracker 小时槽本地截整点+UTC 标签混合口径 | 纯 UTC 截断对齐 db.mjs；注释注明无定时落盘（走 SQLite 旁路） |
| S9 | P3 | 合成条目 default_reasoning_level 两条路径默认值漂移（low vs medium） | 统一 medium（不在列表才退首档） |
| S10 | P3 | 谷歌 429 诊断捕获相对 cwd + 固定文件名互踩 | 锚定仓库 data/ + pid 后缀 |
| S13 | P3 | chatgpt-web 401/403/429 不更新 failure.status（客户端误收 502） | 各分支补真实 status |
| S14 | P3 | checkpoint close() 竞态窗口丢最后一条检查点 | 先置 closed 再 force 最终写 |
| S15 | P3 | GLM 改名恒假条件 + 版本点号被吃 | 删死条件；保留 `.` |
| S16 | P3 | db.mjs ALTER 先于建表靠空 catch 侥幸 | 移到建表后 |
| S18 | P3 | account-quota 注释 60s 与常量 15s 矛盾 | 改注释 |
| S7 | P3 | model-catalog 弱原子写（固定 tmp 名） | 唯一 tmp 名 + 失败清理 |

### 前端面板（web-admin）

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| F1 | P1 | 密钥池编辑模式留空 Key 被必填校验堵死（与自身提示矛盾） | 编辑模式放行留空（=不改），仅切换形态要求新 key；表格 v-loading + 失败重试态；优先级清空不再误存 0 |
| F3 | P1 | 跨页「测试所有模型连接」事件在懒加载组件挂载前派发丢失，按钮永久转圈 | 改 query 中转（?testAll=1），模型页挂载后消费；顺带修复 onMounted 内 useRoute() 失效导致 ?add=1 从未生效 |
| F4 | P1 | 侧栏服务状态恒绿假数据 + 写死端口 | 接入 gatewayOffline 真实状态 + /status 实际端口 |
| F5 | P1 | 设置页版本号写死 1.4.1（与侧栏矛盾） | onMounted 拉取真实版本 |
| F2 | P1 | 认证代理前端部分（见 C 批 F2b） | ProxyConfigEditor buildUrl 补 socks5/http userinfo、ss 改 base64url |
| F6-F20 | P2 | 添加模型无 loading/防重、分组手选被覆盖、压缩阈值非法静默成功、账号代理回显 mode 错、chatgpt-web 额度白发、手动导入无防重/明文、弹窗固定宽移动端溢出、key-row 溢出、加载静默失败、假状态 tag、保存误清压缩配置、示例硬编码端口、状态标签中英混杂、批量测速 loading 错乱 | 已派发专项修复（含 zh-cn locale、更新弹窗文案、echarts 重复键、OAuth 轮询超时、注释清洗等 P3） |

### 运维脚本

| # | 问题 | 修复 |
|---|---|---|
| X1 | status/stop/restart-router.sh 依赖 lsof，Windows Git Bash 全废（status 永远报未运行） | 新增 scripts/lib-port-pid.sh（lsof→netstat 回退）+ 端口释放等待替代 kill -0 + healthz 就绪探测；实测 status 正确报 PID |
| X2 | auth-manager 两个时间炸弹测试（快照固定 2026-09-11，>8h 过期后开始失败） | 注入固定 now；11/11 通过 |

## 三、对抗复审（阶段三）

新鲜眼睛代理因外部配额限制中断，改为主审逐 hunk 自查（覆盖全部高危改动：socks5 状态机、工具桥接线、增量基线、CAS 写入、pipe 参数、前端模板/脚本对应关系 + 构建）。

复审发现并已修复 1 项自引入回归：
- RFC 1929 子协商成功后 `buffer = Buffer.alloc(0)` 丢弃同包残留字节（服务器流水线发送 CONNECT 响应时握手挂到超时）→ 改为 `subarray(2)` 保留残留，与 stage 0 旧行为对称。测试 26/26 通过。

复审通过项抽查：工具桥 headers 为纯字符串对象（适配 rawHttpsRequest）、fetch-models 损坏路径不冒错给前端、mutex 所有路径 finally 释放、前端 14 个文件模板引用全部有脚本定义、dashboard renderStackedChart 完整、全量 969/969。

## 四、最终状态

- npm test：969/969 全绿（新增 4 个 socks5 认证用例）
- web-admin build：通过（0 错误）
- 路由：已重启两次（第二次纳入复审修复），healthz ok、36 通道加载、面板 200
- 实测验证：status 脚本正确报 PID；`/_admin/api/requests?limit=200` 参数生效
- 改动规模：41+ 文件（+836/-271），未提交（留待用户 review 后提交）

---

## 五、对抗性自查第二轮（2026-09-13 下午，三代理 + 主审）

三个新鲜眼睛代理（后端 diff / 前端契约 / 薄弱区域补扫）+ 主审实弹验证。发现并全部修复：

### P0（最重要，运行时实锤）
- **官方通道 SSE 被误判为非 SSE**：上游 09-12 起 content-type 失真，SSE 正文走了非 SSE 管线 → 官方增量永不绑定（每轮全量重发 5-10MB 烧额度）、真实 usage 全丢（output_tokens 恒 0）、响应历史失效、内存逼近 4GB OOM。修复：pipeNativeResponse 重构为「声明头判定 + 首块正文嗅探兜底」（unshift 回推分流），双向测试 + 真机验证。
- **增量续聊与上游彻底不兼容（实测定论）**：官方 codex 后端 09-12 起移除 previous_response_id（400 "Unsupported parameter: previous_response_id"）且强制 store:false（400 "Store must be set to false"）。处置：增量默认关闭（config.json 显式 `officialIncremental.enabled=true` 才开）+ 运行时连续 3 次「参数不支持」拒绝自动熔断（official.incremental_disabled）+ 拒绝体 detail 落日志（诊断白名单登记 detail 字段）。SSE 嗅探修复保留——usage 统计/响应历史/429 观察全部依赖它，且已验证恢复工作。

### P1/P2/P3（均已修）
- probeMcpServer spawn ENOENT 打穿进程熔断（spawn 'error' 监听 + Windows .cmd 提示）
- 非流式网页通道 `|| content` 回退泄漏未净化协议块/回声（对齐流式落空串）
- 工具桥轮次耗尽标注在 content 为空时失效 + 私有 tool_calls 透传客户端（统一标注+清调用+finish stop）
- ExecCustomToolBridge 无条件改写所有参数帧（按 item_id 集合门控 + done 帧 arguments→input）
- 跨页测速空跑假成功（modelsReady 信号等待数据加载）
- 批量测速 toast 洪水（silent 门控）；MCP 测试超时前后端脱节（前端传满 60s）
- 池化 socket timeout 监听器累积（MaxListenersExceededWarning 实证；park/take 清理）
- stop-router.sh Windows 优雅停止不可达（委托 stop-router.ps1）
- watchdog 与 stop/restart 结构性打架（维护标记 .watchdog-maintenance；restart 优雅窗 40s→120s 可配）
- 请求查看器成功请求显示 error:"running"（finish 与 summary 顺序）
- fetch-models 告警透出（syncWarning 字段+前端提示）；google 429 snippet 部分返回；mkdir 竞态
- TOML 段手术 .env 异位边界（双方标记只读）；official-incremental 超限陈旧基线清理
- launchDesktop Windows spawn error 监听；ensureInternalProbeKey 死函数删除；session_meta 宽容匹配
- 插件别名表 includes 方向误匹配（'codex'→VS Code，等值化）；initialize 提示动态拼目录
- test-router.sh 强制鉴权模式失效（自动建临时 key + 失败显示真实错误体，实弹验证）

### 运行时验证结论
- deepseek-v4-flash 全链路 200（828ms）；qwen3.8-max 403=百炼账号未购该模型（上游权益，透传正确）
- 增量两轮实测（>8KB 载荷、新 item 追加）：触发→400→全量回退 200（回退机制正确），实锤上游不支持
- 新实例内存基线 61MB；临时 key 全部清理
- 最终回归：npm test 982/982 全绿

---

## 六、对抗性自查第三轮（2026-09-13 下午晚些，三代理 + 主审）

三代理（P0 修复轮新代码 / 协议转换核心四模块 / 运行时取证）。发现并全部修复：

### P1
- **死循环熔断器对思考模型失效**（协议核心代理）：detectTrailingLoop 反向收集遇 reasoning/正文项即断——思考模型每轮真实形状 [reasoning, 正文, 调用, 输出] 让检测永远落空（DeepSeek-v4/GLM/Qwen thinking 全裸奔）；测试辅助函数构造的输入不含 reasoning 是「测试全绿生产裸奔」的典型。修复：reasoning/message 项按轮次分隔符跳过；chat 形态对称修复（纯文本 assistant 不中断）；补 3 个真实形状测试。
- **watchdog 维护标记生命周期缺口**（P0 修复代理）：stop 的 Git Bash 主路径停止成功即删标记（约 2 分钟后被 watchdog 拉起，stop 被静默撤销）；标记无 TTL + start 不清理 + restart 异常残留 → watchdog 可永久静默。修复：stop 各路径统一保留标记；路由进程启动成功即清标记（覆盖所有启动路径的权威解除点）；watchdog 对 >15 分钟超龄标记按残留清除。

### P2
- **工具调用帧 id/index 撕裂**（协议核心）：首帧只有 id、后续帧补 index 时同一调用拆成两个（参数截断 + 幽灵 tool 调用）。修复：双向唯一性归并（候选唯一才并，并行调用宁分裂不误并），实测单调用归并/参数完整。
- **done-only message 正文丢失**（协议核心）：第三方 Responses 兼容层只发 added+done 不发 delta → chat 客户端 200 + 空正文。修复：按 messageTextEmitted 差额补发（与 reasoning 摘要补发对称），混发不重复。
- **转换链路缺 8MB 字节守卫**（协议核心）：图片固定按 2048 token 计，MB 级 data URL 绕过预算直达上游报模糊 400（透传链路有守卫、转换链路没有）。修复：buildChatRequest 出口对称 413 + 指引。
- **TOML 全文空行折叠可破坏多行字符串**（P0 修复代理）：upsert/remove 的 \n{3,}→\n\n 作用于全文。修复：文件含 """/''' 时跳过折叠。
- **exec 桥无 id item 撕裂**（P0 修复代理）：改写条件收紧为带 id；event 行与 data.type 同步改写。

### P3（本轮顺手）
增量拒绝计数成功清零；oauth_fallback 日志降噪（只记首次）；/_admin/api/status 补 version 字段（设置页版本号不再依赖 GitHub）；SSE 流响应快照入请求查看器（responseChars 不再恒 0）；面板产物重建（panel-build consistent）。

### 运行时取证结论（修复前基线）
P0 修复生产实证：嗅探兜底 54 次全部成功、fallback_429 从 549→0、error-running 消失、usage 恢复真实值（output 22K/reasoning 988/cached 4M）；新实例 lag 最大 17ms；旧实例复现 29 分钟 4.3GB vs 新实例 45 分钟 624MB（观察项：持续流量下爬升未回落，待长时间观察）。
最终回归：npm test 988/988；路由已重启验证（status 带 version=1.10.8、维护标记闭环）。

## 二、有意保留（评估后不改，含理由）

1. **A4 只读端点 proxyUrl 掩码**：models 页编辑流从 /status 取 proxyUrl 原文回填编辑器，掩码后保存会把掩码串写回配置（数据损坏 P1 > 信息暴露 P2）；config 端点已有 $preserveSecret 令牌环。本地单用户威胁模型下保留现状，如需收紧应连前端「未改动即不回传」一起做。
2. **A8 管理面无自身鉴权**：本地单用户威胁模型（同机进程本可读 vault/db）下是明确取舍；keys/create 等破坏性端点已受 Origin/Host/Sec-Fetch-Site 三重校验（浏览器侧）+ 127.0.0.1 监听限制。
3. **A9 测试类端点响应形状不统一**：纯 API 语义治理，涉及多前端调用方，单独排期。
4. **vault 明文存储**：本地工具 + 0600 权限对齐后维持现状（机器绑定加密需单独设计迁移路径）。
5. **C13/C14（多次 stringify CPU 尖峰、8MB 硬编码）**：性能优化项，无正确性影响。
6. **S12 json-file-store rename 后目录 fsync**：Windows 无此问题（本机部署）；POSIX 崩溃耐久性缺口，revision 校验可挡住误用。
7. **C15 DeepSeek reasoning_content 首消息补齐**：需 provider 信号传入协议层，边角场景单独排期。
8. **C18 池 key 429 break**：有注释说明的单请求单 key 设计，口径保留。
