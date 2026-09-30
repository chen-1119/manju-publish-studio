import { shareLinkWithCode } from './publish-core.js';
const $ = (selector) => document.querySelector(selector);
const recentKey = 'manju-publish-studio:pipeline-job:v1';
let activeJob = null;
let selectedResource = null;
let pollTimer = null;
let watchSequence = 0;
let editorVersion = 0;
let requestedVersion = 0;
let starting = false;
for (const selector of ['#publishing-form', '#publishing-output-title', '#publishing-output-body']) {
  $(selector).addEventListener('input', () => { editorVersion += 1; });
}
document.addEventListener('publishing:select', () => { editorVersion += 1; });
$('#publishing-section').addEventListener('change', () => { editorVersion += 1; });
for (const selector of ['#publishing-load', '#publishing-generate', '#publishing-clear-artwork', '#publishing-titles']) {
  $(selector).addEventListener('click', () => { editorVersion += 1; });
}

function showStatus(text) { $('#pipeline-status').textContent = text; }
function openResult() {
  if (activeJob?.status !== 'completed' || !activeJob.result) return;
  document.dispatchEvent(new CustomEvent('publishing:ready', { detail: activeJob }));
}
function render(job) {
  activeJob = job;
  $('#pipeline-panel').hidden = false;
  $('#pipeline-title').textContent = job.input?.resource?.title || '自动生成发布素材';
  $('#pipeline-stages').replaceChildren(...(job.stages || []).map((stage, index) => {
    const item = document.createElement('li');
    item.dataset.state = stage.status;
    item.textContent = `${String(index + 1).padStart(2, '0')}  ${stage.label}`;
    return item;
  }));
  $('#pipeline-retry').hidden = !job.canRetry;
  $('#pipeline-retry').disabled = false;
  $('#pipeline-open-result').hidden = job.status !== 'completed';
  const messages = {
    transferring: '正在保存到自己的百度网盘…', waiting: '百度正在处理转存任务，完成后自动继续。',
    sharing: '转存已完成，正在为本次保存的文件创建自己的分享链接…',
    generating: '自己的分享已创建，正在生成贴吧标题与正文…',
    completed: '自己的分享链接、3个标题和贴吧正文已生成。',
  };
  showStatus(job.error || (job.status === 'waiting' && job.canRetry ? '尚未确认转存完成，点击“继续任务”接着核对，工具不会重新保存。' : messages[job.status]) || '正在准备任务…');
  const link = $('#pipeline-own-link');
  link.hidden = true;
  try {
    const url = new URL(shareLinkWithCode(job.ownShare?.url || job.ownShare?.shareUrl || '', job.ownShare?.accessCode));
    if (job.status === 'completed' && url.protocol === 'https:' && url.hostname === 'pan.baidu.com') {
      link.href = url.href;
      link.textContent = '打开自己的分享（已带提取码） ↗';
      link.hidden = false;
    }
  } catch { /* Own link is available only after the verified share step. */ }
}
async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '任务暂时无法读取'); error.status = response.status; throw error; }
  return data;
}
function remember(id) { try { localStorage.setItem(recentKey, id); } catch {} }
function watch(id, autoOpen = false) {
  const sequence = ++watchSequence;
  clearTimeout(pollTimer);
  let failures = 0;
  const poll = async () => {
    try {
      const job = await request(`/api/publishing/jobs/${encodeURIComponent(id)}`);
      if (sequence !== watchSequence) return;
      failures = 0;
      render(job);
      if (job.status === 'completed') {
        if (autoOpen && editorVersion === requestedVersion) openResult();
        else if (autoOpen) showStatus('素材已生成。你正在编辑的内容已保留，点击“打开已生成素材”查看。');
        return;
      }
      if ((job.status === 'failed' && !job.active) || job.canRetry) return;
      pollTimer = setTimeout(poll, 1600);
    } catch (error) {
      if (sequence !== watchSequence) return;
      showStatus(error.message);
      if (error.status === 404 || ++failures >= 5) {
        $('#pipeline-retry').hidden = error.status === 404;
        return;
      }
      pollTimer = setTimeout(poll, 3000);
    }
  };
  void poll();
}
async function start(resource) {
  if (starting) return;
  starting = true;
  selectedResource = resource;
  activeJob = null;
  watchSequence += 1;
  clearTimeout(pollTimer);
  requestedVersion = editorVersion;
  $('#pipeline-panel').hidden = false;
  $('#pipeline-title').textContent = resource.title || '自动生成发布素材';
  $('#pipeline-stages').replaceChildren();
  $('#pipeline-retry').hidden = true;
  $('#pipeline-own-link').hidden = true;
  $('#pipeline-open-result').hidden = true;
  $('#publishing-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showStatus('正在启动：转存 → 自有分享 → 文案生成…');
  try {
    const job = await request('/api/publishing/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: Array.from(resource.searchKeyword || resource.title || '').slice(0, 100).join(''), resource: {
        title: Array.from(resource.title || '').slice(0, 80).join(''), shareUrl: resource.shareUrl, accessCode: resource.accessCode || '',
        platform: resource.platform, direct: resource.direct,
      }, targetBar: $('#publishing-target-bar').value.trim() || 'AI漫剧吧' }),
    });
    render(job);
    remember(job.id);
    watch(job.id, true);
  } catch (error) {
    showStatus(error.message);
    $('#pipeline-retry').hidden = false;
    if (error.status === 401) $('#baidu-login-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally { starting = false; }
}
document.addEventListener('pipeline:start', (event) => { if (event.detail) void start(event.detail); });
$('#pipeline-open-result').addEventListener('click', openResult);
$('#pipeline-retry').addEventListener('click', async () => {
  if (!activeJob) { if (selectedResource) await start(selectedResource); return; }
  $('#pipeline-retry').disabled = true;
  requestedVersion = editorVersion;
  try {
    const job = await request(`/api/publishing/jobs/${encodeURIComponent(activeJob.id)}/retry`, { method: 'POST' });
    render(job);
    watch(job.id, true);
  } catch (error) { showStatus(error.message); $('#pipeline-retry').disabled = false; }
});
try {
  const id = localStorage.getItem(recentKey);
  if (id) watch(id, false);
} catch { /* The workflow also works without browser storage. */ }
