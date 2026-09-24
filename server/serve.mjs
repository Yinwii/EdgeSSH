#!/usr/bin/env node
/**
 * EdgeSSH 自托管服务器入口（server 模式）
 *
 * 使用 Cloudflare 生产同款运行时 workerd（经 miniflare 驱动）运行 Worker 代码，
 * 因此 SSH 协议、Durable Objects、D1、cloudflare:sockets 行为与线上完全一致。
 * D1 数据与 DO 状态全部落在本机 server/data 目录。
 *
 * 配置：项目根目录 .env（可被同名环境变量覆盖），参见 .env.example。
 */
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { networkInterfaces } from 'node:os';
import { Miniflare } from 'miniflare';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(process.env.EDGESSH_DATA_DIR || join(rootDir, 'server', 'data'));
const distDir = join(rootDir, 'dist');
const workerScript = join(rootDir, 'build', 'worker', 'worker.js');
const migrationsDir = join(rootDir, 'migrations');

// ---------------------------------------------------------------------------
// 配置加载：process.env > .env 文件 > 默认值
// ---------------------------------------------------------------------------
function loadDotEnv() {
  const file = join(rootDir, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8787),
  appOrigin: process.env.APP_ORIGIN?.replace(/\/+$/, '') || '',
  authProvider: process.env.AUTH_PROVIDER || 'github',
  githubClientId: process.env.GITHUB_CLIENT_ID || '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  githubAdminId: process.env.GITHUB_ADMIN_ID || '',
  githubAdmin: process.env.GITHUB_ADMIN || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  connectTimeoutMs: process.env.CONNECT_TIMEOUT_MS || '10000',
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
};

function die(message) {
  console.error(`[EdgeSSH] ${message}`);
  process.exit(1);
}

if (!existsSync(workerScript)) {
  die('未找到 Worker 构建产物 build/worker/worker.js，请先运行 npm run build:server。');
}
if (!existsSync(distDir)) {
  die('未找到前端构建产物 dist/，请先运行 npm run build:web。');
}
mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// 加密密钥：优先 .env/环境变量，否则自动生成并持久化到 server/data/ENCRYPTION_KEY。
// 云端存储的主机资料用它做 AES-GCM 加密，丢失后无法解密，请务必备份。
// ---------------------------------------------------------------------------
if (!config.encryptionKey) {
  const keyFile = join(dataDir, 'ENCRYPTION_KEY');
  if (existsSync(keyFile)) {
    config.encryptionKey = readFileSync(keyFile, 'utf8').trim();
  } else {
    config.encryptionKey = randomBytes(32).toString('base64');
    writeFileSync(keyFile, config.encryptionKey + '\n', { mode: 0o600 });
    console.log('[EdgeSSH] 已生成新的加密密钥并写入 server/data/ENCRYPTION_KEY，请妥善备份该文件。');
  }
}

// ---------------------------------------------------------------------------
// GitHub 管理员：支持直接给数字 ID（GITHUB_ADMIN_ID），或给用户名自动解析。
// ---------------------------------------------------------------------------
async function resolveGithubAdminId() {
  if (config.githubAdminId) return;
  if (!config.githubAdmin) {
    console.warn('[EdgeSSH] [警告] 尚未配置管理员（GITHUB_ADMIN_ID 或 GITHUB_ADMIN），登录接口将不可用，其余功能可先验证。');
    return;
  }
  try {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(config.githubAdmin)}`, {
      headers: { 'User-Agent': 'EdgeSSH' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const user = await response.json();
    if (!Number.isSafeInteger(user.id)) throw new Error('响应缺少数字 ID');
    config.githubAdminId = String(user.id);
    console.log(`[EdgeSSH] 已解析 GitHub 管理员 ${config.githubAdmin} -> 数字 ID ${config.githubAdminId}`);
  } catch (error) {
    die(`解析 GitHub 管理员数字 ID 失败（${error.message}）。也可直接在 .env 设置 GITHUB_ADMIN_ID。`);
  }
}

// ---------------------------------------------------------------------------
// workerd 运行时（miniflare）
// ---------------------------------------------------------------------------
const publicOrigin = config.appOrigin || (config.tlsCert ? `https://localhost:${config.port}` : `http://localhost:${config.port}`);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.xml': 'application/xml',
};

function serveAsset(pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith('/')) relative += 'index.html';
  const safe = normalize(relative).replace(/^([/\\])+/, '');
  let file = join(distDir, safe);
  if (!file.startsWith(distDir + sep) || !existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback：非静态路径回退到 index.html，与 Workers Assets 的
    // not_found_handling = "single-page-application" 行为一致。
    file = join(distDir, 'index.html');
  }
  const ext = extname(file).toLowerCase();
  const immutable = safe.startsWith('assets' + sep);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable'
      : ext === '.html' ? 'no-store' : 'public, max-age=3600',
  };
  return new Response(readFileSync(file), { headers });
}

const mf = new Miniflare({
  scriptPath: workerScript,
  modules: true,
  compatibilityDate: '2026-07-01',
  bindings: Object.fromEntries(Object.entries({
    ENCRYPTION_KEY: config.encryptionKey,
    AUTH_PROVIDER: config.authProvider,
    APP_ORIGIN: config.appOrigin,
    GITHUB_CLIENT_ID: config.githubClientId,
    GITHUB_CLIENT_SECRET: config.githubClientSecret,
    GITHUB_ADMIN_ID: config.githubAdminId,
    ADMIN_PASSWORD: config.adminPassword,
    ADMIN_PASSWORD_HASH: config.adminPasswordHash,
    CONNECT_TIMEOUT_MS: config.connectTimeoutMs,
  }).filter(([, value]) => value !== undefined && value !== '')),
  durableObjects: { SSH_SESSIONS: 'SSHSessionDO' },
  d1Databases: ['DB'],
  serviceBindings: { ASSETS: (request) => serveAsset(new URL(request.url).pathname) },
  persist: join(dataDir, 'state'),
});

async function applyMigrations() {
  const db = await mf.getD1Database('DB');
  await db.exec('CREATE TABLE IF NOT EXISTS _server_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set();
  const rows = await db.prepare('SELECT name FROM _server_migrations').all();
  for (const row of rows.results) applied.add(row.name);
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    // 不用 db.exec：其语句解析对多行 SQL 不稳定，按分号拆成单条语句逐条执行。
    const sql = readFileSync(join(migrationsDir, name), 'utf8').replace(/\r\n/g, '\n');
    for (const statement of sql.split(';')) {
      const trimmed = statement.trim();
      if (trimmed) await db.prepare(`${trimmed};`).run();
    }
    await db.prepare('INSERT INTO _server_migrations (name, applied_at) VALUES (?, ?)').bind(name, Date.now()).run();
    console.log(`[EdgeSSH] 已应用数据库迁移 ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Node HTTP <-> workerd 请求转换
// ---------------------------------------------------------------------------
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);

function clientIp(req) {
  let candidate = '';
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') candidate = forwarded.split(',')[0].trim();
    else if (Array.isArray(forwarded)) candidate = String(forwarded[0]).trim();
    if (!candidate && typeof req.headers['x-real-ip'] === 'string') candidate = req.headers['x-real-ip'].trim();
  }
  if (!candidate) {
    const remote = req.socket.remoteAddress || '';
    candidate = remote.replace(/^::ffff:/, '');
  }
  return /^[0-9A-Fa-f:.]{2,64}$/.test(candidate) ? candidate.toLowerCase() : 'unknown';
}

function buildTargetUrl(req) {
  const base = config.appOrigin || `${config.tlsCert ? 'https' : 'http'}://${req.headers.host || `localhost:${config.port}`}`;
  return new URL(req.url, base);
}

// 读取完整请求体。API 请求体都很小（< 10MB），缓冲比流式转发更稳，
// 也避免跨 undici 实例的 ReadableStream 兼容问题。
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('Request body is too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function dispatchToWorker(req, { forUpgrade = false } = {}) {
  const url = buildTargetUrl(req);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue;
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['host'] = url.host;
  delete headers['x-forwarded-host'];
  // 仅在 HTTPS 场景注入 CF-Connecting-IP：Worker 用该头判断"生产环境 HTTP 需跳转
  // HTTPS"。本地明文运行时不注入，客户端 IP 会显示为 local（Worker 已兼容）。
  const secureTarget = config.appOrigin?.startsWith('https:') || Boolean(config.tlsCert && config.tlsKey);
  if (secureTarget || config.trustProxy) headers['cf-connecting-ip'] = clientIp(req);
  if (forUpgrade) {
    // miniflare 的 WebSocket 路径会用自己的 ws 客户端完成握手（生成
    // Sec-WebSocket-Key/Version），这里只保留应用层需要校验的头。
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    headers['upgrade'] = 'websocket';
  } else {
    delete headers['upgrade'];
  }
  const hasBody = !forUpgrade && !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? await readBody(req) : undefined;
  return mf.dispatchFetch(url.toString(), {
    method: req.method,
    headers,
    body,
    duplex: hasBody ? 'half' : undefined,
    // 不在桥接层跟随重定向：3xx 需原样交还浏览器（登录回调、HTTPS 跳转等）。
    // 且 undici 跟随 302 时会尝试复用已消费的请求体，直接导致 fetch failed。
    redirect: 'manual',
  });
}

function forwardResponse(response, res) {
  const headers = {};
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'set-cookie') continue;
    headers[key] = value;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) { res.end(); return; }
  const nodeStream = Readable.fromWeb(response.body);
  nodeStream.on('error', () => res.destroy());
  nodeStream.pipe(res);
}

// ---------------------------------------------------------------------------
// WebSocket 管道：浏览器 ws <-> workerd 101 响应中的 webSocket
// ---------------------------------------------------------------------------
function pumpWebSockets(browserWs, workerWs) {
  // Miniflare 通过 dispatchFetch → fetch5 桥接时，返回给 Node 的 webSocket
  // 是 WebSocketPair 中没被任何一方显式 accept 的那一半；不先 accept 的话
  // .send() 会直接抛 "You must call accept()"，并且 Worker→browser 的事件
  // 会卡在 #dispatchQueue 里永远 dispatch 不出来（表现：浏览器一直连接中）。
  if (typeof workerWs.accept === 'function') {
    try { workerWs.accept(); } catch { /* already accepted / coupled — 忽略 */ }
  }
  const queue = [];
  let workerReady = false;
  const flush = () => {
    workerReady = true;
    console.warn(`[pump] workerWS ready, flushing ${queue.length} queued`);
    while (queue.length) { const item = queue.shift(); try { workerWs.send(item.data, { binary: item.binary }); } catch { /* closed */ } }
  };
  if (workerWs.readyState === 1 /* OPEN */ || typeof workerWs.accept !== 'function') flush();
  else workerWs.addEventListener('open', flush, { once: true });

  browserWs.on('message', (data, isBinary) => {
    const text = isBinary ? `<binary ${data.length}B>` : data.toString('utf8').slice(0, 200);
    console.warn(`[pump] browser→worker (workerReady=${workerReady}): ${text}`);
    const item = { data: isBinary ? new Uint8Array(data) : data.toString('utf8'), binary: isBinary };
    if (workerReady) { try { workerWs.send(item.data, { binary: item.binary }); } catch { /* closed */ } }
    else queue.push(item);
  });
  browserWs.on('close', (code, reason) => {
    try { workerWs.close(code, reason?.toString('utf8').slice(0, 123) || undefined); } catch { /* closed */ }
  });
  browserWs.on('error', () => {
    try { workerWs.close(1011, 'browser socket error'); } catch { /* closed */ }
  });
  workerWs.addEventListener('message', (event) => {
    const data = event.data;
    const preview = typeof data === 'string' ? data.slice(0, 200) : `<${data.byteLength ?? data.length}B>`;
    console.warn(`[pump] worker→browser: ${preview}`);
    try {
      if (typeof data === 'string') browserWs.send(data, { binary: false });
      else if (data instanceof ArrayBuffer) browserWs.send(Buffer.from(data), { binary: true });
      else if (data instanceof Uint8Array) browserWs.send(Buffer.from(data), { binary: true });
      else if (typeof Blob !== 'undefined' && data instanceof Blob) data.arrayBuffer().then((buffer) => {
        try { browserWs.send(Buffer.from(buffer), { binary: true }); } catch { /* closed */ }
      });
    } catch { /* closed */ }
  });
  workerWs.addEventListener('close', (event) => {
    try { browserWs.close(event.code ?? 1005, event.reason || ''); } catch { /* closed */ }
  });
  workerWs.addEventListener('error', () => {
    try { browserWs.close(1011, 'worker socket error'); } catch { /* closed */ }
  });
}

const wss = new WebSocketServer({ noServer: true });

async function handleUpgrade(req, socket, head) {
  let response;
  try {
    response = await dispatchToWorker(req, { forUpgrade: true });
  } catch (error) {
    console.error('[EdgeSSH] 升级请求处理失败：', error?.message || error);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const workerWs = response.webSocket;
  if (response.status !== 101 || !workerWs) {
    // 未升级（如 401 未登录）：把普通 HTTP 响应写回原始 socket。
    const body = response.body ? new TextDecoder().decode(await response.arrayBuffer()) : '';
    const lines = [`HTTP/1.1 ${response.status} ${response.statusText || ''}`];
    for (const [key, value] of response.headers) {
      if (key.toLowerCase() === 'content-length') continue;
      lines.push(`${key}: ${value}`);
    }
    if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    socket.end(lines.join('\r\n') + '\r\n\r\n' + body);
    return;
  }
  // miniflare 返回的 webSocket 已在内部 accept 并打开。
  wss.handleUpgrade(req, socket, head, (browserWs) => pumpWebSockets(browserWs, workerWs));
}

// ---------------------------------------------------------------------------
// 普通 HTTP 请求
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  try {
    const response = await dispatchToWorker(req);
    forwardResponse(response, res);
  } catch (error) {
    let causes = [];
    for (let c = error?.cause, i = 0; c && i < 5; c = c.cause, i++) causes.push(String(c?.message ?? c));
    console.error('[EdgeSSH] 请求处理失败：', error?.message || error, causes.length ? `原因链: ${causes.join(' <- ')}` : '', error?.stack || '');
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '服务器内部错误，请稍后重试。' }));
    } else {
      res.destroy();
    }
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function printStartup(protocol) {
  // 监听 0.0.0.0/:: 时，列出所有可访问 URL（localhost + 各非 loopback IPv4），
  // 避免只显示 localhost 导致用户从外网不知道入口。
  let display;
  if (config.appOrigin) {
    display = config.appOrigin;
  } else if (config.host === '0.0.0.0' || config.host === '::') {
    const urls = [`${protocol}://localhost:${config.port}`];
    for (const addrs of Object.values(networkInterfaces())) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          urls.push(`${protocol}://${addr.address}:${config.port}`);
        }
      }
    }
    display = urls.join('  |  ');
  } else {
    display = `${protocol}://${config.host}:${config.port}`;
  }
  console.log('----------------------------------------------');
  console.log(`  EdgeSSH 自托管模式已启动 (${protocol})`);
  console.log(`  监听地址   : ${config.host}:${config.port}`);
  console.log(`  访问入口   : ${display}`);
  console.log(`  登录方式   : ${config.authProvider}`);
  console.log(`  数据目录   : ${dataDir}`);
  console.log('----------------------------------------------');
  if (!config.appOrigin && config.authProvider === 'github') {
    console.log('  [提示] 未设置 APP_ORIGIN：GitHub 登录需要与 OAuth App 回调地址完全一致的');
    console.log('         公网入口，正式使用前请在 .env 中配置 APP_ORIGIN=https://你的域名。');
  }
  if (!config.tlsCert) {
    console.log('  [提示] 当前未启用 TLS。登录 Cookie 带 __Host-/Secure 标记，浏览器要求 HTTPS，');
    console.log('         请通过 TLS_CERT/TLS_KEY 直连证书，或用 nginx/Caddy 反代终止 TLS。');
  }
}

async function main() {
  if (config.authProvider === 'github') await resolveGithubAdminId();
  else if (config.authProvider === 'password' && !config.adminPassword && !config.adminPasswordHash) {
    console.warn('[EdgeSSH] [警告] 已选择密码登录但未设置 ADMIN_PASSWORD / ADMIN_PASSWORD_HASH，登录接口将不可用。');
  }
  await applyMigrations();

  let server;
  if (config.tlsCert && config.tlsKey) {
    server = createHttpsServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handleRequest);
  } else {
    server = createServer(handleRequest);
  }
  server.on('upgrade', handleUpgrade);
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolvePort);
  }).catch((error) => {
    if (error?.code === 'EADDRINUSE') die(`端口 ${config.port} 已被占用，请更换 PORT 后重试。`);
    throw error;
  });

  printStartup(config.tlsCert ? 'https' : 'http');

  const shutdown = async (signal) => {
    console.log(`\n[EdgeSSH] 收到 ${signal}，正在关闭...`);
    server.close();
    await mf.dispose().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[EdgeSSH] 启动失败：', error);
  process.exit(1);
});
