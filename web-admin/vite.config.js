import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { hashPanelSource } from '../lib/panel-build-info.mjs';

// 构建烙印：把「本次构建所用的面板源码内容哈希 + commit + 版本 + 时间」写进
// web/build-info.json（随仓库分发）。运行时管理端 /_admin/api/panel-build 现算
// 工作区哈希比对，面板产物落后于源码（发版忘重新构建）时面板会显式警告。
function buildInfoPlugin() {
  return {
    name: 'router-panel-build-info',
    apply: 'build',
    closeBundle() {
      let commit = '';
      try {
        commit = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
          .toString().trim();
      } catch { /* 无 .git 的环境照样出产物，只是指纹里没有 commit */ }
      let version = '';
      try {
        version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version || '';
      } catch { /* 版本仅作展示 */ }
      const info = {
        commit,
        version,
        builtAt: new Date().toISOString(),
        sourceHash: hashPanelSource(__dirname) || '',
      };
      fs.writeFileSync(
        path.resolve(__dirname, '../web/build-info.json'),
        `${JSON.stringify(info, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  plugins: [vue(), buildInfoPlugin()],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/_admin/api': {
        target: 'http://127.0.0.1:15730',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../web'),
    // 保留旧 chunk：运行中面板的 SPA 引用着上一版文件名，清空会让已打开页面切路由时 401 空白
    // （2026-09-04 实锤）；assets 累积可定期手动清理。
    emptyOutDir: false,
  },
});
