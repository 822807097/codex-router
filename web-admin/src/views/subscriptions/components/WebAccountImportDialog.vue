<script setup>
// ChatGPT 网页会话账号导入弹窗（W3）：粘贴网页版 access_token（支持 JSON 行/纯 token 批量），
// 走通用 /_admin/api/accounts/add 端点（provider=chatgpt-web），凭据入 vault 重启可恢复。
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { addAccount } from '../../../api/accounts.js';

const props = defineProps({ modelValue: Boolean });
const emit = defineEmits(['update:modelValue', 'success']);

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const tokensText = ref('');
const alias = ref('');
const importing = ref(false);

// 解析粘贴内容：每行一个账号。支持三种行形态：
// 1) 纯 access_token（JWT 三段式，含 refresh_token 时也认）
// 2) JSON 对象（含 access_token / refreshToken 键，兼容 sub2api/chatgpt2api 导出格式）
// 3) 容错：tab/逗号分隔「备注 + token」
function parseLines(text) {
  const items = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* 非 JSON 行按纯 token 处理 */ }
    if (parsed && typeof parsed === 'object') {
      const accessToken = parsed.access_token || parsed.accessToken || '';
      if (accessToken) {
        items.push({
          accessToken: String(accessToken),
          refreshToken: parsed.refresh_token || parsed.refreshToken || '',
          email: parsed.email || '',
        });
      }
      continue;
    }
    const tokenPart = line.split(/[\t,|]/).map((s) => s.trim()).filter(Boolean).pop();
    if (tokenPart && tokenPart.length > 40) items.push({ accessToken: tokenPart, refreshToken: '', email: '' });
  }
  return items;
}

const preview = computed(() => parseLines(tokensText.value).length);

async function importTokens() {
  const items = parseLines(tokensText.value);
  if (!items.length) {
    ElMessage.warning('没有识别到可导入的 access_token（每行一个，或每行一条 JSON）');
    return;
  }
  importing.value = true;
  let ok = 0;
  const failed = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        await addAccount({
          provider: 'chatgpt-web',
          id: items.length > 1 ? '' : undefined,
          alias: alias.value.trim()
            ? `${alias.value.trim()}${items.length > 1 ? ` #${i + 1}` : ''}`
            : (item.email || `网页账号 ${i + 1}`),
          email: item.email || '',
          credentials: {
            accessToken: item.accessToken,
            ...(item.refreshToken ? { refreshToken: item.refreshToken } : {}),
          },
          metadata: { source: 'chatgpt_web_import' },
        });
        ok += 1;
      } catch (err) {
        failed.push(err.response?.data?.error?.message || err.message || '未知错误');
      }
    }
    if (ok > 0) ElMessage.success(`成功导入 ${ok} 个网页会话账号`);
    if (failed.length) ElMessage.error(`${failed.length} 个导入失败：${failed[0]}`);
    if (ok > 0) {
      tokensText.value = '';
      emit('success');
      visible.value = false;
    }
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="导入 ChatGPT 网页会话账号"
    width="520px"
    destroy-on-close
  >
    <el-alert type="warning" :closable="false" class="mb-3">
      网页额度转 API 属灰区用法，存在账号被上游限制的风险。请仅导入你自己的账号。
    </el-alert>
    <el-form label-width="80px">
      <el-form-item label="备注名">
        <el-input v-model="alias" placeholder="选填，如「主力号」；批量导入自动追加 #1 #2" />
      </el-form-item>
      <el-form-item label="Token">
        <el-input
          v-model="tokensText"
          type="textarea"
          :rows="6"
          placeholder="每行一个 access_token（网页版凭据）。也支持每行一段 JSON：{&quot;access_token&quot;: &quot;...&quot;, &quot;refresh_token&quot;: &quot;...&quot;}"
        />
      </el-form-item>
      <div class="text-xs text-secondary mb-3">
        已识别 {{ preview }} 个账号。刷新端点未配置时 token 过期后需重新导入（当前 access_token 有效期较长）。
      </div>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="importing" :disabled="!preview" @click="importTokens">
        导入 {{ preview > 0 ? `(${preview})` : '' }}
      </el-button>
    </template>
  </el-dialog>
</template>
