import { generatePublishingPack, normalizePublishingKeywords, shareLinkWithCode } from './publish-core.js';
import { renderPublishingPoster } from './publish-poster.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#publishing-form');
const storageKey = 'manju-publish-studio:publishing-draft:v1';
const fields = ['title', 'mode', 'synopsis', 'genre', 'episodes', 'completion', 'keywords', 'ownShareUrl', 'ownAccessCode', 'targetBar', 'tone'];
const sessionDrafts = new Map();
let activeKey = 'manual';
let reference = null;
let pack = null;
let artwork = null;
let stale = false;
let renderSequence = 0;
let artworkSequence = 0;
let graphicsReady = false;

function message(text) { $('#publishing-status').textContent = text; }
function rawInput() { return Object.fromEntries(fields.map((key) => [key, form.elements[key].value.trim()])); }
function setInput(raw = {}) {
  form.reset();
  for (const key of fields) if (typeof raw[key] === 'string') form.elements[key].value = raw[key].slice(0, form.elements[key].maxLength > 0 ? form.elements[key].maxLength : 1200);
  if (!raw.keywords) form.elements.keywords.value = normalizePublishingKeywords(undefined, { ...raw, genre: '' });
  if (raw.ownShareUrl) {
    try {
      const link = shareLinkWithCode(raw.ownShareUrl, raw.ownAccessCode);
      form.elements.ownShareUrl.value = link;
      form.elements.ownAccessCode.value = new URL(link).searchParams.get('pwd') || '';
    } catch { /* Keep invalid drafts editable for correction. */ }
  }
}
function updateActions() {
  document.querySelectorAll('[data-pack-action]').forEach((button) => { button.disabled = !pack || stale; });
  for (const id of ['cover', 'directory']) $(`#publishing-download-${id}`).disabled = !pack || stale || !graphicsReady;
  $('#publishing-stale').hidden = !stale;
}
function snapshot() {
  return { version: 2, input: rawInput(), theme: $('#publishing-theme').value, reference, pack: pack ? { input: pack.input, title: $('#publishing-output-title').value, body: $('#publishing-output-body').value, warnings: pack.warnings } : null, stale };
}
function showReference() {
  $('#publishing-reference').hidden = !reference;
  $('#publishing-reference-title').textContent = reference?.title || '';
  $('#publishing-reference-description').textContent = reference?.description || '资源名称来自搜索结果，介绍和集数请核对后填写。';
  const link = $('#publishing-reference-link');
  link.hidden = true;
  if (reference?.url) {
    try {
      const url = new URL(reference.url);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) { link.href = url.href; link.hidden = false; }
    } catch { /* A reference is optional and never enters the post. */ }
  }
}

function populatePack(generated, edited = null) {
  pack = generated;
  stale = false;
  form.elements.ownShareUrl.value = generated.input.ownShareUrl;
  form.elements.ownAccessCode.value = generated.input.ownAccessCode;
  form.elements.keywords.value = generated.input.keywords;
  $('#publishing-empty').hidden = true;
  $('#publishing-pack').hidden = false;
  $('#publishing-output-title').value = typeof edited?.title === 'string' ? edited.title.slice(0, 160) : generated.titles[0];
  $('#publishing-output-body').value = typeof edited?.body === 'string' ? edited.body.slice(0, 12000) : generated.body;
  $('#publishing-text-prompt').value = generated.textPrompt;
  $('#publishing-image-prompt').value = generated.imagePrompt;
  $('#publishing-warnings').hidden = !generated.warnings.length;
  $('#publishing-warnings').textContent = generated.warnings.join('；');
  $('#publishing-titles').replaceChildren(...generated.titles.map((title, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${String(index + 1).padStart(2, '0')}  ${title}`;
    button.addEventListener('click', () => { $('#publishing-output-title').value = title; message('已选择标题，可继续修改正文。'); });
    return button;
  }));
  updateActions();
}

async function renderGraphics() {
  if (!pack || stale) return;
  const sequence = ++renderSequence;
  graphicsReady = false;
  updateActions();
  if (!$('#publishing-optional-images').open && !artwork) {
    $('#publishing-image-status').textContent = '图片为可选项，没有图片也可直接复制文案发布。';
    return;
  }
  const input = pack.input;
  const theme = $('#publishing-theme').value;
  const selectedArtwork = artwork;
  const cover = document.createElement('canvas');
  const directory = document.createElement('canvas');
  try {
    await Promise.all([
      renderPublishingPoster(cover, input, { kind: 'cover', theme, artwork: selectedArtwork }),
      renderPublishingPoster(directory, input, { kind: 'directory', theme }),
    ]);
    if (sequence !== renderSequence || stale) return;
    for (const [id, rendered] of [['cover', cover], ['directory', directory]]) {
      const canvas = $(`#publishing-${id}`);
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      canvas.getContext('2d').drawImage(rendered, 0, 0);
    }
    graphicsReady = true;
    $('#publishing-image-status').textContent = selectedArtwork ? '封面使用你上传的图片，关键词图按内容关键词排版。图片仅在本机使用。' : '配图使用抽象图形与关键词排版。没有图片也可直接发布文案。';
  } catch {
    if (sequence === renderSequence) $('#publishing-image-status').textContent = '图片预览生成失败，请重新生成或更换上传图片。';
  }
  if (sequence === renderSequence) updateActions();
}

async function restore(state, selectedArtwork = null) {
  renderSequence += 1;
  artworkSequence += 1;
  graphicsReady = false;
  pack = null;
  stale = false;
  artwork = selectedArtwork;
  $('#publishing-artwork').value = '';
  $('#publishing-clear-artwork').hidden = !artwork;
  setInput(state.input);
  reference = state.reference && typeof state.reference === 'object' ? state.reference : null;
  showReference();
  $('#publishing-theme').value = ['forest', 'ink', 'paper'].includes(state.theme) ? state.theme : 'forest';
  $('#publishing-pack').hidden = true;
  $('#publishing-empty').hidden = false;
  if (state.pack) {
    try {
      const generated = generatePublishingPack(state.pack.input || state.input);
      if (state.version === 2 && Array.isArray(state.pack.warnings)) generated.warnings = state.pack.warnings.filter((value) => typeof value === 'string').slice(0, 10).map((value) => value.slice(0, 500));
      populatePack(generated, state.pack);
      stale = Boolean(state.stale) || !state.pack.input?.keywords;
      await renderGraphics();
    } catch { message('草稿资料尚未完整，请补充后生成。'); }
  }
  updateActions();
}

function openEditor() {
  $('#publishing-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#publishing-open').addEventListener('click', () => { openEditor(); form.elements.title.focus({ preventScroll: true }); });
document.addEventListener('publishing:select', async (event) => {
  const result = event.detail;
  if (!result || typeof result.title !== 'string') return;
  const key = result.shareUrl || result.sourceUrl || result.title;
  if (activeKey !== key) {
    sessionDrafts.set(activeKey, { state: snapshot(), artwork });
    activeKey = key;
    const existing = sessionDrafts.get(key);
    if (existing) await restore(existing.state, existing.artwork);
    else {
      await restore({
        input: { title: result.title.slice(0, 80), mode: 'works' },
        reference: { title: result.title.slice(0, 200), description: String(result.description || '').slice(0, 1200), url: result.shareUrl || result.sourceUrl || '' },
      });
    }
    message('已带入资源名称。请核对作品介绍、更新集数，并填入自己的分享链接。切换资源时会保留本次打开的草稿。');
  }
  openEditor();
  form.elements.synopsis.focus({ preventScroll: true });
});

document.addEventListener('publishing:ready', async (event) => {
  const job = event.detail;
  if (job?.status !== 'completed' || !job.result?.input || !job.ownShare) return;
  const key = `pipeline:${job.id}`;
  if (activeKey === key && pack) { openEditor(); return; }
  sessionDrafts.set(activeKey, { state: snapshot(), artwork });
  activeKey = key;
  const existing = sessionDrafts.get(key);
  if (existing) await restore(existing.state, existing.artwork);
  else {
    const input = job.result.input;
    await restore({ input, reference: { title: job.input?.resource?.title || input.title,
      description: '已确认本次转存完成，领取链接由你的百度网盘账号创建。介绍、集数和完结状态可继续补充。',
      url: job.input?.resource?.shareUrl || '' }, version: 2, pack: { input, warnings: job.result.pack?.warnings } });
  }
  openEditor();
  message('自动流程已完成：带提取码的分享链接与关键词文案已就绪，可修改、复制或下载。图片可按需添加。');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const generated = generatePublishingPack(rawInput());
    populatePack(generated);
    message('已生成 3 个标题和关键词正文，领取链接已带提取码。');
    await renderGraphics();
    if (!stale) message(graphicsReady ? '文案与可选配图已就绪，可复制或下载。' : '文案已就绪，可直接复制或下载；图片为可选项。');
  } catch (error) { message(error.message || '请补充资源信息后重试。'); }
});
form.addEventListener('input', () => {
  if (!pack) return;
  stale = true;
  renderSequence += 1;
  updateActions();
});

async function copyText(value) {
  try { await navigator.clipboard.writeText(value); message('已复制到剪贴板。'); }
  catch { message('浏览器未允许复制，请在文案框中全选并复制。'); }
}
function documentText() { return `${$('#publishing-output-title').value.trim()}\n\n${$('#publishing-output-body').value.trim()}`; }
function filename(suffix) { return `${(pack?.input.title || '发布素材').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 55)}-${suffix}`; }
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  message('已准备下载，请查看浏览器的下载列表。');
}
$('#publishing-copy').addEventListener('click', () => copyText(documentText()));
$('#publishing-download-text').addEventListener('click', () => downloadBlob(new Blob(['\ufeff', documentText()], { type: 'text/plain;charset=utf-8' }), filename('贴吧文案.txt')));
$('#publishing-download-pack').addEventListener('click', () => {
  const output = { version: 2, generatedBy: 'local-template', input: pack.input, titles: pack.titles, selectedTitle: $('#publishing-output-title').value, body: $('#publishing-output-body').value, textPrompt: pack.textPrompt, imagePrompt: pack.imagePrompt, theme: $('#publishing-theme').value, warnings: pack.warnings, graphics: graphicsReady ? { cover: filename('封面.png'), keywords: filename('关键词.png'), size: '1200x900', uploadedArtworkIncluded: Boolean(artwork) } : null };
  downloadBlob(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json;charset=utf-8' }), filename('素材清单.json'));
});
for (const kind of ['cover', 'directory']) $(`#publishing-download-${kind}`).addEventListener('click', () => {
  const name = filename(kind === 'cover' ? '封面.png' : '关键词.png');
  $(`#publishing-${kind}`).toBlob((blob) => {
    if (blob) downloadBlob(blob, name);
    else message('图片下载准备失败，请重新生成。');
  }, 'image/png');
});
$('#publishing-copy-text-prompt').addEventListener('click', () => copyText($('#publishing-text-prompt').value));
$('#publishing-copy-image-prompt').addEventListener('click', () => copyText($('#publishing-image-prompt').value));
$('#publishing-theme').addEventListener('change', renderGraphics);
$('#publishing-optional-images').addEventListener('toggle', () => { if ($('#publishing-optional-images').open) void renderGraphics(); });
$('#publishing-clear-artwork').addEventListener('click', async () => {
  artworkSequence += 1;
  artwork = null;
  $('#publishing-artwork').value = '';
  $('#publishing-clear-artwork').hidden = true;
  await renderGraphics();
});
$('#publishing-artwork').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const sequence = ++artworkSequence;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('请选择 8 MB 以内的 PNG、JPG 或 WebP 图片。');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('图片无法读取，请重新选择。'));
      reader.readAsDataURL(file);
    });
    const image = new Image();
    image.src = data;
    await image.decode();
    if (sequence !== artworkSequence) return;
    if (image.naturalWidth * image.naturalHeight > 40000000) throw new Error('图片尺寸过大，请缩小到 4000 万像素以内。');
    artwork = image;
    $('#publishing-clear-artwork').hidden = false;
    await renderGraphics();
  } catch (error) {
    if (sequence === artworkSequence) { event.target.value = ''; $('#publishing-image-status').textContent = error.message || '图片无法读取。'; }
  }
});

$('#publishing-save').addEventListener('click', () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(snapshot()));
    message(artwork ? '草稿已保存在当前浏览器。上传的图片未保存，恢复后请重新选择图片。' : '草稿已保存在当前浏览器，可用“恢复上次草稿”继续编辑。');
  } catch { message('浏览器未能保存草稿。可先下载文案或素材清单。'); }
});
$('#publishing-load').addEventListener('click', async () => {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return message('当前浏览器还没有保存过草稿。');
    const state = JSON.parse(saved);
    if (![1, 2].includes(state.version) || !state.input || typeof state.input !== 'object') throw new Error('invalid-draft');
    sessionDrafts.set(activeKey, { state: snapshot(), artwork });
    activeKey = 'saved';
    await restore(state);
    message(stale ? '已保留旧版草稿内容，请重新生成以使用带码链接和关键词文案。' : '已恢复本机草稿。若此前上传过图片，请重新选择图片。');
  } catch { message('草稿无法恢复，请重新填写或使用已下载的素材。'); }
});
updateActions();
for (const id of ['open', 'generate', 'save', 'load']) $(`#publishing-${id}`).disabled = false;
