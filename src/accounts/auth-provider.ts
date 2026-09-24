import type { Env } from '../types.ts';
import { APIError } from './http.ts';

export type AuthProviderName = 'cloudflare' | 'github' | 'password';

export function authProvider(env: Pick<Env, 'AUTH_PROVIDER'>): AuthProviderName {
  // 'cloudflare' 是云端部署的默认值；自托管服务器上按 .env 显式指定。
  const provider = env.AUTH_PROVIDER || 'cloudflare';
  if (provider !== 'cloudflare' && provider !== 'github' && provider !== 'password') {
    throw new APIError('管理员尚未正确配置登录方式。', 503);
  }
  return provider;
}
