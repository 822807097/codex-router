<template>
  <el-card shadow="never" class="chart-card">
    <template #header>
      <div class="flex items-center justify-between text-sm font-semibold text-primary flex-wrap gap-2">
        <span>实时运行状态 <span class="text-xs font-normal text-secondary ml-1">熔断健康 · 最近请求（重启清零）</span></span>
        <div class="flex items-center gap-2">
          <el-button size="small" text :loading="loading" @click="load">刷新</el-button>
          <el-button
            v-if="openChannels.length"
            size="small"
            type="warning"
            plain
            @click="handleResetAll"
          >
            复位熔断
          </el-button>
        </div>
      </div>
    </template>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- 通道熔断健康 -->
      <div>
        <div class="text-xs text-secondary mb-2">
          通道健康：
          <span :class="openChannels.length ? 'text-warning-text font-semibold' : 'text-success-text font-semibold'">
            {{ openChannels.length ? `${openChannels.length} 个熔断中` : '全部正常' }}
          </span>
          <span v-if="!health.enabled" class="ml-1">（熔断器未启用）</span>
        </div>
        <div v-if="observedChannels.length" class="flex flex-wrap gap-1.5">
          <el-tooltip
            v-for="ch in observedChannels"
            :key="ch.target"
            :content="tooltipFor(ch)"
            placement="top"
          >
            <span
              class="health-chip"
              :class="ch.state === 'open' ? 'health-chip-open' : ch.state === 'half-open' ? 'health-chip-half' : 'health-chip-closed'"
            >
              {{ ch.target }}
              <template v-if="ch.state === 'open'"> · {{ Math.ceil(ch.openRemainingMs / 1000) }}s</template>
              <template v-else-if="ch.state === 'half-open'"> · 探测中</template>
              <template v-else-if="ch.consecutiveFailures > 0"> · {{ ch.consecutiveFailures }} 连败</template>
            </span>
          </el-tooltip>
        </div>
        <div v-else class="text-xs text-secondary">暂无通道状态（发起一次请求后出现）</div>
      </div>

      <!-- 最近请求（终态） -->
      <div>
        <div class="text-xs text-secondary mb-2">
          最近请求：
          <span class="text-success-text font-semibold">{{ windowText(0) }}</span>
          <span class="mx-1">/</span>
          <span class="text-warning-text font-semibold">{{ windowText(1) }}</span>
          <span class="ml-1 text-secondary">（成功/总数 · 5分钟/1小时）</span>
        </div>
        <el-table v-if="recent.length" :data="recent" size="small" class="custom-table" max-height="220">
          <el-table-column label="时间" width="88">
            <template #default="{ row }">{{ formatTime(row.at) }}</template>
          </el-table-column>
          <el-table-column label="模型 → 通道" min-width="180">
            <template #default="{ row }">
              <span class="font-mono text-xs">{{ row.model }} → {{ row.target }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="72">
            <template #default="{ row }">
              <span :class="row.ok ? 'text-success-text' : 'text-danger-text'" class="font-mono font-semibold text-xs">
                {{ row.status || '—' }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="耗时" width="84">
            <template #default="{ row }">{{ formatDuration(row.durationMs) }}</template>
          </el-table-column>
          <el-table-column label="尝试" width="60">
            <template #default="{ row }">
              <el-tooltip v-if="row.attempts > 1" :content="`共 ${row.attempts} 次尝试（含 failover），末次错误：${row.error || '—'}`">
                <span class="text-warning-text font-mono text-xs">×{{ row.attempts }}</span>
              </el-tooltip>
              <span v-else class="text-secondary font-mono text-xs">1</span>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="text-xs text-secondary">暂无请求记录</div>
      </div>
    </div>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { getTargetsHealth, resetTargetsHealth, getRecentRequests } from '../api/dashboard.js';

const loading = ref(false);
const health = ref({ enabled: true, channels: [] });
const recent = ref([]);
const windows = ref([]);
let pollTimer = null;

// 只展示「有过状态」的通道：连败过 / 半开 / 熔断中。全绿 closed 无信息量，不占地方
const observedChannels = computed(() =>
  (health.value.channels || []).filter((ch) => ch.state !== 'closed' || ch.consecutiveFailures > 0));
const openChannels = computed(() => (health.value.channels || []).filter((ch) => ch.state === 'open'));

function tooltipFor(ch) {
  const stateText = { closed: '正常', open: '熔断中', 'half-open': '半开探测中' }[ch.state] || ch.state;
  const parts = [`${ch.target}：${stateText}`];
  if (ch.consecutiveFailures > 0) parts.push(`连败 ${ch.consecutiveFailures} 次`);
  if (ch.lastError) parts.push(`末次错误：${ch.lastError}`);
  if (ch.lastLatencyMs != null) parts.push(`末次延迟 ${ch.lastLatencyMs}ms`);
  return parts.join('，');
}

function windowText(idx) {
  const w = windows.value[idx];
  if (!w) return '0/0';
  return `${w.total - w.failed}/${w.total}`;
}

function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const v = Number(ms) || 0;
  if (v >= 60_000) return `${Math.floor(v / 60_000)}m${Math.round((v % 60_000) / 1000)}s`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${v}ms`;
}

async function load() {
  loading.value = true;
  try {
    // 面板装饰性数据：失败静默（skipGlobalError），不弹全局错误
    const [h, r] = await Promise.all([
      getTargetsHealth({ skipGlobalError: true }).catch(() => null),
      getRecentRequests(20, { skipGlobalError: true }).catch(() => null),
    ]);
    if (h) health.value = h;
    if (r) {
      recent.value = r.items || [];
      windows.value = r.windows || [];
    }
  } finally {
    loading.value = false;
  }
}

async function handleResetAll() {
  try {
    await resetTargetsHealth();
    ElMessage.success('已复位全部通道熔断状态');
    load();
  } catch { /* 错误提示由请求拦截器统一处理 */ }
}

onMounted(() => {
  load();
  // 30s 轮询：熔断秒级倒计时不需要实时刷新，低频足够
  pollTimer = setInterval(load, 30_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.health-chip {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
}
.health-chip-closed {
  color: var(--text-secondary);
}
.health-chip-half {
  color: var(--el-color-warning);
  border-color: var(--el-color-warning-light-5);
}
.health-chip-open {
  color: var(--el-color-danger);
  border-color: var(--el-color-danger-light-5);
  background: rgba(245, 108, 108, 0.06);
}
</style>
