<template>
  <!--
    响应式骨架（P1-2）：
    - ≥1280px：240px 完整侧栏
    - 768–1280px：自动折叠为 64px 图标栏
    - <768px：侧栏抽屉化（el-drawer）+ 顶栏汉堡按钮
  -->
  <div class="app-shell bg-canvas">
    <!-- 桌面/平板：常驻侧栏（含折叠态） -->
    <Sidebar
      v-if="!isMobile"
      :collapsed="isCompact"
      :version="update.version"
      :has-update="update.hasUpdate"
      :update-info="update.info"
      :panel-build="panelBuild"
      @check-update="updateDialogOpen = true"
    />

    <!-- 移动端：抽屉侧栏 -->
    <el-drawer
      v-else
      :model-value="drawerOpen"
      direction="ltr"
      :size="240"
      :with-header="false"
      :append-to-body="true"
      @update:model-value="drawerOpen = $event"
      @close="drawerOpen = false"
    >
      <Sidebar
        :collapsed="false"
        :version="update.version"
        :has-update="update.hasUpdate"
        :update-info="update.info"
        :panel-build="panelBuild"
        @navigate="drawerOpen = false"
        @check-update="handleOpenUpdate"
      />
    </el-drawer>

    <el-container direction="vertical" class="flex-1 min-w-0 h-full">
      <Topbar :is-mobile="isMobile" @open-drawer="drawerOpen = true" />
      <el-main class="main-area bg-canvas">
        <!-- 面板产物落后于源码：发版侧忘重新构建时显式提醒（小白话 + 可关闭） -->
        <el-alert
          v-if="panelBuild.consistent === false && !panelBuildDismissed"
          type="warning"
          :closable="true"
          show-icon
          class="panel-build-alert"
          @close="dismissPanelBuild"
        >
          <template #title>
            前端面板版本落后：当前面板构建于 {{ panelBuild.artifact?.builtAt?.slice(0, 10) || '未知时间' }}，之后面板源码有更新但未重新构建，界面可能缺少最新功能
          </template>
          {{ panelBuild.message || '请在服务所在机器的 web-admin 目录执行 npm install 和 npm run build 重新构建，或在管理页重新运行一键更新' }}
        </el-alert>
        <!-- 超宽屏限宽容器：内容居中，避免信息被拉散 -->
        <div class="content-wrap">
          <router-view v-slot="{ Component }">
            <transition name="page-fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </div>
      </el-main>
    </el-container>

    <!-- 全局更新弹窗：侧栏品牌区与设置页均可触发 -->
    <UpdateDialog
      v-model="update.dialogOpen"
      :info="update.info"
      :applying="update.applying"
      :done="update.done"
      @apply="handleApplyUpdate"
      @skip="skipThisSession"
      @reload="reloadPage"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import Sidebar from './Sidebar.vue';
import Topbar from './Topbar.vue';
import UpdateDialog from '../components/UpdateDialog.vue';
import { useBreakpoint } from '../composables/useBreakpoint.js';
import { checkForUpdate, applyUpdate, getPanelBuild } from '../api/system.js';

const { isMobile, isCompact } = useBreakpoint();
const drawerOpen = ref(false);

// ---- 版本与更新（左上角品牌区展示真实版本号；有新版本时显示 NEW 徽标） ----
const update = ref({ version: '', hasUpdate: false, info: null, dialogOpen: false, applying: false, done: false });

// ---- 面板构建指纹（web/ 产物 vs 面板源码）：不一致时顶部警告，true/null 均静默 ----
const panelBuild = ref({ supported: false, consistent: null, artifact: null, message: '' });
const panelBuildDismissed = ref(sessionStorage.getItem('panel-build-dismissed') === '1');

function dismissPanelBuild() {
  panelBuildDismissed.value = true;
  sessionStorage.setItem('panel-build-dismissed', '1');
}

async function refreshPanelBuild() {
  try {
    const res = await getPanelBuild({ skipGlobalError: true });
    panelBuild.value = res || panelBuild.value;
    if (res?.consistent !== false) sessionStorage.removeItem('panel-build-dismissed');
  } catch { /* 指纹校验是旁路能力，失败不打扰使用 */ }
}

async function refreshUpdateInfo() {
  try {
    const res = await checkForUpdate({ skipGlobalError: true });
    update.value = {
      version: res.current || '',
      hasUpdate: res.hasUpdate === true,
      info: res,
      dialogOpen: false,
      applying: false,
      done: false,
    };
    // 打开/刷新面板检测到新版本：自动弹窗询问是否更新
    // （用户点「暂不更新」后本次会话不再自动弹，侧栏仍保留 NEW 徽标）
    if (res.hasUpdate && !sessionStorage.getItem('update-skipped-' + res.latest)) {
      setTimeout(() => { update.value.dialogOpen = true; }, 600);
    }
  } catch { /* 网络不可用时保持静默，不打扰首次使用 */ }
}
refreshUpdateInfo();
refreshPanelBuild();
// 每 30 分钟自动复查一次新版本与面板新鲜度（有更新时侧栏品牌区显示 NEW 徽标）
setInterval(refreshUpdateInfo, 30 * 60 * 1000);
setInterval(refreshPanelBuild, 30 * 60 * 1000);

function skipThisSession() {
  // 本次会话不再自动弹（侧栏 NEW 徽标保留）；下次打开/刷新面板仍会提示
  const latest = (update.value.info && update.value.info.latest) || '';
  sessionStorage.setItem('update-skipped-' + latest, '1');
  update.value.dialogOpen = false;
}

async function handleApplyUpdate() {
  update.value.applying = true;
  try {
    const res = await applyUpdate();
    update.value.done = true;
    update.value.applying = false;
    setTimeout(() => window.location.reload(), 300);
    return res;
  } catch (err) {
    update.value.applying = false;
    throw err;
  }
}

function handleOpenUpdate() {
  update.value.dialogOpen = true;
}
</script>

<style scoped>
/* 100dvh：移动端浏览器地址栏收展时不产生底部白边；flex 布局让主区独立滚动 */
.app-shell {
  display: flex;
  width: 100vw;
  height: 100dvh;
  overflow: hidden;
}
.main-area {
  flex: 1;
  overflow-y: auto;
  padding: 2rem;
}
.content-wrap {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
}
/* 面板产物过期警告：与下方内容同宽，留出呼吸间距 */
.panel-build-alert {
  max-width: 1440px;
  margin: 0 auto 1rem;
}
@media (max-width: 767.98px) {
  .main-area {
    padding: 1rem;
  }
}
/* 页面切换：轻量淡入上移，避免生硬跳变 */
.page-fade-enter-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.page-fade-leave-active {
  transition: opacity 0.12s ease;
}
.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.page-fade-leave-to {
  opacity: 0;
}
</style>
