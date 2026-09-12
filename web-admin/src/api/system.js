import request from './request.js';

export function restartRouterService() {
  return request({
    url: '/service/restart',
    method: 'post',
  });
}

export function getSystemConfig(config = {}) {
  return request({
    url: '/config',
    method: 'get',
    ...config,
  });
}

export function getRouterStatus(config = {}) {
  return request({
    url: '/status',
    method: 'get',
    ...config,
  });
}

export function saveSystemConfig(data) {
  return request({
    url: '/config',
    method: 'put',
    data,
    timeout: 30_000,
  });
}

export function testVisionRelay(data) {
  return request({
    url: '/vision-relay/test',
    method: 'post',
    data,
    // 免费共享端点（如 NVIDIA Trial）响应可到数十秒，放宽到 2.5 分钟
    timeout: 160_000,
  });
}

// ---------- Cursor 订阅网关（内置面板管理：状态/账号池/增删 crsr_ key） ----------

export function getCursorGatewayStatus(config = {}) {
  return request({
    url: '/cursor-gateway/status',
    method: 'get',
    ...config,
  });
}

export function restartCursorGateway() {
  return request({
    url: '/cursor-gateway/restart',
    method: 'post',
    timeout: 30_000,
  });
}

// 启动网关（未运行时使用；与重启同一拉起逻辑，不动账号池）
export function startCursorGateway() {
  return request({
    url: '/cursor-gateway/start',
    method: 'post',
    timeout: 30_000,
  });
}

// 停止网关（不使用时释放硬件资源；账号池与凭据保留）
export function stopCursorGateway() {
  return request({
    url: '/cursor-gateway/stop',
    method: 'post',
    timeout: 30_000,
  });
}

// 网关可服务的模型清单（读取路由目录的 cursor-* 模型，不依赖网关在线）
export function listCursorGatewayModels(config = {}) {
  return request({
    url: '/cursor-gateway/models',
    method: 'get',
    ...config,
  });
}

// ---------- 模型上下文默认值（全局压缩阈值） ----------

export function getModelContextDefaults(config = {}) {
  return request({
    url: '/model-context/defaults',
    method: 'get',
    ...config,
  });
}

export function saveModelContextDefaults(data, config = {}) {
  return request({
    url: '/model-context/defaults',
    method: 'post',
    data,
    ...config,
  });
}

export function restartCodexDesktopApp() {
  return request({
    url: '/codex-desktop/restart-app',
    method: 'post',
    // Windows 下 taskkill 排空 + 等待进程消失实测可达 10s+，默认 15s 太贴边
    timeout: 60_000,
  });
}

export function syncCodexSessionProviders() {
  return request({
    url: '/codex-desktop/sync-session-providers',
    method: 'post',
    // 会话迁移要扫全部 rollout（4000+ 线程实测 ~30s）
    timeout: 180_000,
  });
}

export function listCursorGatewayAccounts(config = {}) {
  return request({
    url: '/cursor-gateway/accounts',
    method: 'get',
    ...config,
  });
}

export function addCursorGatewayAccount(data) {
  return request({
    url: '/cursor-gateway/accounts/add',
    method: 'post',
    data,
    // 新增账号要真实验证 crsr_ key + 拉取模型清单，放宽超时
    timeout: 40_000,
  });
}

export function removeCursorGatewayAccount(id) {
  return request({
    url: '/cursor-gateway/accounts/remove',
    method: 'post',
    data: { id },
  });
}

// ---------- Codex 桌面端接入管理（一键官方直连 / 一键接入路由 + 模型动态加载） ----------

export function getCodexDesktopState(config = {}) {
  return request({
    url: '/codex-desktop/state',
    method: 'get',
    ...config,
  });
}

export function restoreCodexDesktopOfficial(data) {
  return request({
    url: '/codex-desktop/restore-official',
    method: 'post',
    data,
    // 恢复流程含桌面端会话迁移（实测 4000+ 线程 ~30s），默认 15s 超时会让
    // 前端报错而服务端仍在写配置——「恢复官方直连按钮失效」的根因（与
    // apply-router 同病根，2026-09-12）。
    timeout: 180_000,
  });
}

export function applyCodexDesktopRouter(data) {
  return request({
    url: '/codex-desktop/apply-router',
    method: 'post',
    data,
    // 接入要拉取全部绑定账号（ChatGPT/Claude/谷歌）的上游模型清单，谷歌接口
    // 常规耗时 ~1 分钟。默认 15s 全局超时会让前端中途放弃、永远走不到自动
    // 重启（服务端无断开监听仍会写完配置）——「应用完没重启」的根因。
    timeout: 180_000,
  });
}

/** 检查开源仓库新版本（GitHub Releases 对比本地版本） */
export function checkForUpdate(config = {}) {
  return request({
    url: '/update/check',
    method: 'get',
    ...config,
  });
}

/** 一键更新：git 同步到最新代码（保留运行配置）并优雅重启 */
export function applyUpdate(data) {
  return request({
    url: '/update/apply',
    method: 'post',
    data,
    timeout: 120_000,
  });
}

/** 面板构建指纹：web/ 产物是否与当前面板源码一致（发版忘重新构建时面板警告） */
export function getPanelBuild(config = {}) {
  return request({
    url: '/panel-build',
    method: 'get',
    ...config,
  });
}
