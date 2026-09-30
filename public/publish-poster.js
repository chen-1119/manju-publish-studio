const WIDTH = 1200;
const HEIGHT = 900;
const SANS = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const SERIF = '"Songti SC", "SimSun", "Microsoft YaHei", serif';

const THEMES = {
  forest: { background: '#f4f1e4', ink: '#173d2a', muted: '#6b7a61', accent: '#d5ed77', panel: '#e4e9d1', line: '#cbd1bc', paper: '#fffdf4' },
  ink: { background: '#182427', ink: '#f4f0e4', muted: '#a9bcb0', accent: '#d5ed77', panel: '#2b3e3b', line: '#435a51', paper: '#21312e' },
  paper: { background: '#faf0e5', ink: '#432e25', muted: '#8c7160', accent: '#efb879', panel: '#efdfc8', line: '#dfcbb6', paper: '#fff9f0' },
};

function string(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function truncate(text, limit) {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, Math.max(0, limit - 1)).join('')}…` : text;
}

function displayText(value, secret = '') {
  let text = string(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s，。；、）)\]】]+/gi, '')
    .replace(/(?:pan|yun)\.baidu\.com[^\s，。；、）)\]】]*/gi, '')
    .replace(/(?:提取码|访问码|密码|access\s*code)\s*[:：]?\s*[a-z\d]{4,16}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (secret) text = text.split(secret).join('').replace(/\s+/g, ' ').trim();
  return text;
}

function normalize(input) {
  const data = input && typeof input === 'object' ? input : {};
  const secret = string(data.ownAccessCode).trim();
  const shareUrl = string(data.ownShareUrl).trim();
  const clean = (value) => displayText(shareUrl ? string(value).split(shareUrl).join('') : value, secret);
  const mode = data.mode === 'making' ? 'making' : 'works';
  const genre = truncate(clean(data.genre), 30);
  const source = Array.isArray(data.keywords) ? data.keywords : [data.keywords];
  let keywords = source.flatMap((item) => clean(item).split(/[\s,，、·#]+/u)).filter(Boolean);
  if (!keywords.length) keywords = ['AI漫剧', mode === 'making' ? '制作资料' : '作品资源', genre].filter(Boolean);
  const seen = new Set();
  keywords = keywords.map((item) => truncate(item, 20)).filter((item) => {
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
  const completion = data.completion === 'complete' ? '已完结' : data.completion === 'ongoing' ? '连载中' : '';
  const title = truncate(clean(data.title) || (mode === 'making' ? 'AI 漫剧制作资源' : 'AI 漫剧资源介绍'), 80);
  return {
    mode,
    hasShare: Boolean(shareUrl),
    title,
    synopsis: clean(data.synopsis),
    genre,
    episodes: truncate(clean(data.episodes), 36),
    completion,
    keywords,
    targetBar: truncate(clean(data.targetBar), 32),
  };
}

function font(ctx, size, weight = 400, family = SANS) {
  ctx.font = `${weight} ${size}px ${family}`;
}

function wrapped(ctx, text, width) {
  const lines = [];
  let line = '';
  for (const char of Array.from(text)) {
    if (line && ctx.measureText(line + char).width > width) {
      lines.push(line.trimEnd());
      line = char.trimStart();
    } else line += char;
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

function ellipsis(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  while (chars.length && ctx.measureText(`${chars.join('')}…`).width > width) chars.pop();
  return `${chars.join('')}…`;
}

function paragraph(ctx, text, x, y, width, { size = 25, lineHeight = 37, maxLines = 3, color, weight = 400 } = {}) {
  font(ctx, size, weight);
  if (color) ctx.fillStyle = color;
  const lines = wrapped(ctx, text, width);
  lines.slice(0, maxLines).forEach((line, index) => {
    const visible = index === maxLines - 1 && lines.length > maxLines
      ? ellipsis(ctx, `${line}…`, width) : line;
    ctx.fillText(visible, x, y + index * lineHeight);
  });
  return Math.min(lines.length, maxLines) * lineHeight;
}

function titleBlock(ctx, text, x, y, width, maxHeight, palette, initialSize = 76) {
  let size = initialSize;
  let lines;
  for (; size >= 18; size -= 1) {
    font(ctx, size, 700, SERIF);
    lines = wrapped(ctx, text, width);
    if (lines.length <= 3 && lines.length * size * 1.2 <= maxHeight) break;
  }
  ctx.fillStyle = palette.ink;
  lines.slice(0, 3).forEach((line, index) => ctx.fillText(line, x, y + index * size * 1.2));
  return lines.length * size * 1.2;
}

function rounded(ctx, x, y, width, height, radius = 16) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function chip(ctx, text, x, y, palette, accent = false, maxWidth = 650) {
  font(ctx, 20, 500);
  const visible = ellipsis(ctx, text, Math.max(0, maxWidth - 30));
  const width = Math.min(maxWidth, ctx.measureText(visible).width + 30);
  rounded(ctx, x, y, width, 39, 19.5);
  ctx.fillStyle = accent ? palette.accent : palette.panel;
  ctx.fill();
  ctx.fillStyle = accent ? '#173126' : palette.ink;
  ctx.fillText(visible, x + 15, y + 8);
  return width;
}

function background(ctx, palette, data, kind) {
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, 0, 12, HEIGHT);
  ctx.fillStyle = palette.ink;
  font(ctx, 23, 700);
  ctx.fillText('AI 漫剧', 76, 59);
  ctx.fillStyle = palette.muted;
  font(ctx, 16, 500);
  ctx.fillText(data.mode === 'making' ? '制作资源 / CREATOR RESOURCES' : '作品资源 / STORY RESOURCES', 76, 96);
  const label = kind === 'directory' ? '内容关键词' : '资源介绍';
  chip(ctx, label, 1014, 57, palette, true, 110);
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(76, 797);
  ctx.lineTo(1124, 797);
  ctx.stroke();
  ctx.fillStyle = palette.muted;
  font(ctx, 18);
  ctx.fillText(data.hasShare ? '资源详情与领取说明见正文' : '资源详情与整理说明见正文', 76, 826);
  font(ctx, 16);
  const footer = data.targetBar ? ellipsis(ctx, `发布参考 · ${data.targetBar}`, 465) : 'AI 漫剧 · 资源分享';
  ctx.textAlign = 'right';
  ctx.fillText(footer, 1124, 828);
  ctx.textAlign = 'left';
}

function abstractArt(ctx, x, y, width, height, palette) {
  ctx.save();
  rounded(ctx, x, y, width, height, 24);
  ctx.clip();
  ctx.fillStyle = palette.ink;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = palette.panel;
  ctx.beginPath();
  ctx.arc(x + width * 0.89, y + height * 0.34, width * 0.63, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = palette.accent;
  ctx.beginPath();
  ctx.arc(x + width * 0.14, y + height * 0.63, width * 0.44, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = palette.background;
  ctx.lineWidth = 2;
  for (let offset = 0; offset < 6; offset += 1) {
    ctx.beginPath();
    ctx.arc(x + width * 0.86, y + height * 0.31, width * (0.24 + offset * 0.05), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = palette.ink;
  ctx.fillRect(x + 29, y + height - 130, width - 58, 103);
  ctx.fillStyle = palette.background;
  font(ctx, 27, 700);
  ctx.fillText('资源介绍', x + 47, y + height - 110);
  font(ctx, 14);
  ctx.fillText('STORY · NOTES · MATERIALS', x + 47, y + height - 62);
  ctx.restore();
}

function artwork(ctx, image, x, y, width, height, palette) {
  const imageWidth = Number(image?.naturalWidth || image?.width || 0);
  const imageHeight = Number(image?.naturalHeight || image?.height || 0);
  if (!imageWidth || !imageHeight) {
    abstractArt(ctx, x, y, width, height, palette);
    return;
  }
  ctx.save();
  rounded(ctx, x, y, width, height, 24);
  ctx.clip();
  const ratio = Math.max(width / imageWidth, height / imageHeight);
  const croppedWidth = width / ratio;
  const croppedHeight = height / ratio;
  try {
    ctx.drawImage(image, (imageWidth - croppedWidth) / 2, (imageHeight - croppedHeight) / 2,
      croppedWidth, croppedHeight, x, y, width, height);
    const gradient = ctx.createLinearGradient(x, y + height * 0.5, x, y + height);
    gradient.addColorStop(0, 'rgba(12, 31, 23, 0)');
    gradient.addColorStop(1, 'rgba(12, 31, 23, 0.86)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = '#fffdf4';
    font(ctx, 21, 600);
    ctx.fillText('AI 漫剧 · 资源介绍', x + 24, y + height - 53);
  } catch {
    ctx.restore();
    abstractArt(ctx, x, y, width, height, palette);
    return;
  }
  ctx.restore();
}

function tags(ctx, data, x, y, maxWidth, palette) {
  const entries = [data.mode === 'making' ? '制作资源' : '作品分享', data.genre, data.completion].filter(Boolean);
  let cursor = x;
  for (const item of entries) {
    const remaining = x + maxWidth - cursor;
    if (remaining < 70) break;
    cursor += chip(ctx, item, cursor, y, palette, cursor === x, remaining) + 10;
  }
}

function cover(ctx, data, palette, image) {
  artwork(ctx, image, 794, 190, 330, 521, palette);
  tags(ctx, data, 76, 182, 665, palette);
  const titleHeight = titleBlock(ctx, data.title, 76, 253, 665, 278, palette);
  const summaryY = 253 + titleHeight + 29;
  const summary = data.synopsis || (data.mode === 'making' ? '制作内容与使用说明见正文。' : '作品介绍与内容关键词见正文。');
  paragraph(ctx, summary, 76, summaryY, 655, {
    size: 25, lineHeight: 38, maxLines: 3, color: palette.muted,
  });
  ctx.fillStyle = palette.ink;
  font(ctx, 21, 500);
  const info = data.episodes ? `更新 / 集数 · ${data.episodes}` : '更新信息待补充';
  ctx.fillText(ellipsis(ctx, info, 665), 76, 722);
  ctx.fillStyle = palette.muted;
  font(ctx, 16);
  ctx.fillText(ellipsis(ctx, `内容关键词 · ${data.keywords.join(' / ')}`, 665), 76, 758);
}

function directory(ctx, data, palette) {
  titleBlock(ctx, data.title, 76, 145, 1048, 155, palette, 62);
  tags(ctx, data, 76, 312, 1048, palette);
  data.keywords.forEach((item, index) => {
    const x = 76 + (index % 2) * 534;
    const y = 374 + Math.floor(index / 2) * 116;
    rounded(ctx, x, y, 514, 102, 16);
    ctx.fillStyle = index === 0 ? palette.panel : palette.paper;
    ctx.fill();
    ctx.fillStyle = palette.muted;
    font(ctx, 29, 500);
    ctx.fillText('#', x + 23, y + 30);
    paragraph(ctx, item, x + 64, y + 19, 422, {
      size: 29, lineHeight: 34, maxLines: 2, color: palette.ink, weight: 500,
    });
  });
  ctx.fillStyle = palette.muted;
  font(ctx, 18);
  ctx.fillText('内容介绍见正文', 76, 766);
}

/**
 * Compose a local 1200 × 900 poster. Only supplied metadata is used; share URLs
 * and access codes are deliberately excluded. Pass a loaded local image for
 * artwork, or omit it to use the original geometric illustration.
 * @returns {Promise<HTMLCanvasElement>} The same canvas, ready for PNG export.
 */
export async function renderPublishingPoster(canvas, input, { kind = 'cover', theme = 'forest', artwork: image = null } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('请提供可用的画布');
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* Local font fallbacks remain usable. */ }
  }
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境无法生成配图');
  const palette = Object.hasOwn(THEMES, theme) ? THEMES[theme] : THEMES.forest;
  const data = normalize(input);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  background(ctx, palette, data, kind);
  if (kind === 'directory') directory(ctx, data, palette);
  else cover(ctx, data, palette, image);
  return canvas;
}
