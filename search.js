import { baiduShareInput } from './baidu.js';

export const PLATFORMS = {
  baidu: { name: '百度网盘', hint: '百度网盘 分享' },
  quark: { name: '夸克网盘', hint: '夸克网盘 分享' },
};

const KIND_HINTS = {
  works: 'AI漫剧',
  making: '教程 素材',
  all: '',
};

export function cleanQuery(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

export function buildQuery(keyword, platform, kind = 'all') {
  const topic = cleanQuery(keyword);
  if (!topic) throw new Error('请输入搜索关键词');
  if (!PLATFORMS[platform]) throw new Error('未知网盘');
  if (!Object.hasOwn(KIND_HINTS, kind)) throw new Error('未知资源类型');
  return [topic, KIND_HINTS[kind], PLATFORMS[platform].hint].filter(Boolean).join(' ');
}

export function searchLinks(keyword, kind = 'all') {
  return Object.fromEntries(Object.keys(PLATFORMS).map((platform) => {
    const query = buildQuery(keyword, platform, kind);
    return [platform, `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`];
  }));
}

export function searchEngineLinks(keyword, kind = 'all') {
  return Object.fromEntries(Object.keys(PLATFORMS).map((platform) => {
    const query = buildQuery(keyword, platform, kind);
    return [platform, {
      baidu: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
      bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    }];
  }));
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function directShareUrl(text, platform) {
  const pattern = platform === 'baidu'
    ? /https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?[^\s<>"'，。；]*)?/i
    : /https?:\/\/pan\.quark\.cn\/s\/[\w-]+(?:\?[^\s<>"'，。；]*)?/i;
  return safeHttpUrl(text.match(pattern)?.[0]);
}

export function normalizeResult(raw, platform) {
  const sourceUrl = safeHttpUrl(raw?.url);
  if (!sourceUrl) return null;
  const title = cleanText(raw.title) || sourceUrl;
  const description = cleanText(raw.description);
  let shareUrl = directShareUrl(`${sourceUrl} ${description}`, platform);
  const textCode = `${title} ${description}`.match(/(?:提取码|访问码|密码)\s*[:：]?\s*([A-Za-z0-9]{4})(?![A-Za-z0-9])/i)?.[1] || '';
  let accessCode = '';
  if (shareUrl) {
    const parsed = platform === 'baidu' ? baiduShareInput(shareUrl, textCode) : null;
    if (platform === 'baidu') {
      shareUrl = parsed?.url || null;
      accessCode = parsed?.code || '';
    } else {
      const share = new URL(shareUrl);
      const code = share.searchParams.get('pwd') || textCode;
      accessCode = /^[A-Za-z0-9]{1,16}$/.test(code) ? code : '';
      shareUrl = `${share.origin}${share.pathname}`;
    }
  }
  const date = new Date(raw.publishedAt || '');
  return {
    title,
    description,
    sourceUrl,
    shareUrl,
    direct: Boolean(shareUrl),
    platform,
    age: cleanText(raw.age),
    publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
    sourceName: cleanText(raw.sourceName) || '公开网页',
    accessCode,
  };
}

export function normalizeIndexResult(raw, platform) {
  if (raw?.pan !== platform) return null;
  let shareUrl = safeHttpUrl(raw.share_url);
  if (!shareUrl) return null;
  const url = new URL(shareUrl);
  const hostname = platform === 'baidu' ? 'pan.baidu.com' : 'pan.quark.cn';
  if (url.hostname !== hostname) return null;
  const baiduShare = platform === 'baidu' ? baiduShareInput(shareUrl, cleanText(raw.access_code)) : null;
  if (platform === 'baidu') {
    if (!baiduShare) return null;
    shareUrl = baiduShare.url;
  } else if (!/^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
  const date = new Date(raw.published_at || raw.created_at || '');
  const age = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN');
  return {
    title: cleanText(raw.title) || shareUrl,
    description: cleanText(raw.description),
    sourceUrl: shareUrl,
    shareUrl,
    direct: true,
    platform,
    age,
    publishedAt: age ? date.toISOString() : null,
    heat: Math.max(0, Number(raw.heat) || 0),
    sourceName: '盘搜索公开索引',
    accessCode: baiduShare?.code || cleanText(raw.access_code),
  };
}

export function normalizeAggregateResult(raw, platform) {
  const result = normalizeIndexResult({ pan: platform, title: raw?.note,
    description: raw?.note, share_url: raw?.url, access_code: raw?.password,
    published_at: raw?.datetime }, platform);
  if (!result) return null;
  const source = cleanText(raw.source).replace(/^plugin:/, '').replace(/^tg:/, '频道 ');
  return { ...result, sourceName: source ? `PanSou · ${source}` : 'PanSou 聚合' };
}

const makingWords = /教程|素材|教学|课程|工具|提示词|工作流|创作|制作|手册|训练营|进阶课|大师课|变现课/;

export function matchesKind(result, kind) {
  if (kind === 'all') return true;
  const making = makingWords.test(result.title);
  return kind === 'making' ? making : !making;
}

export function uniqueResults(results) {
  const seen = new Map();
  for (const result of results) {
    let key = result.shareUrl || result.sourceUrl;
    if (result.shareUrl) {
      const url = new URL(result.shareUrl);
      key = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
    }
    const previous = seen.get(key);
    if (previous) {
      previous.accessCode ||= result.accessCode;
      previous.sources = [...new Set([...previous.sources, ...(result.sources || [result.sourceName]).filter(Boolean)])];
    } else seen.set(key, { ...result, sources: (result.sources || [result.sourceName]).filter(Boolean) });
  }
  return [...seen.values()];
}
