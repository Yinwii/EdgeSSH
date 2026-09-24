#!/usr/bin/env node
/**
 * EdgeSSH 自托管冒烟测试（不经 Cloudflare，直接打本地服务器）。
 * 用 .env 中的密钥伪造管理员会话 Cookie，验证：
 *   1. /api/hosts CRUD（D1 + AES-GCM 加密存储）
 *   2. POST /api/session 签发一次性 ticket
 *   3. GET /api/ssh WebSocket 升级进入 Durable Object
 *   4. connect 指令到达 SSH 会话层（用私有地址触发预期的 SSRF 拦截错误）
 *
 * 用法：node server/smoke-test.mjs [端口]
 * 需要服务器以 AUTH_PROVIDER=github + GITHUB_CLIENT_ID + GITHUB_ADMIN_ID 启动。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const port = Number(process.argv[2] || 18787);
const ORIGIN = `http://localhost:${port}`;

// 与 src/accounts/github-auth.ts 完全一致的签名密钥派生（标准 Base64 密钥）
const secret = readFileSync(resolve(root, 'server', 'data', 'ENCRYPTION_KEY'), 'utf8').trim();
const keyMaterial = Uint8Array.from(atob(secret.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hkdfKey = await crypto.subtle.importKey('raw', new Uint8Array(keyMaterial), 'HKDF', false, ['deriveBits']);
const signingBits = await crypto.subtle.deriveBits({
  name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('edgessh:v1'),
  info: new TextEncoder().encode('github-oauth-cookie'),
}, hkdfKey, 256);
const signingKey = await crypto.subtle.importKey('raw', signingBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

const env = { ...process.env };
try {
  for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trim().startsWith('#')) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
} catch { /* 无 .env 时直接用环境变量 */ }
const clientId = env.GITHUB_CLIENT_ID;
const adminId = env.GITHUB_ADMIN_ID;
if (!clientId || !adminId) { console.error('需要 GITHUB_CLIENT_ID 与 GITHUB_ADMIN_ID'); process.exit(1); }

const sessionJwt = await new SignJWT({ sub: adminId, username: 'smoke-tester' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer(ORIGIN)
  .setAudience(`edgessh:session:${clientId}:${adminId}`)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(signingKey);
const cookie = `__Host-edgessh-session=${sessionJwt}`;

let failed = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${detail}`}`);
  if (!condition) failed++;
}

// ---- 1. hosts CRUD ----
const hostBody = {
  name: '冒烟测试主机', group: '测试', host: 'example.com', port: 22, username: 'root',
  authMethod: 'password', password: 'dummy-password', initialCommand: '', termType: 'xterm-256color',
  encoding: 'utf-8', fingerprint: '',
};
const createResponse = await fetch(`${ORIGIN}/api/hosts`, {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify(hostBody),
});
const created = await createResponse.json();
check('创建主机（D1 写入 + 加密）', createResponse.status === 201 && created.host?.id, JSON.stringify(created));

const listResponse = await fetch(`${ORIGIN}/api/hosts`, { headers: { Cookie: cookie } });
const list = await listResponse.json();
const listed = (list.hosts || []).find((h) => h.id === created.host?.id);
check('主机列表返回且凭据不外泄', Boolean(listed) && listed.hasCredential === true && listed.password === undefined);

const credResponse = await fetch(`${ORIGIN}/api/hosts/${created.host.id}/credentials`, {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}',
});
const cred = await credResponse.json();
check('凭据解密回读一致', cred.password === 'dummy-password', JSON.stringify(cred));

const deleteResponse = await fetch(`${ORIGIN}/api/hosts/${created.host.id}`, {
  method: 'DELETE', headers: { Cookie: cookie, Origin: ORIGIN },
});
check('删除主机', deleteResponse.status === 200);

// ---- 2/3/4. session ticket + WebSocket -> DO ----
const ticketResponse = await fetch(`${ORIGIN}/api/session`, {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}',
});
const ticket = await ticketResponse.json();
check('签发会话 ticket', ticketResponse.status === 200 && ticket.ticket && ticket.sessionId, JSON.stringify(ticket));

if (ticket.ticket) {
  const connectResult = await new Promise((resolveTest) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/ssh?ticket=${encodeURIComponent(ticket.ticket)}&session=${ticket.sessionId}`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    const timer = setTimeout(() => { ws.terminate(); resolveTest({ timeout: true }); }, 15_000);
    ws.on('error', (error) => { clearTimeout(timer); resolveTest({ error: error.message }); });
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'status') return; // tcp_connecting 等状态消息
      clearTimeout(timer);
      try { ws.close(); } catch { /* closed */ }
      resolveTest(message);
    });
  });
  check('WebSocket 升级进入 Durable Object', !connectResult.timeout && !connectResult.error, JSON.stringify(connectResult));
  check('SSH 连接指令到达会话层（SSRF 拦截生效）',
    connectResult.type === 'error' && connectResult.event === 'connection_failed'
    && /private|reserved/i.test(connectResult.message || ''), JSON.stringify(connectResult));
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
