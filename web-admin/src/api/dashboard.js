import request from './request.js';

export function getDashboardStats(days = 30, config = {}) {
  return request({
    url: '/dashboard',
    method: 'get',
    params: { days },
    ...config,
  });
}

export function resetTokenUsage() {
  return request({
    url: '/token-usage/reset',
    method: 'post',
  });
}

/**
 * 通道熔断健康快照：每个通道的 closed/open/half-open 状态与连败计数。
 */
export function getTargetsHealth(config = {}) {
  return request({
    url: '/targets/health',
    method: 'get',
    ...config,
  });
}

/**
 * 重置通道熔断状态（单通道传 target，不传全清）。
 */
export function resetTargetsHealth(target) {
  return request({
    url: '/targets/health/reset',
    method: 'post',
    data: target ? { target } : {},
  });
}

/**
 * 最近请求统计环（内存环形数组，重启清零）：最终通道 / failover 次数 / 终态。
 */
export function getRecentRequests(limit = 100, config = {}) {
  return request({
    url: '/stats/recent',
    method: 'get',
    params: { limit },
    ...config,
  });
}
