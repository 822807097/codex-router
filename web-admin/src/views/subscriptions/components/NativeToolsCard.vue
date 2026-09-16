<script setup>
// 原生工具模式卡片（治根改造 P5）：网页池原生 MCP 的面板总控。
// - 状态总览：全局开关 / 本机服务(门面) / 云端隧道 / 工具目录来源（native-status）
// - 指标摘要：近 7 天原生会话数 / 自动回落次数 / 裁决完成数（metrics，小白话）
// - 逐账号「原生工具」开关（确认弹窗说明需先在网页端绑定连接器）
// - 三步设置向导弹窗（连接器 → 隧道与密钥 → 重启自探）
// 面板只读凭据「变量名」，任何密钥值都不经过本组件。
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { listAccounts } from '../../../api/accounts.js';
import {
  getWebpoolNativeStatus,
  getWebpoolMetrics,
  webpoolNativeSelftest,
  setAccountNativeTools,
} from '../../../api/webpool.js';

const loading = ref(true);
const refreshing = ref(false);
const status = ref(null); // native-status 响应
const metrics = ref(null); // metrics 响应
const accounts = ref([]);

const webAccounts = computed(() => accounts.value.filter((a) => a.provider === 'chatgpt-web'));
const config = computed(() => status.value?.config || null);
const mcp = computed(() => status.value?.mcp || null);
const tunnel = computed(() => status.value?.tunnel || null);
const catalog = computed(() => status.value?.catalog || null);
const totals = computed(() => metrics.value?.totals || {});

// ---- 状态瓷贴：全局开关 / 本机服务 / 云端隧道 / 工具目录 ----
const statusTiles = computed(() => {
  // 隧道状态 → 小白话（与后端 webpool.tunnel_state 的状态机一一对应）
  const tunnelMap = {
    running: { text: '已连接', ok: true, hint: '本机服务已安全接入官方通道' },
    downloading: { text: '准备中（下载组件）', ok: null, hint: '首次运行需下载一次官方小程序，稍等片刻' },
    backoff: { text: '重连中', ok: null, hint: '连接断开，正在自动重试，无需操作' },
    off: { text: '未启用', ok: null, hint: '按下方「设置向导」完成后自动启用' },
    missing_credentials: { text: '缺少密钥', ok: false, hint: '按「设置向导」第 2 步配置两个环境变量后重启' },
    invalid_tunnel_id: { text: '隧道 ID 有误', ok: false, hint: '请核对环境变量里的隧道 ID 是否复制完整' },
    stopped: { text: '已停止', ok: false, hint: '隧道进程已停止，可尝试重启路由' },
    failed: { text: '启动失败', ok: false, hint: tunnel.value?.lastError || '启动出错，可重启路由再试' },
  };
  const t = tunnelMap[tunnel.value?.state] || { text: tunnel.value?.state || '未知', ok: null, hint: '' };
  return [
    {
      label: '全局开关',
      value: config.value?.enabled ? '已开启' : '未开启',
      ok: config.value?.enabled === true,
      hint: config.value?.enabled ? '原生工具模式总开关已打开' : '需在路由配置文件中开启（chatgptWeb.nativeTools.enabled=true）并重启',
    },
    {
      label: '本机服务',
      value: mcp.value?.listening ? `运行中（127.0.0.1:${mcp.value.port}）` : '未运行',
      ok: mcp.value?.listening === true,
      hint: '运行在您电脑上的工具服务入口，只对本机开放，外部无法访问',
    },
    { label: '云端隧道', value: t.text, ok: t.ok, hint: t.hint },
    {
      label: '工具目录',
      value: catalog.value?.active === 'runtime' ? `已加载 ${catalog.value.toolCount ?? 0} 个工具` : '内置清单',
      ok: catalog.value?.active === 'runtime',
      hint: catalog.value?.active === 'runtime' ? '目录为最新版本（本机实时同步）' : '使用程序内置的工具清单（兜底）',
    },
  ];
});

// ---- 指标摘要（近 7 天，小白话） ----
const metricCards = computed(() => [
  { label: '原生会话数', value: Number(totals.value.nativeRequests) || 0, hint: '直接使用本机工具回答的对话次数' },
  { label: '自动回落次数', value: Number(totals.value.nativeFallbacks) || 0, hint: '原生回答异常时自动退回普通模式的次数' },
  { label: '裁决完成数', value: Number(totals.value.verdictDone) || 0, hint: '检查通过、正常完成的回答次数' },
]);

// ---- 自探 ----
const selfTesting = ref(false);
const selfTestResult = ref(null);
async function handleSelfTest() {
  selfTesting.value = true;
  selfTestResult.value = null;
  try {
    const res = await webpoolNativeSelftest();
    selfTestResult.value = res || { ok: false, error: '无响应' };
    if (res?.ok) ElMessage.success(`自探通过：发现 ${res.toolCount ?? 0} 个工具`);
    else ElMessage.error(`自探未通过：${res?.error || '未知原因'}`);
  } catch (err) {
    selfTestResult.value = { ok: false, error: err.response?.data?.error?.message || err.message || '请求失败' };
  } finally {
    selfTesting.value = false;
  }
}

// ---- 逐账号「原生工具」开关（带确认弹窗） ----
const togglingId = ref('');
function isNativeOn(acc) {
  return acc?.metadata?.nativeTools === true;
}
async function handleToggle(acc, next) {
  const action = next ? '开启' : '关闭';
  try {
    await ElMessageBox.confirm(
      next
        ? '开启后，这个账号的对话会直接使用您电脑上的工具（打开网页、搜索资料等），回答更及时。注意：需先在 ChatGPT 网页端给该账号开启开发者模式并绑定连接器（见「设置向导」第 1 步），否则对话会自动退回普通模式。确定开启吗？'
        : '关闭后，这个账号恢复普通对话模式，不再使用您电脑上的工具。确定关闭吗？',
      `${action}原生工具`,
      { confirmButtonText: `确定${action}`, cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return; // 用户取消：开关不动
  }
  togglingId.value = acc.id;
  try {
    await setAccountNativeTools(acc.id, next);
    acc.metadata = { ...(acc.metadata || {}), nativeTools: next };
    ElMessage.success(`已${action}「${acc.alias}」的原生工具`);
  } catch (err) {
    ElMessage.error(err.response?.data?.error?.message || err.message || '设置失败');
  } finally {
    togglingId.value = '';
  }
}

// ---- 设置向导（三步教程） ----
const showWizard = ref(false);
const wizardStep = ref(0);
function openWizard() {
  wizardStep.value = 0;
  showWizard.value = true;
}
// 口令环境变量名跟随后端配置（默认 ROUTER_MCP_BEARER），只展示变量名不展示值
const bearerKeyName = computed(() => config.value?.bearerKey || 'ROUTER_MCP_BEARER');

async function loadAll({ silent = false } = {}) {
  if (silent) refreshing.value = true;
  try {
    const [statusRes, metricsRes, accountsRes] = await Promise.all([
      getWebpoolNativeStatus(),
      getWebpoolMetrics(),
      listAccounts({ skipGlobalError: true }),
    ]);
    status.value = statusRes || null;
    metrics.value = metricsRes || null;
    accounts.value = accountsRes?.accounts || [];
  } catch {
    // 状态展示非关键路径：失败静默，瓷贴保持「未知」态；用户可点刷新重试
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

onMounted(() => loadAll());
</script>

<template>
  <el-card shadow="never" class="platform-card w-full">
    <template #header>
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div class="min-w-0">
          <div class="font-semibold text-primary text-sm">原生工具模式</div>
          <div class="text-xs text-secondary mt-0.5 leading-relaxed">
            让网页会话账号直接使用您电脑上的工具（打开网页、搜索资料），回答更快更全。首次使用请先点「设置向导」，按三步教程配置
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <el-button size="small" :loading="selfTesting" @click="handleSelfTest">自探</el-button>
          <el-button size="small" :loading="refreshing" @click="loadAll({ silent: true })">刷新</el-button>
          <el-button type="primary" size="small" @click="openWizard">设置向导</el-button>
        </div>
      </div>
    </template>

    <div v-loading="loading" class="space-y-4">
      <!-- 自探结果横幅 -->
      <el-alert
        v-if="selfTestResult"
        :type="selfTestResult.ok ? 'success' : 'error'"
        :closable="true"
        show-icon
        :title="selfTestResult.ok
          ? `自探通过：本机服务正常，发现 ${selfTestResult.toolCount ?? 0} 个工具，可以开始使用了`
          : `自探未通过：${selfTestResult.error || '未知原因'}（可按「设置向导」逐步排查）`"
      />

      <!-- 状态瓷贴：全局开关 / 本机服务 / 云端隧道 / 工具目录 -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <div v-for="tile in statusTiles" :key="tile.label" class="native-tile">
          <div class="flex items-center justify-between">
            <span class="text-xs text-secondary">{{ tile.label }}</span>
            <span
              class="native-dot"
              :class="tile.ok === true ? 'native-dot-ok' : (tile.ok === false ? 'native-dot-bad' : 'native-dot-idle')"
            />
          </div>
          <div class="text-sm font-semibold text-primary mt-1">{{ tile.value }}</div>
          <div class="text-2xs text-secondary mt-1 leading-relaxed">{{ tile.hint }}</div>
        </div>
      </div>

      <!-- 指标摘要（近 7 天，小白话） -->
      <div>
        <div class="text-xs text-secondary mb-2">使用情况（近 7 天累计）</div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div v-for="m in metricCards" :key="m.label" class="native-tile">
            <div class="flex items-baseline gap-2">
              <span class="text-xl font-bold text-primary font-mono">{{ m.value }}</span>
              <span class="text-xs text-secondary">{{ m.label }}</span>
            </div>
            <div class="text-2xs text-secondary mt-1 leading-relaxed">{{ m.hint }}</div>
          </div>
        </div>
      </div>

      <!-- 逐账号「原生工具」开关 -->
      <div>
        <div class="text-xs text-secondary mb-2">
          账号开关（需先完成「设置向导」，并在 ChatGPT 网页端给账号绑定连接器后才会真正生效）
        </div>
        <div v-if="webAccounts.length > 0" class="space-y-2">
          <div
            v-for="acc in webAccounts"
            :key="acc.id"
            class="native-account-row"
          >
            <div class="min-w-0">
              <span class="text-sm font-medium text-primary break-all">{{ acc.alias }}</span>
              <span v-if="acc.email" class="text-xs text-secondary ml-2 break-all">({{ acc.email }})</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-xs" :class="isNativeOn(acc) ? 'text-success' : 'text-secondary'">
                {{ isNativeOn(acc) ? '已开启' : '未开启' }}
              </span>
              <el-switch
                :model-value="isNativeOn(acc)"
                :loading="togglingId === acc.id"
                @change="(v) => handleToggle(acc, v)"
              />
            </div>
          </div>
        </div>
        <div v-else class="empty-hint">
          还没有网页会话账号——先在上方「ChatGPT 网页会话通道」卡片添加账号，再回到这里开启
        </div>
      </div>
    </div>

    <!-- 三步设置向导弹窗 -->
    <el-dialog
      v-model="showWizard"
      title="原生工具模式 · 设置向导"
      width="640px"
      destroy-on-close
    >
      <div class="w-full">
        <el-steps :active="wizardStep" align-center finish-status="success" class="mb-5">
          <el-step title="绑定连接器" />
          <el-step title="隧道与密钥" />
          <el-step title="重启并验证" />
        </el-steps>

        <div v-show="wizardStep === 0" class="wizard-step-box">
          <div class="text-sm font-semibold text-primary mb-2">第 1 步：在 ChatGPT 网页端开启开发者模式并创建应用</div>
          <ol class="wizard-ol">
            <li>用浏览器打开 ChatGPT 网页版，登录想开启的账号。</li>
            <li>进入「设置 → 应用与连接器」，打开<strong>开发者模式</strong>。</li>
            <li>创建一个新应用（连接器），服务地址填写本机隧道地址——完成第 2 步并重启后，本页「云端隧道」显示「已连接」即代表地址就绪。</li>
          </ol>
        </div>

        <div v-show="wizardStep === 1" class="wizard-step-box">
          <div class="text-sm font-semibold text-primary mb-2">第 2 步：创建云端隧道并生成密钥，写入系统环境变量</div>
          <ol class="wizard-ol">
            <li>打开 platform.openai.com，进入 Tunnels 页面，创建一个 Tunnel。</li>
            <li>生成一个 Runtime Key：<strong>只勾选 Tunnels Read 和 Tunnels Use 两项权限</strong>，其他权限一律不要勾。</li>
            <li>按页面提示，把 <code class="wizard-code">CONTROL_PLANE_TUNNEL_ID</code> 和 <code class="wizard-code">CONTROL_PLANE_API_KEY</code> 写入系统环境变量（Windows：「系统属性 → 高级 → 环境变量」）。</li>
            <li>再新增一个环境变量 <code class="wizard-code">{{ bearerKeyName }}</code>，值自己随便定一串长随机字符（相当于本机服务的门锁口令）。</li>
          </ol>
        </div>

        <div v-show="wizardStep === 2" class="wizard-step-box">
          <div class="text-sm font-semibold text-primary mb-2">第 3 步：重启路由并自探验证</div>
          <ol class="wizard-ol">
            <li>完全重启路由程序（环境变量在重启后才会被读到）。</li>
            <li>回到本页，点右上角<strong>「自探」</strong>按钮：提示「自探通过」即设置完成。</li>
            <li>在下方逐账号打开<strong>「原生工具」</strong>开关，之后正常对话即可自动享受原生工具能力。</li>
          </ol>
        </div>
      </div>

      <template #footer>
        <div class="w-full flex items-center justify-between">
          <el-button v-if="wizardStep > 0" @click="wizardStep -= 1">上一步</el-button>
          <span v-else />
          <div class="flex items-center gap-2">
            <el-button @click="showWizard = false">关闭</el-button>
            <el-button v-if="wizardStep < 2" type="primary" @click="wizardStep += 1">下一步</el-button>
            <el-button v-else type="primary" @click="showWizard = false">完成</el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.platform-card :deep(.el-card__header) {
  padding: 1rem 1.25rem;
}
.platform-card :deep(.el-card__body) {
  padding: 1.25rem;
}
/* 状态/指标瓷贴：与账号条目同底色，轻边框 */
.native-tile {
  padding: 0.75rem 0.875rem;
  background-color: rgb(var(--bg-surface-2-rgb) / 0.55);
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  min-width: 0;
}
/* 状态小圆点：绿=正常，红=异常，灰=进行中/未启用 */
.native-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
  flex-shrink: 0;
}
.native-dot-ok { background-color: var(--el-color-success); }
.native-dot-bad { background-color: var(--el-color-danger); }
.native-dot-idle { background-color: var(--el-color-info); }
/* 逐账号开关行 */
.native-account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem;
  background-color: rgb(var(--bg-surface-2-rgb) / 0.55);
  border: 1px solid var(--border-muted);
  border-radius: 10px;
}
.native-account-row:hover {
  border-color: var(--border-strong);
}
/* 空状态：与父页面 empty-hint 同款（scoped 内复制，保持样式独立） */
.empty-hint {
  padding: 1.25rem;
  border: 1px dashed var(--border-default);
  border-radius: 10px;
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-secondary);
}
/* 向导步骤内容 */
.wizard-step-box {
  padding: 1rem;
  background-color: rgb(var(--bg-surface-2-rgb) / 0.55);
  border: 1px solid var(--border-muted);
  border-radius: 10px;
}
.wizard-ol {
  margin: 0;
  padding-left: 1.25rem;
  list-style: decimal;
  font-size: 0.8rem;
  color: var(--text-secondary);
  line-height: 1.9;
}
.wizard-ol strong {
  color: var(--text-primary);
}
.wizard-code {
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  background-color: rgb(var(--bg-surface-2-rgb));
  border: 1px solid var(--border-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  color: var(--text-primary);
}
</style>
