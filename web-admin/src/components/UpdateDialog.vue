<template>
  <!--
    版本更新弹窗（全局复用）：检查更新结果展示 + 一键更新（带阶段进度条）。
    用法：<UpdateDialog v-model="show" :info="updateInfo" :done="updateDone"
            :applying="updateApplying" @apply="emit('apply')" @close="emit('close')" />
  -->
  <el-dialog
    :model-value="modelValue"
    title="软件更新"
    width="520px"
    class="custom-dialog-pro"
    append-to-body
    :close-on-click-modal="!applying"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template v-if="done">
      <el-result icon="success" title="更新完成" sub-title="服务正在优雅重启，约 3 秒后刷新页面即可使用新版本">
        <template #extra>
          <el-button type="primary" @click="emit('reload')">刷新页面</el-button>
        </template>
      </el-result>
    </template>
    <template v-else>
      <div class="space-y-3">
        <div class="flex items-center justify-between text-sm">
          <span class="text-secondary">当前版本</span>
          <span class="font-mono">v{{ info?.current || '…' }}</span>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-secondary">最新版本</span>
          <span class="font-mono font-semibold">{{ info?.latest || '—' }}</span>
        </div>

        <!-- 更新中：阶段进度条（后端 /update/progress 轮询；网络中断时按时间兜底推进） -->
        <div v-if="applying" class="space-y-2 border-t border-muted pt-3">
          <div class="flex items-center justify-between text-xs">
            <span class="text-secondary">{{ progressMessage }}</span>
            <span class="font-mono font-semibold">{{ progressPercent }}%</span>
          </div>
          <el-progress
            :percentage="progressPercent"
            :status="progressFailed ? 'exception' : undefined"
            :show-text="false"
            :stroke-width="10"
          />
          <div v-if="progressFailed" class="text-xs text-warning-text">
            更新请求失败或网络中断——后台可能仍在进行。请稍候 1 分钟后刷新页面确认版本；未生效可再点一次「一键更新」重试。
          </div>
        </div>

        <el-alert
          v-if="info && !info.hasUpdate && !applying"
          type="success"
          :closable="false"
          title="已是最新版本"
        />
        <div v-if="info?.notes && !applying" class="text-xs text-secondary whitespace-pre-wrap border-t border-muted pt-2 max-h-56 overflow-auto">{{ info.notes }}</div>
      </div>
    </template>
    <template #footer>
      <el-button v-if="!applying" @click="emit('skip')">暂不更新</el-button>
      <el-button
        v-if="info?.hasUpdate && !done && !applying"
        type="primary"
        @click="emit('apply')"
      >一键更新</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import request from '../api/request.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // checkForUpdate 的返回体：{ current, latest, hasUpdate, notes, htmlUrl }
  info: { type: Object, default: null },
  applying: { type: Boolean, default: false },
  done: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'apply', 'skip', 'reload']);

// 进度轮询：applying 期间每 1.5s 拉一次 /update/progress
const progress = ref({ percent: 0, message: '', stage: 'idle', ok: null });
const progressFailed = ref(false);
let pollTimer = null;
let elapsedTimer = null;
let pollFails = 0;

const progressPercent = computed(() => progress.value.percent || 0);
const progressMessage = computed(() => progress.value.message || '正在准备更新…');

function startPolling() {
  stopPolling();
  progress.value = { percent: 2, message: '正在准备更新…', stage: 'start', ok: null };
  progressFailed.value = false;
  pollFails = 0;
  // 兜底时钟：即使轮询全失败（如请求端点 404），进度也按时间平滑推进到 90%，
  // 避免界面凝固在 0% 转圈（用户反馈的原始痛点）
  const startedAt = Date.now();
  elapsedTimer = setInterval(() => {
    if (progress.value.percent < 90) {
      const fake = 90 * (1 - Math.exp(-(Date.now() - startedAt) / 20000));
      progress.value.percent = Math.max(progress.value.percent, Math.round(2 + fake));
      if (!progress.value.message) progress.value.message = '正在拉取并应用更新（后台进行中）';
    }
  }, 1000);
  pollTimer = setInterval(async () => {
    try {
      const res = await request({ url: '/update/progress', method: 'get', skipGlobalError: true });
      pollFails = 0;
      if (res && typeof res.percent === 'number') {
        // 单调不回退
        progress.value = {
          ...res,
          percent: Math.max(progress.value.percent, res.percent),
        };
      }
      if (res?.stage === 'done') {
        stopPolling();
      }
    } catch {
      pollFails += 1;
      if (pollFails >= 4) {
        // 连续失败视为后端已重启或端点不可用：停止轮询走时间兜底到完成
        progressFailed.value = true;
        stopPolling();
      }
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

watch(() => props.applying, (applying) => {
  if (applying) startPolling();
  else stopPolling();
});

watch(() => props.done, (done) => {
  if (done) {
    progress.value = { ...progress.value, percent: 100, message: '更新完成' };
    stopPolling();
  }
});

onUnmounted(stopPolling);
</script>
