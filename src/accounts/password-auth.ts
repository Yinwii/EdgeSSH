import { jwtVerify, SignJWT } from 'jose';
import type { Env } from '../types.ts';
import { APIError } from './http.ts';
import { secureResponse } from '../http-security.ts';

/**
 * 本地密码登录（AUTH_PROVIDER=password）：完全自包含，不依赖 GitHub、
 * Cloudflare Access 或任何外部身份服务。密码来自 .env：
 *   - ADMIN_PASSWORD       明文（自托管 .env 已是受保护的密钥文件）
 *   - ADMIN_PASSWORD_HASH  PBKDF2 哈希，格式 pbkdf2-sha256$迭代$salt$hash
 *     （npm run hash-password 生成），与 ADMIN_PASSWORD 二选一，HASH 优先。
 * 会话与 GitHub 模式同一模式：HKDF 从 ENCRYPTION_KEY 派生签名密钥的
 * HS256 JWT，写入 __Host-edgessh-session Cookie。
 */
const sessionCookie = '__Host-edgessh-session';
const sessionSeconds = 8 * 60 * 60;
const encoder = new TextEncoder();

// 内存级防爆破：同一来源 IP 15 分钟窗口内最多 5 次失败。
// 自托管单实例下有效；Cloudflare 多隔离实例时仅为尽力而为。
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; until: number }>();

function clientKey(request: Request): string {
  const value = request.headers.get('CF-Connecting-IP') ?? 'local';
  return /^[0-9A-Fa-f:.]{2,64}$/.test(value) ? value.toLowerCase() : 'unknown';
}

function retryAfterSeconds(key: string): number {
  const entry = failures.get(key);
  if (!entry || entry.count < MAX_FAILURES) return 0;
  return Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now > entry.until) failures.set(key, { count: 1, until: now + WINDOW_MS });
  else entry.count += 1;
  if (failures.size > 1000) for (const [k, v] of failures) if (now > v.until) failures.delete(k);
}

function cookie(request: Request, name: string): string | undefined {
  return request.headers.get('Cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// 与 github-auth 相同的 HKDF 用途隔离，info 不同即可与 OAuth 会话互相区分。
async function signingKey(secret: string): Promise<Uint8Array> {
  const material = Uint8Array.from(atob(secret.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('edgessh:v1'),
    info: encoder.encode('password-session-cookie'),
  }, await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']), 256));
}

function issuer(env: Env, request: Request): string {
  // 密码模式不强制配置 APP_ORIGIN：本机测试可用访问 origin 兜底。
  return env.APP_ORIGIN || new URL(request.url).origin;
}

const audience = 'edgessh:session:password:admin';

async function signSession(env: Env, request: Request): Promise<string> {
  if (!env.ENCRYPTION_KEY) throw new APIError('管理员尚未配置 ENCRYPTION_KEY。', 503);
  return new SignJWT({ sub: 'admin', username: 'admin' })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer(env, request)).setAudience(audience)
    .setIssuedAt().setExpirationTime(`${sessionSeconds}s`)
    .sign(await signingKey(env.ENCRYPTION_KEY));
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyPassword(env: Env, password: string): Promise<boolean> {
  if (env.ADMIN_PASSWORD_HASH) {
    const [scheme, iterationsText, salt, hash] = env.ADMIN_PASSWORD_HASH.split('$');
    if (scheme !== 'pbkdf2-sha256' || !/^\d+$/.test(iterationsText ?? '') || !salt || !hash) {
      throw new APIError('ADMIN_PASSWORD_HASH 格式无效，请用 npm run hash-password 重新生成。', 503);
    }
    const iterations = Number(iterationsText);
    if (iterations < 10_000 || iterations > 1_000_000) throw new APIError('ADMIN_PASSWORD_HASH 迭代次数超出允许范围。', 503);
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const derived = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(salt), iterations }, key, 256));
    return timingSafeEqual(derived, unbase64(hash));
  }
  if (env.ADMIN_PASSWORD) {
    // 先做 SHA-256 再比较：统一长度、避免时序侧信道，也避免明文进入比较循环。
    const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
    return timingSafeEqual(await digest(password), await digest(env.ADMIN_PASSWORD));
  }
  throw new APIError('管理员尚未配置登录密码（ADMIN_PASSWORD 或 ADMIN_PASSWORD_HASH）。', 503);
}

// ---------------------------------------------------------------------------
// 登录页：内联样式、无外部资源，CSP 允许 'unsafe-inline' style。
// ---------------------------------------------------------------------------
function loginPage(message = '', highlight = ''): Response {
  const errorHtml = message ? `<p class="error">${message}</p>` : '';
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EdgeSSH 登录</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e6e9f2; font: 15px/1.6 system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width: min(360px, 92vw); padding: 2.2rem 2rem; background: #131a30; border: 1px solid #232d4d; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.45); }
  h1 { margin: 0 0 .3rem; font-size: 1.35rem; letter-spacing: .02em; }
  p.sub { margin: 0 0 1.4rem; color: #8b93ab; font-size: .85rem; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .7rem .85rem; background: #0b1020; color: #e6e9f2; border: 1px solid #2a3559; border-radius: 8px; font-size: 1rem; outline: none; }
  input[type=password]:focus { border-color: #4f7cff; box-shadow: 0 0 0 3px rgba(79,124,255,.18); }
  button { width: 100%; margin-top: 1rem; padding: .72rem; background: #4f7cff; color: #fff; border: 0; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #3f6df5; }
  .error { margin: 0 0 1rem; padding: .55rem .8rem; background: rgba(255,87,87,.12); border: 1px solid rgba(255,87,87,.4); color: #ff9d9d; border-radius: 8px; font-size: .85rem; }
</style>
</head>
<body>
  <main class="card">
    <h1>EdgeSSH</h1>
    <p class="sub">请输入管理员密码登录${highlight}</p>
    ${errorHtml}
    <form method="POST" action="/auth/login">
      <input type="password" name="password" placeholder="管理员密码" autocomplete="current-password" autofocus required>
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>`;
  return secureResponse(new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  }));
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return secureResponse(new Response(null, { status: 302, headers }));
}

export async function passwordLoginPage(request: Request, env: Env): Promise<Response> {
  const token = cookie(request, sessionCookie);
  if (token && env.ENCRYPTION_KEY) {
    try {
      await jwtVerify(token, await signingKey(env.ENCRYPTION_KEY), { issuer: issuer(env, request), audience, algorithms: ['HS256'] });
      return redirect('/');
    } catch { /* 过期或无效，渲染登录页 */ }
  }
  return loginPage();
}

export async function passwordLogin(request: Request, env: Env): Promise<Response> {
  const key = clientKey(request);
  const retry = retryAfterSeconds(key);
  if (retry > 0) {
    return loginPage(retry > 60 ? `尝试次数过多，请约 ${Math.ceil(retry / 60)} 分钟后再试。` : `尝试次数过多，请 ${retry} 秒后再试。`);
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new APIError('不允许跨站登录。', 403);
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return loginPage('不支持的请求类型，请从登录页提交。');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 8192) return loginPage('请求体过大。');
  const password = new URLSearchParams(text).get('password') ?? '';
  if (password.length < 1 || password.length > 4096) return loginPage('请输入密码。');

  if (await verifyPassword(env, password)) {
    const session = await signSession(env, request);
    return redirect('/', [setCookie(sessionCookie, session, sessionSeconds)]);
  }
  recordFailure(key);
  return loginPage('密码错误，请重试。');
}

export async function passwordAccount(request: Request, env: Env): Promise<{ id: string; username: string }> {
  if (!env.ENCRYPTION_KEY) throw new APIError('管理员尚未配置 ENCRYPTION_KEY。', 503);
  const token = cookie(request, sessionCookie);
  if (!token) throw new APIError('请先登录。', 401);
  try {
    const { payload } = await jwtVerify(token, await signingKey(env.ENCRYPTION_KEY), {
      issuer: issuer(env, request), audience, algorithms: ['HS256'], requiredClaims: ['exp', 'iat'],
    });
    if (payload.sub !== 'admin') throw new Error('Invalid identity');
    return { id: 'password:admin', username: 'admin' };
  } catch {
    throw new APIError('登录已过期，请重新登录。', 401);
  }
}

export function clearPasswordSession(response: Response): Response {
  response.headers.append('Set-Cookie', setCookie(sessionCookie, '', 0));
  return response;
}
