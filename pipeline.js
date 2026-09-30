import { randomUUID } from 'node:crypto';
import { baiduShareInput } from './baidu.js';
import { generatePublishingPack } from './public/publish-core.js';

const STAGES = [
  ['transferring', '转存到自己的百度网盘'],
  ['waiting', '确认本次文件已保存'],
  ['sharing', '创建自己的分享链接'],
  ['generating', '生成发布文案与配图资料'],
];
const STATUSES = new Set([...STAGES.map(([key]) => key), 'completed', 'failed']);
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

export class PipelineError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PipelineError';
    this.status = status;
    this.statusCode = status;
  }
}

function singleLine(value, limit, label) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new PipelineError(`${label}格式有误`);
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (Array.from(text).length > limit) throw new PipelineError(`${label}最多 ${limit} 个字`);
  return text;
}

function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.resource || typeof raw.resource !== 'object' || Array.isArray(raw.resource)) {
    throw new PipelineError('请选择一条百度网盘直达资源');
  }
  const resource = raw.resource;
  if (resource.platform !== 'baidu') throw new PipelineError('本轮自动流程仅支持百度网盘资源');
  if (resource.direct === false) throw new PipelineError('这条结果是来源网页，请先选择百度网盘直达分享');
  const share = baiduShareInput(resource.shareUrl, resource.accessCode);
  if (!share) throw new PipelineError('仅支持有效的百度官方分享链接与提取码');
  const keyword = singleLine(raw.keyword, 100, '搜索词');
  const title = singleLine(resource.title, 80, '资源名称') || keyword;
  if (!title || Array.from(title).length > 80) throw new PipelineError('请填写不超过 80 个字的资源名称');
  return {
    keyword,
    resource: { title, shareUrl: share.url, accessCode: share.code, platform: 'baidu', direct: true },
    targetBar: singleLine(raw.targetBar, 40, '目标贴吧') || 'AI漫剧吧',
  };
}

function savedResult(value) {
  if (!value || value.kind !== 'saved' || value.confirmed !== true || !Array.isArray(value.files) || !value.files.length) {
    throw new PipelineError('尚未收到本次转存已完成的确认清单，不能创建分享', 409);
  }
  const result = copy(value);
  for (const file of result.files) {
    if (!file || typeof file !== 'object' || typeof file.name !== 'string' || !file.name.trim() ||
        /[\u0000-\u001f\u007f]/u.test(file.name) || typeof file.path !== 'string' || !file.path.startsWith('/')) {
      throw new PipelineError('本次保存文件清单不完整，不能使用网盘根目录代替', 409);
    }
  }
  return result;
}

function waitingResult(value) {
  return value && ['submitted', 'pending'].includes(value.kind);
}

function ownShare(value, sourceUrl) {
  if (value?.verified !== true) throw new PipelineError('尚未确认分享属于本次保存的文件，不能使用该链接生成文案', 409);
  const share = value && baiduShareInput(value.url, value.accessCode);
  if (!share) throw new PipelineError('百度未返回有效的自有分享链接，请重试创建分享', 409);
  if (share.url === sourceUrl) throw new PipelineError('自有分享不能使用原资源的分享链接，请重新创建自己的分享', 409);
  return { url: share.url, accessCode: share.code, verified: true };
}

function publishingResult(job) {
  const included = [];
  let length = 0;
  for (const file of job.files) {
    const next = Array.from(file.name.trim()).length + (included.length ? 1 : 0);
    if (length + next > 1200) break;
    included.push(file.name.trim());
    length += next;
  }
  if (!included.length) throw new PipelineError('本次文件名称过长，请在网盘核对后手工整理发布目录', 409);
  const input = {
    title: job.input.resource.title,
    mode: 'works', synopsis: '', genre: '', episodes: '', completion: 'unknown',
    resources: included.join('\n'),
    ownShareUrl: job.ownShare.url,
    ownAccessCode: job.ownShare.accessCode,
    targetBar: job.input.targetBar,
    tone: 'clear',
  };
  const pack = generatePublishingPack(input);
  if (included.length < job.files.length) pack.warnings.push(`本次共保存 ${job.files.length} 项，发布目录展示前 ${included.length} 项；完整文件请查看自己的网盘分享。`);
  return { input: pack.input, pack };
}

/**
 * Runs one share at a time in the background. Adapter methods perform all network
 * operations; this manager never lists a whole drive or guesses transfer success.
 * saveState/loadState use { version: 1, jobs: [...] }, including saved receipts.
 */
export class PipelineManager {
  constructor({ adapter, saveState, loadState } = {}) {
    if (!adapter || ['save', 'waitForTransfer', 'createShare'].some((method) => typeof adapter[method] !== 'function')) {
      throw new TypeError('PipelineManager requires save, waitForTransfer and createShare adapter methods');
    }
    this.adapter = adapter;
    this.saveState = saveState;
    this.jobs = new Map();
    this.sources = new Map();
    this.persistence = Promise.resolve();
    this.ready = this._load(loadState);
  }

  async _load(loadState) {
    if (!loadState) return;
    const state = await loadState();
    if (!state) return;
    if (state.version !== 1 || !Array.isArray(state.jobs)) throw new PipelineError('本机发布任务记录格式有误，已停止自动操作', 500);
    for (const raw of state.jobs) {
      try {
        if (!raw || typeof raw.id !== 'string' || !/^[\w-]{1,128}$/.test(raw.id) || !STATUSES.has(raw.status)) continue;
        const input = normalizeInput(raw.input);
        if (this.sources.has(input.resource.shareUrl)) continue;
        const job = {
          ...copy(raw), input, source: baiduShareInput(input.resource.shareUrl, input.resource.accessCode),
          running: false, saveAttempted: raw.saveAttempted === true,
          sharingUnknown: raw.sharingUnknown === true,
          stages: STAGES.map(([key, label]) => ({ key, label, status: 'pending' })),
          files: [], ownShare: null, result: null,
        };
        if (raw.transfer?.kind === 'saved') {
          job.transfer = savedResult(raw.transfer);
          job.files = copy(job.transfer.files);
          job.stages[0].status = 'completed';
          job.stages[1].status = 'completed';
        } else if (waitingResult(raw.transfer)) {
          job.stages[0].status = 'completed';
          job.stages[1].status = 'running';
        }
        if (raw.ownShare && job.files.length) {
          job.ownShare = ownShare(raw.ownShare, job.source.url);
          job.stages[2].status = 'completed';
        }
        if (raw.status === 'completed' && job.ownShare) {
          job.result = publishingResult(job);
          for (const stage of job.stages) stage.status = 'completed';
        } else if (job.saveAttempted && !job.transfer) {
          job.transfer = { kind: 'unknown' };
          job.status = 'failed';
          job.error = '上次转存已发起，但完成状态未知。请先在自己的网盘核对，工具不会再次转存。';
          job.stages[0].status = 'failed';
        } else if (raw.status !== 'failed' && raw.status !== 'waiting') {
          job.status = 'failed';
          job.error = '上次流程在程序关闭时中断，可从已确认的步骤继续。';
        }
        this.jobs.set(job.id, job);
        this.sources.set(job.source.url, job.id);
      } catch {
        // Invalid local records must not result in new network side effects.
        if (raw?.input?.resource?.shareUrl) {
          const source = baiduShareInput(raw.input.resource.shareUrl, raw.input.resource.accessCode);
          if (source) this.sources.set(source.url, null);
        }
      }
    }
  }

  _snapshot() {
    return { version: 1, jobs: [...this.jobs.values()].map(({ running, ...job }) => copy(job)) };
  }

  async _persist() {
    if (!this.saveState) return;
    const snapshot = this._snapshot();
    const operation = this.persistence.catch(() => {}).then(() => this.saveState(snapshot));
    this.persistence = operation;
    await operation;
  }

  _canRetry(job) {
    return Boolean(!job.running && !job.sharingUnknown && job.status !== 'completed' &&
      (!job.saveAttempted || job.files.length > 0 || waitingResult(job.transfer)));
  }

  _view(job, existing = false) {
    return copy({
      id: job.id, status: job.status, stages: job.stages,
      input: job.input, transfer: job.transfer, files: job.files,
      ownShare: job.ownShare, sharingUnknown: job.sharingUnknown, result: job.result, error: job.error,
      canRetry: this._canRetry(job), active: job.running, existing,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
    });
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this._view(job) : null;
  }

  async start(raw) {
    await this.ready;
    const input = normalizeInput(raw);
    const source = baiduShareInput(input.resource.shareUrl, input.resource.accessCode);
    if (this.sources.has(source.url)) {
      const previous = this.jobs.get(this.sources.get(source.url));
      if (!previous) throw new PipelineError('该分享的本机任务记录需要先核对，不能再次自动转存', 409);
      return this._view(previous, true);
    }
    const job = {
      id: randomUUID(), input, source, status: 'transferring',
      stages: STAGES.map(([key, label]) => ({ key, label, status: 'pending' })),
      saveAttempted: false, transfer: null, files: [], ownShare: null, sharingUnknown: false, result: null,
      error: null, running: true, createdAt: now(), updatedAt: now(),
    };
    this.jobs.set(job.id, job);
    this.sources.set(source.url, job.id);
    try { await this._persist(); }
    catch {
      job.status = 'failed';
      job.running = false;
      job.error = '本机任务记录保存失败，尚未发起转存。修复存储后可重试。';
      throw new PipelineError(job.error, 500);
    }
    job.running = false;
    this._schedule(job);
    return this._view(job);
  }

  async resume(id) {
    await this.ready;
    const job = this.jobs.get(id);
    if (!job) throw new PipelineError('发布任务不存在', 404);
    if (job.running || job.status === 'completed') return this._view(job, true);
    if (!this._canRetry(job)) throw new PipelineError(job.error || '转存结果未知，请先在自己的网盘核对', 409);
    job.error = null;
    this._schedule(job);
    return this._view(job, true);
  }

  retry(id) { return this.resume(id); }

  _schedule(job) {
    if (job.running) return;
    job.running = true;
    queueMicrotask(() => { void this._run(job); });
  }

  async _stage(job, key) {
    job.status = key;
    job.updatedAt = now();
    const stage = job.stages.find((item) => item.key === key);
    if (stage) stage.status = 'running';
    await this._persist();
  }

  _acceptTransfer(job, result) {
    job.transfer = copy(result);
    if (result?.kind === 'saved') {
      const saved = savedResult(result);
      job.transfer = saved;
      job.files = copy(saved.files);
      job.stages[0].status = 'completed';
      job.stages[1].status = 'completed';
      return true;
    }
    if (waitingResult(result)) {
      job.stages[0].status = 'completed';
      return false;
    }
    job.transfer = { kind: 'unknown' };
    throw new PipelineError('百度转存结果未知，请先在自己的网盘核对，工具不会再次转存', 409);
  }

  async _run(job) {
    try {
      if (!job.files.length) {
        if (!job.transfer) {
          await this._stage(job, 'transferring');
          job.saveAttempted = true;
          // This write is a side-effect fence: a restart must never repeat save.
          try { await this._persist(); }
          catch {
            // The adapter has not been called. Keep this provably safe to retry.
            job.saveAttempted = false;
            job.transfer = null;
            throw new PipelineError('转存前任务记录保存失败，尚未发起转存。修复存储后可重试。', 500);
          }
          try { this._acceptTransfer(job, await this.adapter.save(copy(job.source))); }
          catch (error) {
            if (!job.transfer) job.transfer = { kind: 'unknown' };
            // An adapter may identify a preflight failure before any transfer.
            if (error?.transferStarted === false) { job.saveAttempted = false; job.transfer = null; }
            throw error;
          }
          await this._persist();
        }
        if (!job.files.length) {
          if (!waitingResult(job.transfer)) throw new PipelineError('本次转存尚未确认，请先在自己的网盘核对', 409);
          await this._stage(job, 'waiting');
          const ready = this._acceptTransfer(job, await this.adapter.waitForTransfer(copy(job.transfer)));
          await this._persist();
          if (!ready) {
            job.status = 'waiting';
            job.updatedAt = now();
            await this._persist();
            return;
          }
        }
      }
      if (!job.ownShare) {
        await this._stage(job, 'sharing');
        try { job.ownShare = ownShare(await this.adapter.createShare(copy(job.transfer)), job.source.url); }
        catch (error) {
          if (error?.shareOutcomeUnknown === true) job.sharingUnknown = true;
          throw error;
        }
        job.stages[2].status = 'completed';
        await this._persist();
      }
      await this._stage(job, 'generating');
      job.result = publishingResult(job);
      job.stages[3].status = 'completed';
      job.status = 'completed';
      job.error = null;
      job.updatedAt = now();
      await this._persist();
    } catch (error) {
      const stage = job.stages.find((item) => item.key === job.status);
      if (stage) stage.status = 'failed';
      job.status = 'failed';
      job.error = job.sharingUnknown
        ? '分享请求已发起，但返回结果未知。请先在自己的网盘核对，工具不会再次创建分享。'
        : String(error?.message || '发布素材流程失败').slice(0, 500);
      job.updatedAt = now();
      await this._persist().catch(() => {});
    } finally {
      job.running = false;
    }
  }
}
