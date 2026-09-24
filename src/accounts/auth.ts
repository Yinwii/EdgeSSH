import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../types.ts';
import { accessToken } from './access-token.ts';
import { APIError } from './http.ts';
import { authProvider } from './auth-provider.ts';
import { githubAccount } from './github-auth.ts';
import { passwordAccount } from './password-auth.ts';

export interface Account { id: string; username: string }
const resolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function currentAccount(request: Request, env: Env): Promise<Account> {
  const provider = authProvider(env);
  const identity = provider === 'github' ? await githubAccount(request, env)
    : provider === 'password' ? await passwordAccount(request, env)
      : await accessAccount(request, env);
  // 本项目只有一个管理员。认证来源可切换，资料的加密 AAD 与所有者 ID 必须保持不变。
  return { id: env.ADMIN_ACCOUNT_ID || identity.id, username: identity.username };
}

async function accessAccount(request: Request, env: Env): Promise<Account> {
  if (!env.ACCESS_AUD || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN ?? '')) {
    throw new APIError('管理员尚未配置 Zero Trust Access。', 503);
  }
  const token = accessToken(request);
  if (!token) throw new APIError('请通过 Cloudflare Access 登录后访问。', 401);
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = resolvers.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    resolvers.set(issuer, keys);
  }
  try {
    // 不信任邮箱请求头：校验签名、有效期、团队与应用，防止绕过 Access 直连 Worker。
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'email'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('Missing identity');
    return { id: payload.sub, username: payload.email };
  } catch {
    throw new APIError('Access 登录已失效，请重新登录。', 401);
  }
}
