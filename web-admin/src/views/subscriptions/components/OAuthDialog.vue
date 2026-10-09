<template>
  <el-dialog
    :model-value="modelValue"
    @update:model-value="handleClose"
    :title="dialogTitle"
    :width="isMobile ? '94%' : '540px'"
    class="custom-dialog-pro"
    :close-on-click-modal="false"
    @closed="resetManualForm"
  >
    <!-- 顶部 2 模式切换 Tab -->
    <div class="flex justify-center mb-6">
      <el-radio-group v-model="activeMode" size="default" class="segmented-control">
        <el-radio-button v-if="!isProvider('copilot')" label="oauth">{{ isClaude ? '授权链接 + Code' : 'OAuth 一键授权' }}</el-radio-button>
        <el-radio-button v-if="supportDeviceAuth" label="device">设备码（远程/无回调）</el-radio-button>
        <el-radio-button label="token">手动 Token</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 模式 0: 设备码授权（headless / 远程服务器加号） -->
    <div v-if="activeMode === 'device'" class="space-y-5">
      <div class="flex flex-col items-center py-2 text-center">
        <div class="w-14 h-14 rounded-full bg-accent/10 text-info-text flex items-center justify-center text-2xl mb-3 border border-accent/20">
          📟
        </div>
        <div class="font-bold text-primary text-base mb-1">设备码授权（无需本机回调端口）</div>
        <div class="text-xs text-secondary max-w-sm leading-relaxed">
          用任意设备的浏览器打开下方验证链接，输入代码并批准即可
          <template v-if="isProvider('copilot')">（GitHub 账号登录后输入设备码）</template>
          <template v-else>（输入下方 8 位代码并批准）</template>。
          适合远程服务器 / SSH 部署 / 回调端口被占用的场景。
        </div>
      </div>

      <el-button
        type="primary"
        size="large"
        class="w-full h-11 text-sm font-semibold tracking-wide shadow-lg shadow-accent/20"
        :loading="authorizing"
        @click="handleStartDeviceAuth"
      >
        <el-icon v-if="!authorizing" class="mr-1.5"><Lightning /></el-icon>
        {{ authorizing && !deviceUserCode ? '正在申请设备码...' : (authorizing ? '等待批准...' : '获取设备码') }}
      </el-button>

      <div v-if="deviceUserCode" class="text-center space-y-3 border border-default rounded-xl py-4">
        <div class="text-2xs text-secondary">在验证页面输入此代码：</div>
        <div class="text-3xl font-bold font-mono text-primary tracking-[0.3em] select-all">{{ deviceUserCode }}</div>
        <div class="flex items-center justify-center gap-2">
          <el-button size="small" @click="copyUserCode">
            <el-icon class="mr-1"><CopyDocument /></el-icon>
            复制代码
          </el-button>
          <el-button size="small" type="primary" plain @click="openVerificationUrl">
            打开验证页面
          </el-button>
        </div>
        <div class="text-2xs text-secondary">批准后本弹窗自动完成绑定（{{ deviceExpiresText }}）</div>
      </div>
    </div>

    <!-- 模式 1: OAuth 授权向导 -->
    <div v-if="activeMode === 'oauth'" class="space-y-5">
      <!-- 推荐方式卡片 -->
      <div class="flex flex-col items-center py-2 text-center">
        <div class="w-14 h-14 rounded-full bg-accent/10 text-info-text flex items-center justify-center text-2xl mb-3 border border-accent/20">
          {{ isClaude ? '🔗' : '🌐' }}
        </div>
        <div class="font-bold text-primary text-base mb-1">{{ isClaude ? '半自动授权（官方要求）' : '推荐方式（全自动）' }}</div>
        <div class="text-xs text-secondary max-w-sm leading-relaxed">
          {{ isClaude
            ? 'Anthropic 不允许本地回调地址：点击开始生成授权链接，在浏览器完成授权后复制页面展示的一次性 Code 粘贴到下方。'
            : '点击开始后将自动打开默认浏览器完成 Google / ChatGPT 登录，授权结果自动回传绑定，无需手动操作。' }}
        </div>
      </div>

      <!-- 开始 OAuth 授权大按钮 -->
      <el-button
        type="primary"
        size="large"
        class="w-full h-11 text-sm font-semibold tracking-wide shadow-lg shadow-accent/20"
        :loading="authorizing"
        @click="handleStartOAuth"
      >
        <el-icon v-if="!authorizing" class="mr-1.5"><Lightning /></el-icon>
        {{ authorizing ? '正在等待授权...' : (isClaude ? '生成授权链接' : '开始 OAuth 授权') }}
      </el-button>

      <!-- 授权链接（手动打开兜底 / Claude 主路径） -->
      <div v-if="authUrlDisplay" class="text-left space-y-1.5 pt-1">
        <div class="text-xs text-secondary font-medium">授权链接{{ isClaude ? '（在浏览器打开并完成授权）' : '（浏览器没有自动打开时手动点击）' }}:</div>
        <div class="flex gap-2">
          <el-input
            v-model="authUrlDisplay"
            readonly
            size="default"
            class="font-mono text-xs"
          />
          <el-button size="default" @click="copyAuthUrl">
            <el-icon class="mr-1"><CopyDocument /></el-icon>
            复制
          </el-button>
          <el-button size="default" type="primary" plain @click="openAuthUrlInNewTab">
            打开
          </el-button>
        </div>
      </div>

      <!-- loopback 模式：等待回传状态提示 -->
      <div v-if="!isClaude && authorizing" class="text-center text-xs text-secondary">
        正在监听本地回调（端口 {{ loopbackPort || '…' }}），完成浏览器授权后本弹窗将自动关闭。
      </div>

      <!-- Claude 模式：粘贴一次性 Code -->
      <div v-if="isClaude && authUrlDisplay" class="border-t border-default pt-4 text-left space-y-2">
        <div class="text-2xs text-secondary">
          授权完成后浏览器会展示一串一次性 Authorization Code，粘贴到此处提交：
        </div>
        <div class="flex gap-2">
          <el-input
            v-model="manualCodeOrUrl"
            size="default"
            placeholder="粘贴 Code 或完整回调链接..."
            class="text-xs"
            @keyup.enter="submitManualCode"
          />
          <el-button type="primary" size="default" :loading="exchanging" @click="submitManualCode">
            <el-icon class="mr-1"><Link /></el-icon>
            提交绑定
          </el-button>
        </div>
      </div>

      <!-- loopback 模式兜底：粘贴回调链接/Code -->
      <div v-if="!isClaude && authUrlDisplay" class="border-t border-default pt-4 text-left space-y-2">
        <div class="text-2xs text-secondary">
          {{ isProvider('openai') || isProvider('chatgpt-web')
            ? '若浏览器显示「无法访问 localhost:1455」属正常（回调端口被占用时会降级手动）：请复制浏览器地址栏的完整回调链接粘贴到下方提交。'
            : '浏览器授权后长时间无响应？可粘贴回调地址栏的完整链接或 Code 手动完成：' }}
        </div>
        <div class="flex gap-2">
          <el-input
            v-model="manualCodeOrUrl"
            size="default"
            placeholder="粘贴回调链接或 Code..."
            class="text-xs"
            @keyup.enter="submitManualCode"
          />
          <el-button type="info" size="default" :loading="exchanging" @click="submitManualCode">
            <el-icon class="mr-1"><Link /></el-icon>
            提交
          </el-button>
        </div>
      </div>
    </div>

    <!-- 模式 2: 手动输入 Token / Key 模式 -->
    <div v-if="activeMode === 'token'" class="space-y-4 text-left">
      <el-form :model="form" label-position="top">
        <el-form-item label="账号别名 (Alias)">
          <el-input v-model="form.alias" placeholder="例如: 我的主力账号" />
        </el-form-item>
        <el-form-item label="关联邮箱 (可选)">
          <el-input v-model="form.email" placeholder="user@example.com" />
        </el-form-item>
        <el-form-item :label="credentialLabel">
          <el-input
            v-model="form.token"
            type="password"
            show-password
            :rows="3"
            :placeholder="credentialPlaceholder"
          />
        </el-form-item>
        <el-form-item label="网络代理（可选）">
          <ProxyConfigEditor v-model="form.proxy" :allow-global="false" class="w-full" />
          <div class="text-xs text-secondary mt-1">国内网络访问 Google / ChatGPT 通常需要代理；直连能连通就不填</div>
        </el-form-item>
      </el-form>
      <el-button type="primary" class="w-full" :loading="importing" @click="submitManualAccount">
        确认绑定
      </el-button>
    </div>

    <template #footer>
      <el-button @click="handleClose(false)">取消</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { startOAuth, pollOAuthStatus, exchangeOAuthCode, addAccount, startDeviceAuth, cancelDeviceAuth } from '../../../api/accounts.js';
import { ElMessage } from 'element-plus';
import { useBreakpoint } from '../../../composables/useBreakpoint.js';
import ProxyConfigEditor from '../../../components/ProxyConfigEditor.vue';

const { isMobile } = useBreakpoint();

const props = defineProps({
  modelValue: Boolean,
  provider: { type: String, default: 'google' },
});

const emit = defineEmits(['update:modelValue', 'success']);

const activeMode = ref('oauth');
// copilot 没有本机回环 OAuth 流（GitHub device flow 是唯一加号路径）：默认落在设备码 Tab，
// 且不展示「OAuth 一键授权」选项
const defaultModeFor = (provider) => (provider === 'copilot' ? 'device' : 'oauth');
watch(() => props.provider, (p) => { activeMode.value = defaultModeFor(p); }, { immediate: true });
const authorizing = ref(false);
const exchanging = ref(false);
// 手动 Token 导入防重复提交
const importing = ref(false);
const authUrlDisplay = ref('');
const sessionState = ref('');
const loopbackPort = ref(null);
const manualCodeOrUrl = ref('');
let pollTimer = null;
let pollTimeoutTimer = null;
// OAuth 等待上限与后端会话 TTL（10 分钟）对齐 +15s 余量：
// 预算短于 TTL 时，用户在浏览器登录/授权耗时超过预算就没人接收完成信号，
// 后端绑定成功也无人知晓（2026-10-05 实测事故）；最后读到的 idle 终态给出明确提示
const OAUTH_POLL_TIMEOUT_MS = 10 * 60 * 1000 + 15_000;

const form = ref({
  alias: '',
  email: '',
  token: '',
  proxy: { mode: 'direct', url: '' },
});

// 手动 Token 表单重置为初始值（提交成功 / 弹窗关闭时）
function resetManualForm() {
  form.value = {
    alias: '',
    email: '',
    token: '',
    proxy: { mode: 'direct', url: '' },
  };
}

const isClaude = computed(() => props.provider === 'claude');
const isProvider = (name) => props.provider === name;
// 设备码授权：OpenAI 令牌体系（openai 订阅 / chatgpt-web 网页会话）+ GitHub RFC 8628（copilot）
const supportDeviceAuth = computed(() => isProvider('openai') || isProvider('chatgpt-web') || isProvider('copilot'));

const dialogTitle = computed(() => {
  const titles = {
    google: '添加 Google 账号 (一键授权)',
    claude: '添加 Claude 账号 (OAuth 授权)',
    openai: '添加 ChatGPT 账号 (一键授权)',
    'chatgpt-web': '添加 ChatGPT 网页会话账号 (一键授权)',
    copilot: '添加 GitHub Copilot 账号 (设备码授权)',
  };
  return titles[props.provider] || '添加新账号';
});

const credentialLabel = computed(() => {
  if (props.provider === 'claude') return 'OAuth Refresh Token';
  if (props.provider === 'openai' || props.provider === 'chatgpt-web') return 'OAuth Refresh Token';
  if (props.provider === 'copilot') return 'GitHub Token';
  return 'Refresh Token';
});

const credentialPlaceholder = computed(() => {
  if (props.provider === 'copilot') {
    return '粘贴 GitHub token（本机 gh auth token 输出，或 classic PAT；推荐走「设备码」Tab 免手动获取）...';
  }
  return '粘贴 OAuth Refresh Token（授权模式下会自动获取，此处用于手动导入）...';
});

function resetFlowState() {
  stopPolling();
  authorizing.value = false;
  authUrlDisplay.value = '';
  sessionState.value = '';
  loopbackPort.value = null;
  manualCodeOrUrl.value = '';
  deviceUserCode.value = '';
  deviceVerificationUrl.value = '';
  deviceExpiresAt.value = 0;
}

// ---------- 设备码授权 ----------
const deviceUserCode = ref('');
const deviceVerificationUrl = ref('');
const deviceExpiresAt = ref(0);

const deviceExpiresText = computed(() => {
  if (!deviceExpiresAt.value) return '15 分钟内';
  const remainMin = Math.max(0, Math.round((deviceExpiresAt.value - Date.now()) / 60_000));
  return `剩 ${remainMin} 分钟`;
});

async function handleStartDeviceAuth() {
  if (authorizing.value) return;
  authorizing.value = true;
  try {
    const res = await startDeviceAuth(props.provider);
    deviceUserCode.value = res.userCode || '';
    deviceVerificationUrl.value = res.verificationUrl || '';
    deviceExpiresAt.value = Number(res.expiresAt) || 0;
    // 后端已开始后台轮询：前端复用同一 status 端点等待 complete
    startPolling();
  } catch {
    authorizing.value = false;
  }
}

function copyUserCode() {
  if (!deviceUserCode.value) return;
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = deviceUserCode.value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ElMessage.success('设备码已复制（降级方式）');
    } catch {
      ElMessage.warning('复制失败，请手动选择复制');
    }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(deviceUserCode.value).then(
      () => ElMessage.success('设备码已复制！'),
      () => fallback(),
    );
  } else {
    fallback();
  }
}

function openVerificationUrl() {
  if (deviceVerificationUrl.value) window.open(deviceVerificationUrl.value, '_blank');
}

function handleClose(visible) {
  if (!visible) {
    // 设备码会话还没批完就关弹窗：通知后端取消，停掉后台轮询
    if (activeMode.value === 'device' && authorizing.value && deviceUserCode.value) {
      cancelDeviceAuth(props.provider).catch(() => { /* 取消失败静默，后端 15 分钟自过期 */ });
    }
    resetFlowState();
  }
  emit('update:modelValue', visible);
}

async function handleStartOAuth() {
  if (authorizing.value) return;
  authorizing.value = true;
  try {
    const res = await startOAuth(props.provider);
    authUrlDisplay.value = res.authUrl || '';
    sessionState.value = res.state || '';
    if (res.redirectUri) {
      const portMatch = String(res.redirectUri).match(/:(\d+)/);
      loopbackPort.value = portMatch ? portMatch[1] : null;
    }
    if (res.mode === 'manual') {
      // Claude：链接 + 手动粘贴 Code，无需轮询
      authorizing.value = false;
      return;
    }
    // loopback 模式：后端已拉起浏览器，轮询状态直到 complete/error
    startPolling();
  } catch (err) {
    authorizing.value = false;
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (pollTimeoutTimer) {
    clearTimeout(pollTimeoutTimer);
    pollTimeoutTimer = null;
  }
}

function startPolling() {
  stopPolling();
  // 设备码授权的等待上限跟随后端会话过期时间（15 分钟），而非 OAuth 的 5 分钟——
  // 否则用户在第 6~15 分钟批准时前端已停止轮询，看不到绑定成功提示
  const pollBudget = deviceExpiresAt.value > Date.now()
    ? (deviceExpiresAt.value - Date.now()) + 60_000
    : OAUTH_POLL_TIMEOUT_MS;
  pollTimeoutTimer = setTimeout(() => {
    stopPolling();
    authorizing.value = false;
    ElMessage.warning('授权等待超时，请重试或检查网络');
  }, pollBudget);
  pollTimer = setInterval(async () => {
    try {
      const res = await pollOAuthStatus(props.provider);
      if (res.complete && res.account) {
        finishSuccess(res.account);
      } else if (res.error) {
        stopPolling();
        authorizing.value = false;
        ElMessage.error(res.error.message || '授权失败，请重试');
      } else if (!res.complete && res.status === 'idle') {
        // 发起过授权却读到「无会话」：后端会话已被 TTL 回收/重置/服务重启，
        // 浏览器侧再完成授权也不会有回调服务器接收——明确终止而非静默空转
        stopPolling();
        authorizing.value = false;
        ElMessage.warning('授权会话已失效（超时或服务重启），请重新发起授权');
      }
    } catch {
      /* 404 会话不存在等场景静默重试 */
    }
  }, 1200);
}

function finishSuccess(account) {
  stopPolling();
  authorizing.value = false;
  const label = account?.email ? `${account.email}` : '账号';
  const plan = account?.planType ? ` · ${account.planType}` : '';
  ElMessage.success(`🎉 授权绑定成功：${label}${plan}`);
  emit('update:modelValue', false);
  resetFlowState();
  emit('success');
}

async function submitManualCode() {
  if (!manualCodeOrUrl.value) {
    ElMessage.warning(isClaude.value ? '请粘贴授权后浏览器展示的 Code' : '请粘贴回调链接或 Authorization Code');
    return;
  }
  exchanging.value = true;
  try {
    const res = await exchangeOAuthCode(props.provider, manualCodeOrUrl.value, sessionState.value || undefined);
    if (res.complete && res.account) {
      finishSuccess(res.account);
    } else {
      ElMessage.error(res.error?.message || '提交失败，请重试');
    }
  } catch {
    /* 错误提示由请求拦截器统一处理 */
  } finally {
    exchanging.value = false;
  }
}

async function submitManualAccount() {
  if (importing.value) return;
  if (!form.value.token) {
    ElMessage.warning('请输入凭据');
    return;
  }
  importing.value = true;
  try {
    // copilot 手动导入的是 GitHub token（gh auth token / classic PAT），凭据形态不同：
    // 长期凭据只有 githubToken，Copilot 短效 JWT 由后端 refresher 首次使用时自动铸造。
    const credentials = props.provider === 'copilot'
      ? { githubToken: form.value.token }
      : {
        refreshToken: form.value.token,
        accessToken: '',
      };
    await addAccount({
      provider: props.provider,
      alias: form.value.alias || `${props.provider} 手动导入`,
      email: form.value.email || '',
      credentials,
      proxy: {
        enabled: form.value.proxy.mode === 'custom' && Boolean(form.value.proxy.url?.trim()),
        url: form.value.proxy.url?.trim() || '',
      },
    });
    ElMessage.success('账号已绑定！');
    resetManualForm();
    emit('update:modelValue', false);
    emit('success');
  } catch { /* 错误提示由请求拦截器统一处理 */ } finally {
    importing.value = false;
  }
}

function copyAuthUrl() {
  if (!authUrlDisplay.value) return;
  const fallback = () => {
    // 非安全上下文（http 非 localhost）clipboard API 不可用 → 降级 execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = authUrlDisplay.value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ElMessage.success('授权链接已复制到剪贴板（降级方式）');
    } catch {
      ElMessage.warning('复制失败，请手动全选复制');
    }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(authUrlDisplay.value).then(
      () => ElMessage.success('授权链接已复制到剪贴板！'),
      () => fallback(),
    );
  } else {
    fallback();
  }
}

function openAuthUrlInNewTab() {
  if (!authUrlDisplay.value) return;
  window.open(authUrlDisplay.value, '_blank');
}

onUnmounted(() => {
  stopPolling();
});
</script>

<style scoped>
/* 选中态配色由 main.css 的 --el-radio-button-checked-* 变量接管，无需 !important */
:deep(.segmented-control .el-radio-button__inner) {
  background-color: var(--bg-surface-2);
  border-color: var(--border-default);
  color: var(--text-secondary);
}
</style>
