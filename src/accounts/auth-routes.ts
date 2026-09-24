import type { Env } from '../types.ts';
import { authProvider } from './auth-provider.ts';
import { githubCallback, githubLogin, clearGithubCookies } from './github-auth.ts';
import { clearPasswordSession, passwordLogin, passwordLoginPage } from './password-auth.ts';
import { json } from './http.ts';

export async function authRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/auth/logout') {
    if (request.method !== 'POST') return json({ error: '请使用 POST 退出登录。' }, 405);
    const provider = authProvider(env);
    const response = json({ redirect: provider === 'cloudflare' ? '/cdn-cgi/access/logout' : '/' });
    // password 与 github 的会话 Cookie 同名，按当前 provider 清理一次即可。
    return provider === 'password' ? clearPasswordSession(response) : clearGithubCookies(response);
  }
  if (!['/auth/login', '/auth/callback'].includes(path)) return null;
  const provider = authProvider(env);
  if (provider === 'github') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return path === '/auth/login' ? await githubLogin(request, env) : await githubCallback(request, env);
  }
  if (provider === 'password') {
    if (path === '/auth/callback') return json({ error: '当前未启用外部登录回调。' }, 404);
    if (request.method === 'GET') return await passwordLoginPage(request, env);
    if (request.method === 'POST') return await passwordLogin(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }
  // Cloudflare 模式不接受 GitHub 回调或会话；登录入口由域名前的 Access 网关处理。
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return path === '/auth/login' ? new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } })
    : json({ error: '当前未启用 GitHub 登录。' }, 404);
}
