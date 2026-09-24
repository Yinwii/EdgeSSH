#!/usr/bin/env node
/**
 * 生成 EdgeSSH 本地密码登录的 PBKDF2 哈希（AUTH_PROVIDER=password 时使用）。
 *
 * 用法：
 *   npm run hash-password -- 你的密码        # 命令行参数（注意会留在 shell 历史里）
 *   npm run hash-password                   # 交互输入（不回显，推荐）
 *
 * 输出写入 .env 的 ADMIN_PASSWORD_HASH，格式：pbkdf2-sha256$迭代$salt$hash
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { argv, stdin, stdout, exit } from 'node:process';

async function readPassword(): Promise<string> {
  if (argv.length > 2) return argv[2];
  const rl = createInterface({ input: stdin, output: stdout });
  // 逐字符读取并回显星号，避免密码出现在终端和 shell 历史。
  let password = '';
  const listener = (char: string) => {
    if (char === '\r' || char === '\n') return;
    if (char === '\u0003') exit(130);
    if (char === '\u007f' || char === '\b') {
      if (password.length > 0) { password = password.slice(0, -1); stdout.write('\b \b'); }
      return;
    }
    password += char;
    stdout.write('*');
  };
  stdin.on('data', listener);
  await new Promise<void>((resolve) => {
    rl.once('close', () => { stdin.removeListener('data', listener); resolve(); });
    stdout.write('请输入管理员密码：');
  });
  stdout.write('\n');
  return password;
}

const password = await readPassword();
if (password.length < 8) {
  console.error('[EdgeSSH] 密码至少需要 8 个字符。');
  exit(1);
}
const iterations = 210_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const encoded = `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
console.log(encoded);
console.log('将上面一行填入 .env 的 ADMIN_PASSWORD_HASH（不要带引号）。');
