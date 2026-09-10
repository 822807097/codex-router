/**
 * 原始 conversation SSE 抓包：诊断「200 但零文本增量」。
 * 复用通道的 acquireChatRequirements（含修复后的 turnstile VM），
 * 直接打上游并打印前 60 个 SSE 事件原文。
 * 用法：node scripts/probe-web-conversation.mjs [model]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawHttpsRequest } from '../lib/transport.mjs';
import {
  acquireChatRequirements,
  buildConversationPayload,
} from '../lib/chatgpt-web-channel.mjs';
import { createCredentialsStore, createCredentialsVault } from '../lib/auth/credentials-store.mjs';
import { createAuthManager } from '../lib/auth/auth-manager.mjs';
import { dbListAccounts } from '../lib/db.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const model = process.argv[2] || 'gpt-5-6';

const credentialsStore = createCredentialsStore({ persistPath: path.join(repoRoot, 'accounts.json') });
const credentialsVault = createCredentialsVault({ vaultPath: path.join(repoRoot, 'credentials-vault.json') });
const authManager = createAuthManager({ log: () => {} });
for (const acc of credentialsStore.loadAccounts()) authManager.addAccount(acc);
try {
  const vaultAll = credentialsVault.loadAll();
  for (const row of dbListAccounts()) {
    authManager.addAccount({
      id: row.id, provider: row.provider, email: row.email || '',
      status: row.status || 'active', metadata: row.metadata || {},
      ...(vaultAll[row.id] ? { credentials: vaultAll[row.id] } : {}),
    });
  }
} catch { /* 兜底 */ }

const account = (authManager.listAccounts('chatgpt-web') || []).find((a) => a.status !== 'disabled');
const creds = await authManager.getValidCredentials(account.id);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const proxy = { host: '127.0.0.1', port: 10808 };
const fp = { userAgent: UA, deviceId: crypto.randomUUID(), sessionId: crypto.randomUUID() };

console.log('account:', account.id, '| model:', model);
const requirements = await acquireChatRequirements({
  accessToken: creds.accessToken, fp, proxy, log: (e) => console.log('[sentinel]', e.event),
});
console.log('[sentinel] token acquired, turnstile =', requirements.turnstileToken ? 'solved' : 'absent');

const payload = buildConversationPayload([{ role: 'user', content: '用一句话介绍你自己' }], model);
const conversationPath = '/backend-api/conversation';
const res = await rawHttpsRequest({
  protocol: 'https',
  host: 'chatgpt.com',
  path: conversationPath,
  method: 'POST',
  viaProxy: true,
  proxy,
  headers: {
    'user-agent': UA,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'oai-language': 'en-US',
    authorization: `Bearer ${creds.accessToken}`,
    'oai-device-id': fp.deviceId,
    'oai-session-id': fp.sessionId,
    'x-openai-target-path': conversationPath,
    'x-openai-target-route': conversationPath,
    'openai-sentinel-chat-requirements-token': requirements.token,
    ...(requirements.proofToken ? { 'openai-sentinel-proof-token': requirements.proofToken } : {}),
    ...(requirements.turnstileToken ? { 'openai-sentinel-turnstile-token': requirements.turnstileToken } : {}),
    ...(requirements.soToken ? { 'openai-sentinel-so-token': requirements.soToken } : {}),
  },
  body: JSON.stringify(payload),
  timeouts: { connectMs: 15_000, responseHeaderMs: 30_000, requestMs: 90_000 },
});
console.log('[conversation] status =', res.status);
const text = typeof res.bodyText === 'string' ? res.bodyText : '';
const lines = text.split('\n').filter((l) => l.startsWith('data: ')).slice(0, 60);
for (const line of lines) {
  const raw = line.slice(6);
  let pretty = raw;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj === 'string') pretty = `STR: ${obj.slice(0, 80)}`;
    else if (obj && typeof obj === 'object') {
      pretty = JSON.stringify(obj).slice(0, 220);
    }
  } catch { /* 原样 */ }
  console.log(pretty);
}
if (!lines.length) console.log('(raw head)', text.slice(0, 400));
