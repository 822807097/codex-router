import request from './request.js';

/**
 * 网页池「原生工具模式」相关接口（订阅页原生工具模式卡片专用）。
 * 全部为管理端只读/开关操作；凭据只在环境变量里，接口从不回传密钥值。
 */

/** 原生模式总览：全局开关 / 本机服务(门面)监听 / 云端隧道 / 工具目录来源 */
export function getWebpoolNativeStatus() {
  return request({
    url: '/webpool/native-status',
    method: 'get',
  });
}

/** 原生模式指标（按日聚合）：原生会话数 / 回落次数 / 裁决完成数 / 门面调用等 */
export function getWebpoolMetrics() {
  return request({
    url: '/webpool/metrics',
    method: 'get',
  });
}

/**
 * 原生模式自探：路由进程内直通本机服务的 JSON-RPC 链路体检，
 * 不发任何外部网络请求；返回 { ok, toolCount?, error?, port? ... }。
 */
export function webpoolNativeSelftest() {
  return request({
    url: '/webpool/native-selftest',
    method: 'post',
    timeout: 30_000,
  });
}

/**
 * 逐账号「原生工具」开关。account=账号 ID，enabled=true 开 / false 关。
 * 需先在 ChatGPT 网页端给该账号绑定连接器，否则对话会自动回落普通模式。
 */
export function setAccountNativeTools(account, enabled) {
  return request({
    url: '/webpool/accounts/native-tools',
    method: 'post',
    data: { account, enabled },
  });
}
