import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { transferToBaiduRoot } from './baidu-web.js';

export class BaiduBrowser {
  constructor(root, dataDir) {
    this.require = createRequire(path.join(root, 'package.json'));
    this.profileDir = path.join(dataDir, 'baidu-browser');
    this.marker = path.join(this.profileDir, 'manju-authorized.json');
    this.context = null;
    this.starting = null;
    this.headless = true;
    this.waiting = false;
    this.queue = Promise.resolve();
  }

  async browserPath() {
    const candidates = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    ];
    for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
    return '';
  }

  async launch(headless) {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const executablePath = await this.browserPath();
      if (!executablePath) throw new Error('请先安装 Microsoft Edge 或 Google Chrome，再打开百度登录窗口');
      await fs.mkdir(this.profileDir, { recursive: true });
      const { chromium } = this.require('playwright-core');
      const context = await chromium.launchPersistentContext(this.profileDir, {
        executablePath, headless, viewport: null, timeout: 20000,
      });
      this.context = context;
      this.headless = headless;
      context.on('close', () => {
        if (this.context === context) { this.context = null; this.waiting = false; }
      });
      return context;
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async startLogin() {
    if (this.starting) await this.starting;
    if (this.context && this.headless) await this.context.close();
    const context = this.context || await this.launch(false);
    const page = context.pages()[0] || await context.newPage();
    this.waiting = true;
    await page.goto('https://pan.baidu.com/disk/main', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
  }

  async status() {
    const installed = Boolean(await this.browserPath());
    if (!this.context && !this.waiting) {
      try { await fs.access(this.marker); if (installed) await this.launch(true); } catch {}
    }
    let loggedIn = false;
    if (this.context) {
      try {
        const response = await this.context.request.get('https://pan.baidu.com/api/list?dir=%2F&num=1&page=1&web=1&clienttype=0&app_id=250528', { timeout: 10000 });
        loggedIn = (await response.json()).errno === 0;
        if (loggedIn) {
          this.waiting = false;
          await fs.writeFile(this.marker, JSON.stringify({ authorizedAt: new Date().toISOString() }));
        }
      } catch {}
    }
    return { installed, loggedIn, loginState: this.waiting ? 'waiting' : loggedIn ? 'complete' : 'idle', folder: '/', method: 'browser' };
  }

  async save(share) {
    const operation = this.queue.catch(() => {}).then(async () => {
      if (!(await this.status()).loggedIn) throw new Error('请先打开百度登录窗口，完成登录');
      return transferToBaiduRoot(this.context, share);
    });
    this.queue = operation;
    return operation;
  }

  async close() {
    if (this.starting) await this.starting.catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
  }
}
