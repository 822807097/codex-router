#!/usr/bin/env node
// ---------- 发版守卫：面板产物是否落后于面板源码 ----------
// 用法：node scripts/check-panel-build.mjs（发版流程「web-admin build → commit」之后跑）
//
// 背景：web/ 面板构建产物随仓库分发（开源用户零依赖，自更新 = git reset，不本地编译）。
// 发版时改了 web-admin 源码但忘了 npm run build，用户拿到的就是「后端新、面板旧」，
// 且左上角版本号读 package.json 会显示新版本，完全无感知。本脚本用内容指纹拦住它：
// 退出码 0 = 产物与源码一致；1 = 落后（先在 web-admin 里 npm install && npm run build，
// 提交 web/ 后重跑本脚本）。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelBuildStatus } from '../lib/panel-build-info.mjs';

const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const status = panelBuildStatus({
  webRoot: path.join(runDir, 'web'),
  webAdminDir: path.join(runDir, 'web-admin'),
});

function git(args) {
  try {
    return execFileSync('git', args, { cwd: runDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (error) {
    // --error-unmatch 未命中会走这里；其余 git 故障按同样方式让调用方看到输出
    return error.stdout ? String(error.stdout) : null;
  }
}

if (status.supported === false) {
  console.error('[panel-build] 无法校验：web/ 或 web-admin/ 目录缺失（是否在仓库根目录运行？）');
  process.exit(1);
}
if (status.consistent === null) {
  console.warn('[panel-build] 跳过：web/build-info.json 不存在（旧产物）。执行 cd web-admin && npm run build 后将启用校验。');
  process.exit(0);
}
if (status.consistent === false) {
  console.error('[panel-build] 面板产物落后于源码，禁止发版：');
  console.error(`  产物构建于 ${status.artifact.builtAt || '未知时间'}（commit ${status.artifact.commit || '无'}），之后 web-admin 源码有变更。`);
  console.error('  修复：cd web-admin && npm install && npm run build，然后提交 web/，重跑本脚本确认。');
  process.exit(1);
}

// 哈希一致只证明「工作区自洽」；产物随仓库分发，还必须已提交且指纹文件已入库，
// 否则 push 出去的 commit 仍是旧面板（改 src→build→不提交 的场景哈希比对拦不住）。
const dirty = git(['status', '--porcelain', '--', 'web', 'web-admin']);
if (dirty === null) {
  console.warn('[panel-build] 跳过 git 检查（运行目录不是 git 仓库）；产物与工作区源码一致。');
  process.exit(0);
}
if (dirty.trim()) {
  console.error('[panel-build] 面板相关文件有未提交变更，禁止发版（web/ 产物必须随仓库分发）：');
  console.error(dirty.trim().split('\n').map((line) => `  ${line}`).join('\n'));
  console.error('  修复：git add web web-admin && git commit 后重跑本脚本。');
  process.exit(1);
}
const tracked = git(['ls-files', '--error-unmatch', 'web/build-info.json']);
if (tracked === null || !tracked.trim()) {
  console.error('[panel-build] web/build-info.json 未入库：用户端一致性校验会永久失效（git add -u 不含 untracked 文件）。');
  console.error('  修复：git add web/build-info.json 并提交。');
  process.exit(1);
}
console.log(`[panel-build] OK：面板产物与源码一致且已入库（commit ${status.artifact.commit || '无'}，构建于 ${status.artifact.builtAt}）`);
