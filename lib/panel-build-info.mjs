// ---------- 面板构建指纹：产物新鲜度校验 ----------
// 自更新把 web/ 产物随仓库分发（零依赖发版：用户机器不编译）。面板是否会旧，
// 只取决于发版者是否「改了 web-admin 源却忘了重新构建就发版」。这里用内容指纹
// 把该状态显式化：构建时把「面板源码内容哈希」烙进 web/build-info.json，
// 运行时对工作区现算哈希比对——一致即产物正是由当前源码构建的。
// 刻意不用 git 历史做语义（commit 在构建之前还不存在，时序比对必出误报）；
// commit/builtAt 仅作展示。纯内容比对不依赖 .git，无 .git 的部署副本同样可用。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 参与指纹的根级文件（构建输入：源码 + 影响产物的配置/依赖清单）
const ROOT_FILES = [
  'vite.config.js',
  'tailwind.config.js',
  'postcss.config.js',
  'package.json',
  'index.html',
];
// 5MB 上限防异常巨型文件拖垮启动；面板源码实际远小于此
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function isBinary(bytes) {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function normalizeText(bytes) {
  // git autocrlf 在不同平台 checkout 出的行尾不同；文本统一按 LF 归一化再哈希，
  // 否则同一份源码在 Windows 构建、Mac 校验会误报过期。
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * 确定性哈希 web-admin 构建输入：src/** 递归（相对路径排序）+ 根级配置文件。
 * 源码增删文件、改内容都会改变哈希；哈希失败（目录不存在等）返回 null。
 */
export function hashPanelSource(webAdminDir) {
  const hash = createHash('sha256');
  const digestFile = (relativePath, bytes) => {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(isBinary(bytes) ? bytes : normalizeText(bytes));
    hash.update('\0');
  };
  try {
    const srcDir = path.join(webAdminDir, 'src');
    const files = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, relative);
        } else if (entry.isFile() && fs.statSync(full).size <= MAX_FILE_BYTES) {
          files.push([relative, full]);
        }
      }
    };
    walk(srcDir, 'src');
    files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (files.length === 0) return null;
    for (const [relative, full] of files) {
      digestFile(relative, fs.readFileSync(full));
    }
    for (const name of ROOT_FILES) {
      const full = path.join(webAdminDir, name);
      try {
        if (fs.statSync(full).isFile()) digestFile(name, fs.readFileSync(full));
      } catch { /* 可缺省（如老部署缺 tailwind 配置） */ }
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * 读产物指纹文件（web/build-info.json）。形状不对/缺失/损坏一律返回 null，
 * 让上层按「旧产物、校验不可用」处理而不是报错。
 */
export function readPanelBuildInfo(webRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(webRoot, 'build-info.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const info = {
      commit: typeof parsed.commit === 'string' ? parsed.commit.slice(0, 40) : '',
      version: typeof parsed.version === 'string' ? parsed.version.slice(0, 40) : '',
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt.slice(0, 40) : '',
      sourceHash: typeof parsed.sourceHash === 'string' ? parsed.sourceHash : '',
    };
    return info.sourceHash ? info : null;
  } catch {
    return null;
  }
}

/**
 * 面板产物新鲜度：consistent 三态。
 * - true：产物由当前面板源码构建
 * - false：源码已变而产物未重建（面板落后，需提醒）
 * - null：产物未携带指纹（本次改动前构建的旧产物）或源码不可读——校验不可用，静默
 */
export function panelBuildStatus({ webRoot, webAdminDir }) {
  if (!webRoot || !webAdminDir) return { supported: false, consistent: null };
  const artifact = readPanelBuildInfo(webRoot);
  if (!artifact) {
    return {
      supported: true,
      consistent: null,
      artifact: null,
      message: '面板产物未携带构建指纹（旧版本构建），重新构建一次后即可启用一致性校验',
    };
  }
  const sourceHash = hashPanelSource(webAdminDir);
  if (!sourceHash) {
    return { supported: true, consistent: null, artifact, sourceHash: null };
  }
  const consistent = sourceHash === artifact.sourceHash;
  return {
    supported: true,
    consistent,
    artifact,
    sourceHash,
    ...(consistent ? {} : {
      message: '前端面板产物落后于当前源码：面板可能缺少最新功能。请在 web-admin 目录执行 npm install 和 npm run build 重新构建并提交 web/，或在管理页重新运行一键更新',
    }),
  };
}
