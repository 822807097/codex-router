// ---------- 面板自更新（对齐 Antigravity Tools 的检查更新/一键更新体验） ----------
// 运行目录即开源仓库工作副本（git remote 已配置）。更新 = git fetch + reset 到
// 目标版本 + 恢复运行配置（config.json 承载 targets/账号/密钥引用，reset 前备份）。
// 零依赖优势：web/ 产物已入库，更新后无需 npm install，重启路由即生效。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { rawHttpsRequest } from './transport.mjs';

const GITHUB_REPO = '822807097/codex-router';
const RUNTIME_FILES_TO_PRESERVE = ['config.json'];

function runGit(runDir, args, timeoutMs = 120_000, onProgress = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: runDir, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message).slice(0, 400);
          reject(new Error(`git ${args[0]} 失败：${detail}`));
          return;
        }
        resolve(String(stdout || ''));
      },
    );
    // fetch 的输出走 stderr（进度行）：远程对象计数（xx%）正则提取
    if (onProgress && child.stderr) {
      let lastReported = 0;
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        const match = /(\d+)%\s*\((\d+)\/(\d+)\)/.exec(text);
        if (match) {
          const pct = Number(match[1]);
          if (pct > lastReported) {
            lastReported = pct;
            onProgress(pct / 100);
          }
        }
      });
    }
  });
}

async function fetchGithubJson(path, proxy, fetcher) {
  const outcome = await fetcher({
    protocol: 'https',
    host: 'api.github.com',
    path,
    method: 'GET',
    viaProxy: Boolean(proxy),
    proxy,
    headers: {
      'user-agent': 'codex-router-self-update',
      accept: 'application/vnd.github+json',
    },
    timeouts: { connectMs: 10_000, responseHeaderMs: 20_000, requestMs: 25_000 },
    maxResponseBytes: 4 * 1024 * 1024,
  });
  if (outcome.status < 200 || outcome.status >= 300) {
    throw new Error(`GitHub API 返回 ${outcome.status}（检查网络/全局代理可达性）`);
  }
  return JSON.parse(outcome.bodyText || '{}');
}

export function createSelfUpdate({ runDir, proxy, log = () => {} }) {
  function currentVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(runDir, 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  async function checkLatest() {
    const release = await fetchGithubJson(
      `/repos/${GITHUB_REPO}/releases/latest`,
      proxy,
      rawHttpsRequest,
    );
    const latest = String(release.tag_name || '').trim();
    const current = currentVersion();
    const normalize = (v) => String(v || '').replace(/^v/i, '').trim();
    const hasUpdate = Boolean(latest) && normalize(latest) !== normalize(current);
    return {
      current,
      latest,
      hasUpdate,
      name: release.name || latest,
      notes: String(release.body || '').slice(0, 4000),
      publishedAt: release.published_at || '',
      htmlUrl: release.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/${latest}`,
    };
  }

  /** 更新到 origin/master 最新代码；保留运行配置文件。返回 { updated, headInfo } */
  // 阶段权重：fetch 远端占比最大（网络），reset/恢复配置秒级。
  // 进度快照存在内存快照位，供面板轮询渲染百分比与阶段文案（用户反馈：一键更新转圈无进度体验差）。
  let lastProgress = { stage: 'idle', percent: 0, message: '', startedAt: 0, finishedAt: 0, ok: null };
  const STAGES = [
    { key: 'fetch', weight: 80, label: '从 GitHub 拉取最新代码（网络耗时主要在此）' },
    { key: 'apply', weight: 10, label: '应用更新并保留本地配置' },
    { key: 'restore', weight: 5, label: '恢复运行配置' },
    { key: 'done', weight: 5, label: '完成，准备重启服务' },
  ];

  function setStage(stageKey, percent) {
    const stage = STAGES.find((s) => s.key === stageKey);
    lastProgress = {
      ...lastProgress,
      stage: stageKey,
      percent: Math.max(0, Math.min(100, Math.round(percent ?? stage?.weight ?? 0))),
      message: stage?.label || stageKey,
    };
    try { log({ event: 'self_update.progress', ...lastProgress }); } catch { /* 日志旁路 */ }
  }

  function progressSnapshot() {
    return { ...lastProgress };
  }

  async function applyUpdateFromGit() {
    lastProgress = { stage: 'fetch', percent: 2, message: STAGES[0].label, startedAt: Date.now(), finishedAt: 0, ok: null };
    const local = 'origin/master';
    await runGit(runDir, ['fetch', 'origin', 'master'], 180_000, (frac) => {
      // fetch 阶段 2% → 82%（git 无细粒度回调，按起止时间平滑推进）
      const started = lastProgress.startedAt;
      const elapsed = Date.now() - started;
      // 指数逼近 80%，卡住也在推进不至于归零
      const fake = 80 * (1 - Math.exp(-elapsed / 15000));
      setStage('fetch', 2 + Math.min(frac * 80 || fake, 78));
    });
    setStage('apply', 82);
    const headAfterFetch = (await runGit(runDir, ['rev-parse', '--short', local])).trim();
    // 备份运行配置（reset --hard 会把跟踪文件重置为仓库版本）
    const backups = new Map();
    for (const name of RUNTIME_FILES_TO_PRESERVE) {
      const full = path.join(runDir, name);
      try {
        if (fs.statSync(full).isFile()) backups.set(name, fs.readFileSync(full));
      } catch { /* 文件不存在则无需备份 */ }
    }
    setStage('restore', 90);
    await runGit(runDir, ['reset', '--hard', local]);
    for (const [name, content] of backups) {
      fs.writeFileSync(path.join(runDir, name), content);
    }
    setStage('done', 100);
    lastProgress.finishedAt = Date.now();
    lastProgress.ok = true;
    log({ event: 'self_update.applied', head: headAfterFetch });
    return { updated: true, head: headAfterFetch };
  }

  function applyFailed(error) {
    lastProgress = {
      ...lastProgress,
      stage: 'failed',
      percent: lastProgress.percent,
      message: String(error?.message || error).slice(0, 200),
      finishedAt: Date.now(),
      ok: false,
    };
  }

  return { currentVersion, checkLatest, applyUpdateFromGit, progressSnapshot, applyFailed, runGit };
}
