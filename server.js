import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isSea } from 'node:sea';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanQuery, normalizeIndexResult, searchEngineLinks, searchLinks } from './search.js';
import { searchAll } from './search-service.js';
import { SearchApiError, testSearchProvider } from './search-api.js';
import { SearchConfig, SearchConfigError } from './search-config.js';
import { quarkShareInput } from './transfer.js';
import { baiduShareInput } from './baidu.js';
import { BaiduBrowser } from './baidu-browser.js';
import { BaiduUserError } from './baidu-web.js';
import { selectTrending } from './trending.js';
import { PipelineManager } from './pipeline.js';

const root = isSea() ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.join(process.env.LOCALAPPDATA || root, 'ManjuPublishStudio');
const configPath = path.join(dataDir, 'config.local.json');
const searchConfig = new SearchConfig(configPath);
let port = Number(process.env.PORT || 4187);
const runFile = promisify(execFile);
const quarkDir = path.join(dataDir, 'quark');
const quarkEnv = { ...process.env, QUARK_CONFIG_DIR: quarkDir };
const quarkCli = path.join(root, '.venv', 'Scripts', 'quarkpan.exe');
const quarkPython = path.join(root, '.venv', 'Scripts', 'python.exe');
const packedQuarkCli = path.join(root, 'components', 'quarkpan.exe');
const packedQuarkLogin = path.join(root, 'components', 'quark-login.exe');
const qrPath = path.join(quarkDir, 'login-qr.png');
const baiduDir = path.join(dataDir, 'baidu');
const baiduPendingPath = path.join(baiduDir, 'pending.json');
const baiduBrowser = new BaiduBrowser(root, dataDir);
const baiduPending = new Map();
let loginState = 'idle';
let loginProcess = null;
const activeTransfers = new Set();
const pipelinePath = path.join(dataDir, 'publishing-jobs.json');
const pipeline = new PipelineManager({
  adapter: {
    async save(share) {
      const key = createHash('sha256').update(`root:${share.url}#${share.code}`).digest('hex');
      const existing = baiduPending.get(key);
      if (existing) {
        if (existing.receiptId) return { ...existing };
        const error = new BaiduUserError('已有旧版本转存任务缺少确认凭据，请先在百度网盘核对，工具不会重复保存');
        error.transferStarted = false;
        throw error;
      }
      if (activeTransfers.has(key)) {
        const error = new BaiduUserError('该资源正在转存，请稍后继续任务');
        error.transferStarted = false;
        throw error;
      }
      activeTransfers.add(key);
      try {
        const result = await baiduBrowser.save(share);
        if (['submitted', 'pending'].includes(result.kind)) {
          baiduPending.set(key, { ...result, createdAt: Date.now() });
          await saveBaiduPending();
        }
        return result;
      } finally { activeTransfers.delete(key); }
    },
    async waitForTransfer(result) {
      const deadline = Date.now() + 15 * 60 * 1000;
      let current = result;
      do {
        current = await baiduBrowser.waitForTransfer(current, { timeoutMs: Math.min(60000, deadline - Date.now()) });
        if (current.kind === 'saved') {
          for (const [key, entry] of baiduPending) if (entry.receiptId === current.receiptId) baiduPending.delete(key);
          await saveBaiduPending().catch(() => {});
          return current;
        }
        if (!['submitted', 'pending'].includes(current.kind)) return current;
        if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2000));
      } while (Date.now() < deadline);
      return current;
    },
    async createShare(result) {
      const share = await baiduBrowser.createShare(result, { period: 7 });
      return { url: share.shareUrl, accessCode: share.accessCode, verified: share.verified };
    },
  },
  async loadState() {
    try { return JSON.parse(await fs.readFile(pipelinePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('任务记录无法读取，请先保留并检查本机 publishing-jobs.json 文件'); }
  },
  async saveState(state) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(`${pipelinePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(`${pipelinePath}.tmp`, pipelinePath);
  },
});
// Invalid state is reported by task routes without crashing unrelated search.
pipeline.ready.catch(() => {});
try {
  const entries = JSON.parse(readFileSync(baiduPendingPath, 'utf8'));
  for (const [key, entry] of Object.entries(entries)) {
    if (entry && Date.now() - Number(entry.createdAt) < 7 * 86400000) baiduPending.set(key, entry);
  }
} catch { /* No pending transfers yet. */ }

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function localRequest(req) {
  const host = req.headers.host || '';
  const allowedHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  const origin = req.headers.origin;
  return allowedHost && (!origin || origin === `http://${host}`);
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 4096) throw new Error('提交内容过长');
  }
  return JSON.parse(data);
}

async function quarkReady() {
  return Boolean(await quarkPaths());
}

async function quarkPaths() {
  try { await fs.access(packedQuarkCli); await fs.access(packedQuarkLogin);
    return { cli: packedQuarkCli, login: packedQuarkLogin, args: [] };
  } catch { /* Development installation may use a Python virtual environment. */ }
  try { await fs.access(quarkCli); await fs.access(quarkPython);
    return { cli: quarkCli, login: quarkPython, args: [path.join(root, 'quark_login.py')] };
  } catch { return null; }
}

async function saveBaiduPending() {
  await fs.mkdir(baiduDir, { recursive: true });
  await fs.writeFile(baiduPendingPath, JSON.stringify(Object.fromEntries(baiduPending)), { mode: 0o600 });
}

async function quarkLoggedIn() {
  const paths = await quarkPaths();
  if (!paths) return false;
  try {
    await runFile(paths.cli, ['auth', 'status'], { env: quarkEnv, timeout: 12000, windowsHide: true });
    return true;
  } catch { return false; }
}

function startQuarkLogin(paths) {
  loginState = 'waiting';
  loginProcess = spawn(paths.login, paths.args, {
    cwd: root,
    env: quarkEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  loginProcess.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('QR_READY')) loginState = 'qr';
  });
  loginProcess.stderr.on('data', () => { /* Keep account details out of HTTP responses. */ });
  loginProcess.on('error', () => { loginState = 'error'; loginProcess = null; });
  loginProcess.on('exit', (code) => {
    loginState = code === 0 ? 'complete' : 'error';
    loginProcess = null;
  });
}

async function trendingSearch() {
  const platforms = ['baidu', 'quark'];
  const settled = await Promise.allSettled(platforms.map(async (platform) => {
    const url = new URL('https://www.pansousuo.com/api/search');
    url.searchParams.set('q', 'AI漫剧');
    url.searchParams.set('pan', platform);
    url.searchParams.set('sort', 'hot');
    const response = await fetch(url, { signal: AbortSignal.timeout(18000) });
    if (!response.ok) throw new Error(`公开索引返回 ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.items)) throw new Error('公开索引结果格式有误');
    return data.items.map((raw) => normalizeIndexResult(raw, platform)).filter(Boolean);
  }));
  const errors = {};
  const results = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') results.push(...entry.value);
    else errors[platforms[index]] = entry.reason?.message || '暂时无法读取';
  });
  return { items: selectTrending(results), errors, refreshedAt: new Date().toISOString() };
}

const server = http.createServer(async (req, res) => {
  if (!localRequest(req)) return json(res, 403, { error: '仅允许本机访问' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return json(res, 200, { app: 'manju-publish-studio', ...searchConfig.status(), indexed: true });
  }

  if (url.pathname === '/api/publishing/jobs' && req.method === 'POST') {
    try {
      const input = await readJson(req);
      if (!(await baiduBrowser.status()).loggedIn) return json(res, 401, { error: '请先登录自己的百度网盘，完成后点击“继续任务”。' });
      let job = await pipeline.start(input);
      if (job.canRetry) job = await pipeline.resume(job.id);
      return json(res, 202, job);
    } catch (error) { return json(res, error.statusCode || 400, { error: error.message || '无法启动自动流程' }); }
  }
  const jobRoute = /^\/api\/publishing\/jobs\/([a-zA-Z0-9_-]+)(\/retry)?$/.exec(url.pathname);
  if (jobRoute) {
    try {
      await pipeline.ready;
      const job = pipeline.get(jobRoute[1]);
      if (!job) return json(res, 404, { error: '没有找到这项任务，请从搜索结果重新选择资源' });
      if (!jobRoute[2] && req.method === 'GET') return json(res, 200, job);
      if (jobRoute[2] && req.method === 'POST') {
        if (!(await baiduBrowser.status()).loggedIn) return json(res, 401, { error: '百度登录已失效，请完成登录后继续任务' });
        return json(res, 202, await pipeline.resume(jobRoute[1]));
      }
      return json(res, 405, { error: '不支持此任务操作' });
    } catch (error) { return json(res, error.statusCode || 400, { error: error.message || '任务暂时无法继续' }); }
  }

  if (url.pathname === '/api/quark/status' && req.method === 'GET') {
    return json(res, 200, {
      installed: await quarkReady(),
      loggedIn: await quarkLoggedIn(),
      loginState,
    });
  }

  if (url.pathname === '/api/quark/login' && req.method === 'POST') {
    const paths = await quarkPaths();
    if (!paths) return json(res, 503, { error: '夸克转存组件尚未安装，请查看使用说明' });
    if (loginProcess) return json(res, 200, { loginState });
    try {
      await fs.mkdir(quarkDir, { recursive: true });
      await fs.rm(qrPath, { force: true });
      startQuarkLogin(paths);
      return json(res, 200, { loginState });
    } catch {
      return json(res, 500, { error: '无法启动夸克扫码登录' });
    }
  }

  if (url.pathname === '/api/quark/qr' && req.method === 'GET') {
    if (loginState !== 'qr') return json(res, 404, { error: '二维码尚未就绪' });
    try {
      const image = await fs.readFile(qrPath);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(image);
    } catch { return json(res, 404, { error: '二维码尚未就绪' }); }
  }

  if (url.pathname === '/api/quark/transfer' && req.method === 'POST') {
    if (!(await quarkLoggedIn())) return json(res, 401, { error: '请先扫码登录夸克网盘' });
    let input;
    try { input = await readJson(req); }
    catch { return json(res, 400, { error: '转存信息格式有误' }); }
    const share = quarkShareInput(input.shareUrl, input.accessCode);
    if (!share) return json(res, 400, { error: '仅支持有效的夸克网盘分享链接' });
    if (activeTransfers.has(share)) return json(res, 409, { error: '该资源正在转存，请稍候' });
    activeTransfers.add(share);
    try {
      const paths = await quarkPaths();
      const result = await runFile(paths.cli, ['save', share, '--folder', '/', '--save-all', '--wait', '--timeout', '90'], {
        cwd: root, env: quarkEnv, timeout: 115000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      if (!result.stdout.includes('转存成功')) throw new Error('no-success');
      return json(res, 200, { saved: true, folder: '/' });
    } catch {
      return json(res, 502, { error: '转存未完成。请检查分享链接、提取码或网盘空间后重试。' });
    } finally { activeTransfers.delete(share); }
  }

  if (url.pathname === '/api/baidu/status' && req.method === 'GET') {
    return json(res, 200, await baiduBrowser.status());
  }

  if (url.pathname === '/api/baidu/browser-login' && req.method === 'POST') {
    try {
      await baiduBrowser.startLogin();
      return json(res, 200, { loginState: 'waiting' });
    } catch { return json(res, 502, { error: '百度登录窗口未能打开。请确认已安装 Edge 或 Chrome，并关闭此前的工具登录窗口后重试。' }); }
  }

  if (url.pathname === '/api/baidu/transfer' && req.method === 'POST') {
    if (!(await baiduBrowser.status()).loggedIn) return json(res, 401, { error: '请先打开百度登录窗口，登录自己的账号' });
    let input;
    try { input = await readJson(req); } catch { return json(res, 400, { error: '转存信息格式有误' }); }
    const share = baiduShareInput(input.shareUrl, input.accessCode);
    if (!share) return json(res, 400, { error: '仅支持有效的百度网盘分享链接' });
    const key = createHash('sha256').update(`root:${share.url}#${share.code}`).digest('hex');
    const pending = baiduPending.get(key);
    if (pending) return json(res, 202, { status: 'submitted', ...pending, existing: true });
    if (activeTransfers.has(key)) return json(res, 409, { error: '该资源正在转存，请稍候' });
    activeTransfers.add(key);
    try {
      const result = await baiduBrowser.save(share);
      if (result.kind === 'submitted') {
        const entry = { taskId: result.taskId, folder: result.folder, createdAt: Date.now() };
        baiduPending.set(key, entry);
        await saveBaiduPending().catch(() => {});
        return json(res, 202, { status: 'submitted', ...entry });
      }
      if (result.kind !== 'saved') throw new Error('unconfirmed-transfer');
      return json(res, 200, { status: 'saved', files: result.files, folder: '/' });
    } catch (error) {
      return json(res, 502, { error: error instanceof BaiduUserError ? error.message : '转存未确认完成。请先到百度网盘根目录核对，再决定是否重试。' });
    } finally { activeTransfers.delete(key); }
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      return json(res, 200, await searchConfig.update(body));
    } catch (error) {
      return json(res, 400, { error: error instanceof SearchConfigError ? error.message : '搜索设置格式有误' });
    }
  }

  if (url.pathname === '/api/search/test' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      if (!['qiniu', 'brave'].includes(body?.provider)) return json(res, 400, { error: '未知搜索 API' });
      return json(res, 200, await testSearchProvider(body.provider, searchConfig.key(body.provider)));
    } catch (error) {
      return json(res, 400, { error: error instanceof SearchApiError ? error.message : '连接测试未完成，请稍后重试' });
    }
  }

  if (url.pathname === '/api/search' && req.method === 'GET') {
    const keyword = cleanQuery(url.searchParams.get('q'));
    const kind = url.searchParams.get('kind') || 'all';
    const freshness = url.searchParams.get('freshness') || 'all';
    const page = Number(url.searchParams.get('page') || 1);
    if (!keyword) return json(res, 400, { error: '请输入搜索关键词' });
    if (!['works', 'making', 'all'].includes(kind) || !['all', 'pd', 'pw', 'pm'].includes(freshness) || !Number.isInteger(page) || page < 1 || page > 100) {
      return json(res, 400, { error: '搜索选项无效' });
    }
    const externalLinks = searchLinks(keyword, kind);
    const data = await searchAll(keyword, kind, freshness, searchConfig.key('brave'), { page, qiniuApiKey: searchConfig.key('qiniu') });
    return json(res, 200, { mode: 'integrated', externalLinks, engineLinks: searchEngineLinks(keyword, kind), ...data });
  }

  if (url.pathname === '/api/trending' && req.method === 'GET') {
    const data = await trendingSearch();
    return json(res, Object.keys(data.errors).length === 2 ? 502 : 200, data);
  }

  if (req.method !== 'GET') return json(res, 405, { error: '不支持此操作' });
  const routes = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/publish.js': 'publish.js', '/publish-core.js': 'publish-core.js', '/publish-poster.js': 'publish-poster.js', '/pipeline-ui.js': 'pipeline-ui.js' };
  const file = routes[url.pathname];
  if (!file) return json(res, 404, { error: '页面不存在' });
  try {
    const filePath = path.join(publicDir, file);
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'",
    });
    res.end(content);
  } catch {
    json(res, 500, { error: '页面读取失败' });
  }
});

let fallbackUsed = false;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && isSea() && !process.env.PORT && !fallbackUsed) {
    fallbackUsed = true;
    server.listen(0, '127.0.0.1');
  } else {
    console.error(`漫剧发布工作台启动失败：${error.message}`);
    process.exitCode = 1;
  }
});
server.on('listening', () => {
  port = server.address().port;
  console.log(`漫剧发布工作台已启动：http://127.0.0.1:${port}`);
  if (isSea() && !process.argv.includes('--no-browser')) {
    const browser = spawn('explorer.exe', [`http://127.0.0.1:${port}/`], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.error('浏览器未能自动打开，请手动访问上方地址。'));
  }
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { baiduBrowser.close().finally(() => process.exit(0)); });
}
