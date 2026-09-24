#!/usr/bin/env node
/**
 * EdgeSSH 自托管跨平台服务管理 CLI（Windows / Linux / macOS）
 *
 * 用法：node server/cli.mjs <start|stop|restart|status|log> [--rebuild] [--lines N]
 *
 * - start    安装依赖（如缺失）→ 按需构建 → 后台启动 serve.mjs，PID/日志落在 server/data
 * - stop     优雅停止（Linux/macOS 优先杀整个进程组，Windows 用 taskkill /T /F）
 * - restart  stop + start，可用 --rebuild 强制重新构建
 * - status   查看运行状态
 * - log      查看最近日志（--lines N，默认 50）
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(process.env.EDGESSH_DATA_DIR || join(rootDir, 'server', 'data'));
const pidFile = join(dataDir, 'edgessh.pid');
const logFile = join(dataDir, 'edgessh.log');
const workerBundle = join(rootDir, 'build', 'worker', 'worker.js');
const distIndex = join(rootDir, 'dist', 'index.html');
const isWindows = process.platform === 'win32';

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
const linesIndex = rest.indexOf('--lines');
const linesArg = linesIndex >= 0 && /^\d+$/.test(rest[linesIndex + 1] || '') ? Number(rest[linesIndex + 1]) : 50;

function die(message, code = 1) {
  console.error(`[EdgeSSH] ${message}`);
  process.exit(code);
}

function run(cmd, args) {
  // Windows 下 npm 是 npm.cmd，直接 spawn 会被 Node 安全策略拒绝，
  // 改经 cmd.exe 调用；命令与参数均为静态字符串，无注入风险。
  const [realCmd, realArgs] = isWindows
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${cmd} ${args.join(' ')}`]]
    : [cmd, args];
  const result = spawnSync(realCmd, realArgs, { stdio: 'inherit', cwd: rootDir });
  if (result.error) throw result.error;
  return result.status === 0;
}

function readPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // 权限不足但进程存在
  }
}

function tailLog(lines) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split(/\r?\n/).filter((line, index, arr) => line !== '' || index < arr.length - 1).slice(-lines);
}

function printStatus() {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`[EdgeSSH] 正在运行（PID ${pid}）`);
    return { running: true, pid };
  }
  console.log('[EdgeSSH] 未在运行。');
  return { running: false, pid: null };
}

function installDeps() {
  if (existsSync(join(rootDir, 'node_modules'))) return;
  console.log('[1/3] 安装依赖（首次运行较慢）...');
  const lock = existsSync(join(rootDir, 'package-lock.json'));
  const ok = lock
    ? run('npm', ['ci', '--no-audit', '--no-fund'])
    : run('npm', ['install', '--no-audit', '--no-fund']);
  if (!ok) die('依赖安装失败，请检查 Node.js（需 >= 22.12）与网络后重试。');
}

// prune --omit=dev 会把构建工具（vite / typescript / wrangler）一并清除，
// 强制重建前需先补回，否则 npm run build:server 会因缺工具而失败。
function ensureBuildDeps() {
  if (existsSync(join(rootDir, 'node_modules', 'vite'))) return;
  console.log('      补回构建工具（npm ci）...');
  const lock = existsSync(join(rootDir, 'package-lock.json'));
  const ok = lock
    ? run('npm', ['ci', '--no-audit', '--no-fund'])
    : run('npm', ['install', '--no-audit', '--no-fund']);
  if (!ok) die('构建依赖安装失败，请检查网络后重试。');
}

// 构建完成后清除开发依赖，运行时只需生产依赖（miniflare / ws / jose 等），
// 磁盘占用从约 500 MB 降到约 200 MB。
function pruneDevDeps() {
  console.log('      清理开发依赖（npm prune --omit=dev）...');
  if (!run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'])) {
    console.warn('[EdgeSSH] [警告] prune 失败（不影响运行，仅多占磁盘）。');
  }
}

function buildIfNeeded(force) {
  if (!force && existsSync(workerBundle) && existsSync(distIndex)) {
    console.log('[2/3] 构建产物已存在，跳过构建（可用 --rebuild 强制重建）。');
    return;
  }
  ensureBuildDeps();
  console.log('[2/3] 构建前端与 Worker...');
  if (!run('npm', ['run', 'build:server'])) die('构建失败，请查看上方报错信息。');
  pruneDevDeps();
}

function startService() {
  mkdirSync(dataDir, { recursive: true });
  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.log(`[EdgeSSH] 已在运行（PID ${existing}），如需重启请执行 restart。`);
    return;
  }
  if (existing) {
    console.log('[EdgeSSH] 清理失效的 PID 文件。');
    writeFileSync(pidFile, '');
  }

  console.log('[3/3] 启动服务（后台运行）...');
  const out = openSync(logFile, 'a');
  // 记录当前日志偏移：只把本次启动新增的内容当作就绪信号，避免旧日志干扰。
  const logOffset = fstatSync(out).size;
  const child = spawn(process.execPath, [join(__dirname, 'serve.mjs')], {
    cwd: rootDir,
    detached: true,           // POSIX: 新会话/进程组；Windows: 独立进程树
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`);

  // 等待启动并验证存活
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    spawnSync(isWindows ? 'ping' : 'sleep', isWindows ? ['-n', '2', '127.0.0.1'] : ['1'], { stdio: 'ignore' });
    if (!isRunning(child.pid)) {
      console.error('[EdgeSSH] 启动失败，最近日志：');
      const failed = readFileSync(logFile).slice(logOffset).toString('utf8').split(/\r?\n/).filter(Boolean).slice(-20);
      for (const line of failed) console.error(`  ${line}`);
      process.exit(1);
    }
    if (readFileSync(logFile).slice(logOffset).toString('utf8').includes('自托管模式已启动')) break;
  }

  console.log('----------------------------------------------');
  console.log('  EdgeSSH 已启动（后台运行）');
  console.log(`  PID      : ${child.pid}`);
  console.log(`  日志     : ${logFile}`);
  console.log('  停止     : node server/cli.mjs stop');
  console.log('----------------------------------------------');
  // 把 serve.mjs 本次启动的横幅原样回显（含「访问入口 / 监听地址」等关键信息）。
  // 注意必须从 logOffset 起：tail 整个文件会把上次运行留下的旧日志
  // （例如上次启动失败的「端口 8787 已被占用」）一并带出来误导用户。
  const banner = readFileSync(logFile).slice(logOffset).toString('utf8').split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed && trimmed !== '----------------------------------------------';
  });
  for (const line of banner) console.log(`  ${line.trim()}`);
}

function stopService() {
  const pid = readPid();
  if (!pid) {
    console.log('[EdgeSSH] 未找到 PID 文件，服务可能未在运行。');
    return;
  }
  if (!isRunning(pid)) {
    console.log(`[EdgeSSH] 进程 ${pid} 已不存在，清理 PID 文件。`);
    writeFileSync(pidFile, '');
    return;
  }

  if (isWindows) {
    // /T 连同 workerd 子进程一起结束
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'inherit' });
    console.log(`[EdgeSSH] 已停止（PID ${pid}）`);
  } else {
    const killGroup = (signal) => {
      try { process.kill(-pid, signal); } catch { process.kill(pid, signal); }
    };
    killGroup('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isRunning(pid)) {
      spawnSync('sleep', ['0.5'], { stdio: 'ignore' });
    }
    if (isRunning(pid)) killGroup('SIGKILL');
    console.log(`[EdgeSSH] 已停止（PID ${pid}）`);
  }
  writeFileSync(pidFile, '');
}

function isGitRepo() {
  return existsSync(join(rootDir, '.git'));
}

function gitPull() {
  if (!isGitRepo()) die('当前目录不是 git 仓库，无法自动同步源码。请先在项目根目录运行 git init / git clone。');
  console.log('[1/4] git pull 拉取最新源码...');
  if (!run('git', ['pull', '--ff-only'])) die('git pull 失败（可能有冲突或网络问题）。请手动解决后重试。');
}

function updateService() {
  gitPull();
  console.log('[2/5] 安装/同步依赖（npm ci）...');
  if (!run('npm', ['ci', '--no-audit', '--no-fund'])) die('npm ci 失败，请检查 Node.js 版本与网络。');
  console.log('[3/5] 重新构建（前端 + Worker）...');
  if (!run('npm', ['run', 'build:server'])) die('构建失败，请查看上方报错。');
  pruneDevDeps();
  console.log('[4/5] 重启服务...');
  // 不论服务是否在跑都重新启动一次，保证产物和进程都更新。
  stopService();
  console.log('[5/5] 启动新版本...');
  startService();
  console.log('[EdgeSSH] update 完成。');
}

function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    console.warn(`[EdgeSSH] [警告] 当前 Node ${process.versions.node} 低于推荐的 22.12，可能出现兼容问题。`);
  }

  switch (command) {
    case 'start':
      installDeps();
      buildIfNeeded(flags.has('--rebuild'));
      startService();
      break;
    case 'stop':
      stopService();
      break;
    case 'restart':
      stopService();
      installDeps();
      buildIfNeeded(flags.has('--rebuild'));
      startService();
      break;
    case 'status':
      printStatus();
      break;
    case 'update':
      updateService();
      break;
    case 'log': {
      const { running } = printStatus();
      console.log(`--- ${logFile} 最近 ${linesArg} 行 ---`);
      for (const line of tailLog(Number.isFinite(linesArg) ? linesArg : 50)) console.log(line);
      if (running) console.log('\n（实时跟踪：Linux/macOS 用 tail -f，Windows 用 Get-Content -Wait）');
      break;
    }
    default:
      die(`未知命令 "${command || ''}"。用法：node server/cli.mjs <start|stop|restart|update|status|log> [--rebuild] [--lines N]`);
  }
}

main();
