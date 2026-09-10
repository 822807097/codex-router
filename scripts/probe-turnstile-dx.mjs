/**
 * 抓取一份真实 sentinel prepare 的 dx 并保存，供离线分析 turnstile VM 分支覆盖。
 * 账号加载路径与 codex-router.mjs 启动逻辑一致：accounts.json（旧）+ credentials-vault.json
 * + SQLite accounts 表，三源合并进 authManager。
 * 用法：node scripts/probe-turnstile-dx.mjs
 * 输出：docs/reference/chatgpt2api/real-dx.json（dx + p）+ JS 求解结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawHttpsRequest } from '../lib/transport.mjs';
import { solveTurnstileToken } from '../lib/chatgpt-web-turnstile.mjs';
import { createCredentialsStore, createCredentialsVault } from '../lib/auth/credentials-store.mjs';
import { createAuthManager } from '../lib/auth/auth-manager.mjs';
import { getDatabase, dbListAccounts } from '../lib/db.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_DIR = repoRoot; // 运行实例=仓库工作副本（router-ops-layout 记忆）

const credentialsStore = createCredentialsStore({
  persistPath: path.join(CONFIG_DIR, 'accounts.json'),
});
const credentialsVault = createCredentialsVault({
  vaultPath: path.join(CONFIG_DIR, 'credentials-vault.json'),
});
const authManager = createAuthManager({ log: () => {} });
for (const acc of credentialsStore.loadAccounts()) authManager.addAccount(acc);
try {
  const vaultAll = credentialsVault.loadAll();
  for (const row of dbListAccounts()) {
    authManager.addAccount({
      id: row.id,
      provider: row.provider,
      email: row.email || '',
      status: row.status || 'active',
      metadata: row.metadata || {},
      ...(vaultAll[row.id] ? { credentials: vaultAll[row.id] } : {}),
    });
  }
} catch { /* SQLite 不可用时靠 accounts.json/vault 兜底 */ }

const account = (authManager.listAccounts('chatgpt-web') || []).find((a) => a.status !== 'disabled');
if (!account) {
  console.error('no chatgpt-web account loaded; providers:',
    (authManager.listAccounts() || []).map((a) => `${a.provider}:${a.status}`).join(', ') || '(none)');
  process.exit(1);
}
const creds = await authManager.getValidCredentials(account.id);
if (!creds?.accessToken) {
  console.error('no access token for', account.id);
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
// 与 config.json 的全局 proxy 一致（viaProxy 出站必需；国内网络直连 chatgpt.com 不通）
const proxy = { host: '127.0.0.1', port: 10808 };
const { buildLegacyRequirementsToken } = await import('../lib/chatgpt-web-pow.mjs');
const powOpts = { scriptSources: ['https://chatgpt.com/backend-api/sentinel/sdk.js'], dataBuild: '' };
const pToken = buildLegacyRequirementsToken(UA, powOpts);

const res = await rawHttpsRequest({
  protocol: 'https',
  host: 'chatgpt.com',
  path: '/backend-api/sentinel/chat-requirements/prepare',
  method: 'POST',
  viaProxy: true,
  proxy,
  headers: {
    'user-agent': UA,
    'content-type': 'application/json',
    accept: '*/*',
    'oai-language': 'en-US',
    authorization: `Bearer ${creds.accessToken}`,
  },
  body: JSON.stringify({ p: pToken }),
  timeouts: { connectMs: 15_000, responseHeaderMs: 20_000, requestMs: 25_000 },
});
const data = JSON.parse(res.bodyText);
const dx = data?.turnstile?.dx || '';
console.log('turnstile.required =', Boolean(data?.turnstile?.required), '| dx length =', dx.length);
if (!dx) process.exit(0);

const outFile = path.join(repoRoot, 'docs', 'reference', 'chatgpt2api', 'real-dx.json');
fs.writeFileSync(outFile, JSON.stringify({ dx, p: pToken, capturedAt: new Date().toISOString() }, null, 1));
console.log('saved ->', outFile);

const token = solveTurnstileToken(dx, pToken);
console.log('JS solve:', token ? `OK len=${token.length} prefix=${token.slice(0, 16)}` : 'NULL');
