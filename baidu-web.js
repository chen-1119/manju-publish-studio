import { baiduShareInput } from './baidu.js';

export class BaiduUserError extends Error {}

const channel = { channel: 'chunlei', clienttype: '0', web: '1', app_id: '250528' };
const apiUrl = (route, params = {}) => `https://pan.baidu.com${route}?${new URLSearchParams({ ...channel, ...params })}`;

function checkReply(data, action) {
  if (data.errno === 0) return;
  if ([-6, -100, 111].includes(data.errno)) throw new BaiduUserError('百度登录已失效，请重新打开登录窗口');
  if ([-9].includes(data.errno)) throw new BaiduUserError('百度分享提取码不正确');
  if ([-12, -20, 12, 20].includes(data.errno) || data.vcode || data.vcode_str) {
    throw new BaiduUserError('百度要求验证，请在百度登录窗口完成验证后重试');
  }
  throw new BaiduUserError(`${action}失败（百度返回 ${Number(data.errno)}），请检查分享有效性与网盘空间`);
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

export function browserTransferResult(data) {
  checkReply(data, '转存');
  const files = (data.extra?.list || []).filter((item) => typeof item.to === 'string' && item.to.startsWith('/'))
    .map((item) => ({ path: item.to, name: item.to.split('/').pop() }));
  if (files.length) return { kind: 'saved', files, folder: '/' };
  const taskId = data.taskid || data.task_id;
  if (taskId) return { kind: 'submitted', taskId: String(taskId), folder: '/' };
  throw new BaiduUserError('百度未返回保存清单，请先在网盘根目录核对，再决定是否重试');
}

// Protocol reference: https://github.com/Youwillrememberme/bdcli (MIT).
// All requests use the app's own browser profile; no cookies are returned to the UI.
export async function transferToBaiduRoot(context, input) {
  const share = baiduShareInput(input.url, input.code);
  if (!share) throw new BaiduUserError('仅支持有效的百度网盘分享链接');
  const cookies = await context.cookies('https://pan.baidu.com');
  const baiduId = cookies.find((cookie) => cookie.name === 'BAIDUID')?.value || '';
  if (!cookies.some((cookie) => cookie.name === 'BDUSS')) throw new BaiduUserError('请先在百度登录窗口登录自己的账号');
  const request = context.request;
  const headers = { Referer: share.url, 'X-Requested-With': 'XMLHttpRequest' };
  const getPage = async () => {
    const response = await request.get(share.url, { timeout: 25000 });
    if (!response.ok()) throw new BaiduUserError('无法读取百度分享，请稍后重试');
    return response.text();
  };
  let html = await getPage();
  const rawSurl = new URL(share.url).pathname.split('/').pop();
  const surl = rawSurl.startsWith('1') ? rawSurl.slice(1) : rawSurl;
  let sekey = '';
  if (share.code) {
    const response = await request.post(apiUrl('/share/verify', { surl, t: String(Date.now()),
      logid: Buffer.from(baiduId).toString('base64') }), {
      form: { pwd: share.code, vcode: '', vcode_str: '' }, headers, timeout: 25000,
    });
    const data = await response.json();
    checkReply(data, '提取码验证');
    try { sekey = decodeURIComponent(data.randsk || ''); } catch { throw new BaiduUserError('百度提取码验证返回异常'); }
    html = await getPage();
  }
  const ids = shareIds(html);
  if (!ids.shareid || !ids.uk) throw new BaiduUserError('未能读取百度分享信息，请在登录窗口检查分享是否有效或需要验证');
  if (!sekey) {
    const latestCookies = await context.cookies('https://pan.baidu.com');
    try { sekey = decodeURIComponent(latestCookies.find((cookie) => cookie.name === 'BDCLND')?.value || ''); } catch {}
  }
  const fileIds = [];
  for (let page = 1; page <= 50; page += 1) {
    const response = await request.get(apiUrl('/share/list', { ...ids, sekey, root: '1', type: '0',
      page: String(page), num: '100', order: 'other', desc: '1' }), { headers, timeout: 25000 });
    const data = await response.json();
    checkReply(data, '读取分享文件');
    if (!Array.isArray(data.list)) throw new BaiduUserError('百度分享文件列表返回异常');
    for (const file of data.list) {
      const id = Number(file.fs_id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new BaiduUserError('百度分享文件编号异常');
      fileIds.push(id);
    }
    if (data.list.length < 100) break;
    if (page === 50) throw new BaiduUserError('分享根目录条目过多，请先在百度网页选择需要的文件');
  }
  if (!fileIds.length) throw new BaiduUserError('百度分享中没有可保存的文件');
  const response = await request.post(apiUrl('/share/transfer', { shareid: ids.shareid, from: ids.uk,
    sekey, bdstoken: '', ondup: 'newcopy' }), {
    form: { path: '/', async: '2', type: '0', fsidlist: JSON.stringify([...new Set(fileIds)]) },
    headers, timeout: 90000,
  });
  return browserTransferResult(await response.json());
}
