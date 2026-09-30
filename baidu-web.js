import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { baiduShareInput } from './baidu.js';

export class BaiduUserError extends Error {}

function metadataNotReady(message) {
  const error = new BaiduUserError(message);
  error.metadataNotReady = true;
  return error;
}

const channel = { channel: 'chunlei', clienttype: '0', web: '1', app_id: '250528' };
const apiUrl = (route, params = {}) => `https://pan.baidu.com${route}?${new URLSearchParams({ ...channel, ...params })}`;
const diskHeaders = { Referer: 'https://pan.baidu.com/disk/main', 'X-Requested-With': 'XMLHttpRequest' };

function checkReply(data, action) {
  if (!data || typeof data !== 'object' || !Number.isInteger(data.errno)) throw new BaiduUserError(`${action}返回异常，未确认成功，请在百度窗口核对`);
  if (data.errno === 0 && !data.vcode && !data.vcode_str && !data.authwidget) return;
  if ([-6, -100, 111, 8001].includes(data.errno)) throw new BaiduUserError('百度登录已失效，请重新打开登录窗口');
  if (action === '核对已保存文件' && [-9, 12].includes(data.errno) && !data.vcode && !data.vcode_str && !data.authwidget) throw metadataNotReady('百度保存路径已返回，文件详情暂时不可见，正在继续核对');
  if (data.errno === -9) throw new BaiduUserError('百度分享已失效或提取码不正确');
  if ([-12, -20, 12, 20, 132].includes(data.errno) || data.vcode || data.vcode_str || data.authwidget) throw new BaiduUserError('百度要求验证，请在百度登录窗口完成验证后重试');
  if ([-10, -11, 110, 112].includes(data.errno)) throw new BaiduUserError(`${action}未完成，请检查百度网盘剩余空间`);
  throw new BaiduUserError(`${action}失败（百度返回 ${data.errno}），请在百度窗口核对后再重试`);
}

async function requestJson(request, method, address, options, action) {
  let response;
  try { response = await request[method](address, options); } catch { throw new BaiduUserError(`${action}请求未能确认，请在百度窗口核对后再重试`); }
  if (typeof response.ok === 'function' && !response.ok()) throw new BaiduUserError(`${action}请求未能完成，请稍后重试`);
  let data;
  try { data = await response.json(); } catch { throw new BaiduUserError(`${action}未返回有效结果，请在百度登录窗口检查登录或验证状态`); }
  try { checkReply(data, action); }
  catch (error) {
    if (Number.isInteger(data?.errno)) error.baiduErrno = data.errno;
    throw error;
  }
  return data;
}

async function requestPage(request, address) {
  let response;
  try { response = await request.get(address, { timeout: 25000 }); } catch { throw new BaiduUserError('无法读取百度页面，请稍后重试'); }
  if (typeof response.ok === 'function' && !response.ok()) throw new BaiduUserError('无法读取百度页面，请稍后重试');
  if (typeof response.url === 'function') {
    try {
      const url = new URL(response.url());
      if (url.protocol !== 'https:' || url.hostname !== 'pan.baidu.com') throw new Error('outside-pan');
    } catch { throw new BaiduUserError('百度页面跳转至登录或验证页面，请重新打开登录窗口'); }
  }
  try { return await response.text(); } catch { throw new BaiduUserError('百度页面内容未能读取，请稍后重试'); }
}

async function session(context) {
  const cookies = await context.cookies('https://pan.baidu.com');
  if (!cookies.some((cookie) => cookie.name === 'BDUSS' && cookie.value)) throw new BaiduUserError('请先在百度登录窗口登录自己的账号');
  return { logid: Buffer.from(cookies.find((cookie) => cookie.name === 'BAIDUID')?.value || '').toString('base64') };
}

function shareIds(html) {
  const field = (names) => {
    for (const name of names) {
      const match = new RegExp(`["']?${name}["']?\\s*[:=]\\s*["']?(\\d+)`, 'i').exec(html);
      if (match) return match[1];
    }
    return '';
  };
  return { shareid: field(['shareid', 'share_id']), uk: field(['share_uk', 'shareuk']) };
}

function fileId(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return '';
  if (!['number', 'string'].includes(typeof value)) return '';
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) return '';
  return text;
}

function savedPath(value) {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/') || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) return '';
  if (value.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) return '';
  return value;
}

function transferEntries(data) {
  const raw = data.extra?.list ?? data.list;
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw.map((item) => {
    const path = savedPath(item?.to);
    if (!path || (item.errno !== undefined && item.errno !== 0)) throw new BaiduUserError('百度保存清单异常，未自动分享，请在网盘核对');
    const fsId = fileId(item.to_fs_id);
    if (item.to_fs_id !== undefined && !fsId) throw new BaiduUserError('百度保存文件编号异常，未自动分享');
    return { path, name: path.split('/').pop(), ...(fsId ? { fsId } : {}) };
  });
}

export function browserTransferResult(data) {
  checkReply(data, '转存');
  const files = transferEntries(data);
  if (files.length) return { kind: 'saved', files, folder: '/' };
  const taskId = fileId(data.taskid || data.task_id);
  if (taskId) return { kind: 'submitted', taskId, folder: '/' };
  throw new BaiduUserError('百度未返回保存清单，请先在网盘根目录核对，再决定是否重试');
}

async function diskToken(context) {
  const html = await requestPage(context.request, 'https://pan.baidu.com/disk/main');
  const plain = html.replace(/\\"/g, '"').replace(/&quot;|&#34;/gi, '"').replace(/&#39;/gi, "'");
  if (/isLogin["']?\s*[:=]\s*["']?0\b/i.test(plain)) throw new BaiduUserError('百度登录已失效，请重新打开登录窗口');
  const match = /(?:bdstoken|MYBDSTOKEN)["']?\s*[:=]\s*["']([a-f0-9]{32})["']/i.exec(plain);
  if (match) return match[1];
  const data = await requestJson(context.request, 'get', apiUrl('/api/gettemplatevariable', { fields: '["bdstoken"]' }), { headers: diskHeaders, timeout: 25000 }, '读取百度分享会话');
  const token = data.result?.bdstoken;
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/i.test(token)) throw new BaiduUserError('未能确认百度分享会话，请重新在百度窗口登录或完成验证');
  return token;
}

// Resolve only the exact paths reported by this transfer, never a root listing.
export async function confirmBaiduSavedFiles(context, files, { sourceIds = [], expectedCount = files?.length } = {}) {
  if (!Array.isArray(files) || !files.length || files.length !== expectedCount) throw new BaiduUserError('本次转存保存清单不完整，未自动分享，请先在百度窗口核对');
  const paths = files.map((file) => savedPath(file?.path));
  if (paths.some((item) => !item) || new Set(paths).size !== paths.length) throw new BaiduUserError('本次转存目的路径不明确，未自动分享');
  const confirmed = [];
  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100);
    const data = await requestJson(context.request, 'get', apiUrl('/api/filemetas', { target: JSON.stringify(batch), dlink: '0' }), { headers: diskHeaders, timeout: 25000 }, '核对已保存文件');
    if (!Array.isArray(data.info)) throw new BaiduUserError('百度未返回当前账号的文件详情，未自动分享');
    for (const path of batch) {
      const matches = data.info.filter((file) => file.path === path && (file.errno === undefined || file.errno === 0));
      if (!matches.length) throw metadataNotReady('未能在当前百度账号确认本次保存的文件，正在继续核对');
      if (matches.length !== 1) throw new BaiduUserError('百度目的路径返回多个文件，未自动分享');
      const item = matches[0];
      const fsId = fileId(item.fs_id);
      const reported = files.find((file) => file.path === path);
      if (!fsId || sourceIds.map(String).includes(fsId) || (reported.fsId && String(reported.fsId) !== fsId)) throw new BaiduUserError('已保存文件编号与当前账号核对不一致，未自动分享');
      confirmed.push({ fsId, path, name: String(item.server_filename || path.split('/').pop()), isdir: Number(item.isdir) === 1 ? 1 : 0 });
    }
  }
  if (new Set(confirmed.map((file) => file.fsId)).size !== confirmed.length) throw new BaiduUserError('本次保存的文件编号重复，未自动分享');
  return confirmed;
}

// Protocol reference: https://github.com/Youwillrememberme/bdcli (MIT).
// Credentials and bdstoken stay within this module and the browser profile.
export async function transferToBaiduRoot(context, input) {
  let transferStarted = false;
  try {
  const share = baiduShareInput(input?.url, input?.code);
  if (!share) throw new BaiduUserError('仅支持有效的百度网盘分享链接');
  const { logid } = await session(context);
  const request = context.request;
  const headers = { Referer: share.url, 'X-Requested-With': 'XMLHttpRequest' };
  let html = await requestPage(request, share.url);
  const rawSurl = new URL(share.url).pathname.split('/').pop();
  const surl = rawSurl.startsWith('1') ? rawSurl.slice(1) : rawSurl;
  let sekey = '';
  if (share.code) {
    const data = await requestJson(request, 'post', apiUrl('/share/verify', { surl, t: String(Date.now()), logid }), { form: { pwd: share.code, vcode: '', vcode_str: '' }, headers, timeout: 25000 }, '提取码验证');
    try { sekey = decodeURIComponent(data.randsk || ''); } catch { throw new BaiduUserError('百度提取码验证返回异常'); }
    html = await requestPage(request, share.url);
  }
  const ids = shareIds(html);
  if (!ids.shareid || !ids.uk) throw new BaiduUserError('未能读取百度分享信息，请在登录窗口检查分享是否有效或需要验证');
  if (!sekey) {
    const cookies = await context.cookies('https://pan.baidu.com');
    try { sekey = decodeURIComponent(cookies.find((cookie) => cookie.name === 'BDCLND')?.value || ''); } catch { throw new BaiduUserError('百度分享验证状态异常，请重新打开分享'); }
  }
  const sourceIds = [];
  for (let page = 1; page <= 50; page += 1) {
    const data = await requestJson(request, 'get', apiUrl('/share/list', { ...ids, sekey, root: '1', type: '0', page: String(page), num: '100', order: 'other', desc: '1' }), { headers, timeout: 25000 }, '读取分享文件');
    if (!Array.isArray(data.list)) throw new BaiduUserError('百度分享文件列表返回异常');
    for (const file of data.list) {
      const id = fileId(file.fs_id);
      if (!id) throw new BaiduUserError('百度分享文件编号异常');
      sourceIds.push(id);
    }
    if (data.list.length < 100) break;
    if (page === 50) throw new BaiduUserError('分享根目录条目过多，请先在百度网页选择需要的文件');
  }
  const uniqueSourceIds = [...new Set(sourceIds)];
  if (!uniqueSourceIds.length) throw new BaiduUserError('百度分享中没有可保存的文件');
  transferStarted = true;
  const data = await requestJson(request, 'post', apiUrl('/share/transfer', { shareid: ids.shareid, from: ids.uk, sekey, bdstoken: '', ondup: 'newcopy' }), { form: { path: '/', async: '2', type: '0', fsidlist: JSON.stringify(uniqueSourceIds.map(Number)) }, headers, timeout: 90000 }, '转存');
  const result = browserTransferResult(data);
  const transferContext = { shareid: ids.shareid, from: ids.uk, referer: share.url, sourceIds: uniqueSourceIds, expectedCount: uniqueSourceIds.length };
  const taskId = fileId(data.taskid || data.task_id);
  if (result.kind === 'submitted' || (taskId && result.files.length !== uniqueSourceIds.length)) return { kind: 'submitted', taskId: taskId || result.taskId, folder: '/', transferContext };
  try {
    const files = await confirmBaiduSavedFiles(context, result.files, transferContext);
    return { kind: 'saved', files, folder: '/', confirmed: true };
  } catch (error) {
    return { kind: 'pending', files: result.files, folder: '/', transferContext, verificationPending: true, verificationMessage: error instanceof BaiduUserError ? error.message : '保存路径已返回，正在等待核对文件详情' };
  }
  } catch (error) {
    const failure = error instanceof BaiduUserError ? error : new BaiduUserError('百度转存未能确认，请在百度窗口核对');
    failure.transferStarted = transferStarted;
    throw failure;
  }
}

async function waitForMetadata(context, result, { timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let first = true;
  while (first || Date.now() < deadline) {
    first = false;
    try {
      const files = await confirmBaiduSavedFiles(context, result.files, result.transferContext);
      return { kind: 'saved', files, folder: '/', confirmed: true, ...(result.taskId ? { taskId: result.taskId } : {}) };
    } catch (error) {
      if (!error.metadataNotReady) throw error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  return { ...result, kind: 'pending', pending: true };
}

export async function waitForBaiduTransfer(context, result, { timeoutMs = 60000, pollIntervalMs = 1500 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 10000) throw new BaiduUserError('转存等待参数无效');
  if (result?.kind === 'saved' && result.confirmed) return result;
  if (result?.kind === 'pending' && result.verificationPending && Array.isArray(result.files)) {
    await session(context);
    return waitForMetadata(context, result, { timeoutMs, pollIntervalMs });
  }
  const taskId = fileId(result?.taskId);
  const transfer = result?.transferContext;
  if (!taskId || !fileId(transfer?.shareid) || !fileId(transfer?.from) || !Array.isArray(transfer?.sourceIds) || !Number.isInteger(transfer?.expectedCount) || transfer.expectedCount < 1) throw new BaiduUserError('缺少本次转存任务的确认信息，请在网盘核对，勿重复转存');
  await session(context);
  const token = await diskToken(context);
  const deadline = Date.now() + timeoutMs;
  let first = true;
  while (first || Date.now() < deadline) {
    first = false;
    const data = await requestJson(context.request, 'get', apiUrl('/share/taskquery', { taskid: taskId, shareid: transfer.shareid, from: transfer.from, bdstoken: token }), { headers: { ...diskHeaders, Referer: baiduShareInput(transfer.referer)?.url || diskHeaders.Referer }, timeout: 25000 }, '确认百度转存任务');
    if (data.task_errno !== undefined && data.task_errno !== 0) checkReply({ ...data, errno: data.task_errno }, '百度转存任务');
    if (data.status === 'failed') throw new BaiduUserError('百度转存任务失败，未自动分享，请在百度窗口核对');
    if (data.status === 'success') {
      const candidate = { kind: 'pending', files: transferEntries(data), folder: '/', taskId, transferContext: transfer, verificationPending: true };
      return waitForMetadata(context, candidate, { timeoutMs: Math.max(0, deadline - Date.now()), pollIntervalMs });
    }
    if (!['pending', 'running'].includes(data.status)) throw new BaiduUserError('百度转存任务状态未知，未自动分享，请在百度窗口核对');
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  return { ...result, kind: 'submitted', pending: true };
}

function officialShareLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'pan.baidu.com' || url.username || url.password || url.port || !/^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return '';
    return `https://pan.baidu.com${url.pathname.replace(/\/$/, '')}`;
  } catch { return ''; }
}

export async function createBaiduShare(context, savedFiles, { period = 7, accessCode = '', onBeforeShare, onShareCreated, existingShare } = {}) {
  if (!Array.isArray(savedFiles) || !savedFiles.length || savedFiles.some((file) => !fileId(file?.fsId) || !savedPath(file?.path))) throw new BaiduUserError('只能分享本次确认保存的文件，不能使用来源编号或根目录');
  if (![0, 1, 7, 30].includes(period)) throw new BaiduUserError('分享有效期只能为永久、1 天、7 天或 30 天');
  if (accessCode && !/^[A-Za-z0-9]{4}$/.test(accessCode)) throw new BaiduUserError('分享提取码须为 4 位英文字母或数字');
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const code = accessCode || Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const { logid } = await session(context);
  const files = await confirmBaiduSavedFiles(context, savedFiles);
  let shareUrl;
  let shareCode = code;
  if (existingShare) {
    shareUrl = officialShareLink(existingShare.shareUrl);
    shareCode = existingShare.accessCode;
    if (!shareUrl || !/^[A-Za-z0-9]{4}$/.test(shareCode)) throw new BaiduUserError('已创建分享的本机记录不完整，请在百度窗口核对');
  } else {
    const token = await diskToken(context);
    if (onBeforeShare) await onBeforeShare();
    const data = await requestJson(context.request, 'post', apiUrl('/share/set', { bdstoken: token, logid }), { form: { fid_list: JSON.stringify(files.map((file) => Number(file.fsId))), schannel: '4', channel_list: '[]', period: String(period), pwd: code, eflag_disable: 'true' }, headers: diskHeaders, timeout: 30000 }, '创建百度分享');
    shareUrl = officialShareLink(data.link || data.shorturl);
    if (!shareUrl || (data.pwd !== undefined && data.pwd !== code)) throw new BaiduUserError('百度分享已提交，但返回链接或提取码未能确认，请在百度窗口核对，勿重复创建');
    if (onShareCreated) await onShareCreated({ shareUrl, accessCode: code, period });
  }
  await requestPage(context.request, shareUrl);
  const surl = new URL(shareUrl).pathname.split('/').pop().replace(/^1/, '');
  const headers = { Referer: shareUrl, 'X-Requested-With': 'XMLHttpRequest' };
  const verified = await requestJson(context.request, 'post', apiUrl('/share/verify', { surl, t: String(Date.now()), logid }), { form: { pwd: shareCode, vcode: '', vcode_str: '' }, headers, timeout: 25000 }, '核对自己的分享提取码');
  let sekey;
  try { sekey = decodeURIComponent(verified.randsk || ''); } catch { throw new BaiduUserError('自己的分享验证结果异常，请在百度窗口核对'); }
  const ids = shareIds(await requestPage(context.request, shareUrl));
  if (!ids.shareid || !ids.uk) throw new BaiduUserError('分享已创建，但未能核对分享内容，请在百度窗口检查');
  const sharedIds = [];
  for (let page = 1; page <= Math.ceil(files.length / 100) + 1; page += 1) {
    const listing = await requestJson(context.request, 'get', apiUrl('/share/list', { ...ids, sekey, root: '1', page: String(page), num: '100' }), { headers, timeout: 25000 }, '核对自己的分享文件');
    if (!Array.isArray(listing.list)) throw new BaiduUserError('分享已创建，但文件清单未能核对，请在百度窗口检查');
    for (const file of listing.list) {
      const id = fileId(file.fs_id);
      if (!id) throw new BaiduUserError('分享文件编号异常，未作为可发布链接返回');
      sharedIds.push(id);
    }
    if (listing.list.length < 100) break;
  }
  const expected = files.map((file) => file.fsId).sort();
  if (sharedIds.length !== expected.length || sharedIds.sort().some((id, index) => id !== expected[index])) throw new BaiduUserError('自己的分享内容与本次保存清单不一致，未作为可发布链接返回');
  return { shareUrl, accessCode: shareCode, files, verified: true, period: existingShare?.period ?? period };
}
