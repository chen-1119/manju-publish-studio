import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { transferToBaiduRoot, waitForBaiduTransfer, createBaiduShare, BaiduUserError } from './baidu-web.js';

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
    this.receiptsPath = path.join(dataDir, 'baidu-confirmed-transfers.json');
    this.receipts = new Map();
    this.receiptsReady = this.loadReceipts();
    this.receiptsReady.catch(() => {});
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
      try {
        await this.receiptsReady;
        if (!(await this.status()).loggedIn) throw new BaiduUserError('请先打开百度登录窗口，完成登录');
      } catch (error) { error.transferStarted = false; throw error; }
      const result = await transferToBaiduRoot(this.context, share);
      const receiptId = randomUUID();
      const recorded = { ...result, receiptId };
      this.receipts.set(receiptId, { result: recorded, createdAt: new Date().toISOString() });
      await this.storeReceipts();
      return JSON.parse(JSON.stringify(recorded));
    });
    this.queue = operation;
    return operation;
  }

  async loadReceipts() {
    let state;
    try { state = JSON.parse(await fs.readFile(this.receiptsPath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw new BaiduUserError('本机百度转存确认记录无法读取，已停止自动分享，请检查数据目录');
    }
    if (state.version !== 1 || !Array.isArray(state.receipts)) throw new BaiduUserError('本机百度转存确认记录格式异常，已停止自动分享');
    for (const [id, entry] of state.receipts) {
      if (typeof id !== 'string' || !entry?.result || entry.result.receiptId !== id || !['saved', 'pending', 'submitted'].includes(entry.result.kind)) throw new BaiduUserError('本机百度转存确认记录不完整，已停止自动分享');
      this.receipts.set(id, entry);
    }
  }

  async storeReceipts() {
    await fs.mkdir(path.dirname(this.receiptsPath), { recursive: true });
    const temporary = `${this.receiptsPath}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, receipts: [...this.receipts] }), { mode: 0o600 });
      await fs.rename(temporary, this.receiptsPath);
    } catch { throw new BaiduUserError('本机百度转存确认记录保存失败，已停止后续操作，请检查数据目录'); }
  }

  recordedReceipt(input, { allowEarlier = false } = {}) {
    const entry = typeof input?.receiptId === 'string' ? this.receipts.get(input.receiptId) : null;
    if (!entry) throw new BaiduUserError('缺少本次转存的本机确认凭据，不能分享任意文件或网盘根目录');
    const keys = (files) => Array.isArray(files) ? files.map((file) => `${file.fsId || ''}:${file.path || ''}`).sort().join('\n') : '';
    const earlier = allowEarlier && ['submitted', 'pending'].includes(input.kind) && ['submitted', 'pending', 'saved'].includes(entry.result.kind);
    if (input.taskId !== entry.result.taskId || (!earlier && keys(input.files) !== keys(entry.result.files))) throw new BaiduUserError('转存确认凭据与文件清单不一致，已停止自动分享');
    return entry;
  }

  async waitForTransfer(input, options = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      await this.receiptsReady;
      const entry = this.recordedReceipt(input, { allowEarlier: true });
      if (!(await this.status()).loggedIn) throw new BaiduUserError('请重新打开百度登录窗口，完成登录后继续核对');
      const result = await waitForBaiduTransfer(this.context, entry.result, options);
      entry.result = { ...result, receiptId: input.receiptId };
      await this.storeReceipts();
      return JSON.parse(JSON.stringify(entry.result));
    });
    this.queue = operation;
    return operation;
  }

  async createShare(input, options = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      await this.receiptsReady;
      const entry = this.recordedReceipt(input);
      if (entry.result.kind !== 'saved' || entry.result.confirmed !== true) throw new BaiduUserError('本次转存尚未确认完成，不能创建分享');
      if (entry.shareAttempted && !entry.shareCreated) {
        const error = new BaiduUserError('上次创建分享已提交但返回结果未知，请在百度窗口核对，工具不会重复创建');
        error.shareOutcomeUnknown = true;
        throw error;
      }
      if (!(await this.status()).loggedIn) throw new BaiduUserError('请重新打开百度登录窗口，完成登录后继续创建分享');
      let share;
      try { share = await createBaiduShare(this.context, entry.result.files, {
        period: options.period ?? 7, accessCode: options.accessCode || '', existingShare: entry.shareCreated,
        onBeforeShare: async () => {
          entry.shareAttempted = true;
          try { await this.storeReceipts(); } catch (error) { entry.shareAttempted = false; throw error; }
        },
        onShareCreated: async (created) => { entry.shareCreated = created; await this.storeReceipts(); },
      }); } catch (error) {
        if (entry.shareAttempted && !entry.shareCreated) {
          if (Number.isInteger(error.baiduErrno) && error.baiduErrno !== 0) {
            entry.shareAttempted = false;
            await this.storeReceipts();
          } else error.shareOutcomeUnknown = true;
        }
        throw error;
      }
      entry.shareCreated = share;
      await this.storeReceipts();
      return JSON.parse(JSON.stringify(share));
    });
    this.queue = operation;
    return operation;
  }

  async close() {
    if (this.starting) await this.starting.catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
  }
}
