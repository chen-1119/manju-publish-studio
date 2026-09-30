import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, cleanQuery, matchesKind, normalizeIndexResult, normalizeResult, searchEngineLinks, searchLinks, uniqueResults } from './search.js';

test('builds separate platform queries and live search URLs', () => {
  assert.equal(cleanQuery('  古风   漫剧  '), '古风 漫剧');
  assert.match(buildQuery('古风漫剧', 'baidu'), /百度网盘 分享/);
  assert.match(buildQuery('古风漫剧', 'quark'), /夸克网盘 分享/);
  const links = searchLinks('古风漫剧');
  assert.match(decodeURIComponent(links.baidu), /百度网盘/);
  assert.match(decodeURIComponent(links.quark), /夸克网盘/);
});

test('general keywords and tutorial searches do not add the comic topic', () => {
  assert.equal(buildQuery('Python 基础', 'baidu'), 'Python 基础 百度网盘 分享');
  assert.equal(buildQuery('摄影', 'quark', 'making'), '摄影 教程 素材 夸克网盘 分享');
  assert.equal(matchesKind({ title: 'Python 入门教程' }, 'all'), true);
  assert.equal(matchesKind({ title: '摄影电子书' }, 'all'), true);
  assert.doesNotMatch(decodeURIComponent(searchLinks('电子书').quark), /AI漫剧/);
  assert.throws(() => buildQuery('Python', 'baidu', 'unknown'), /未知资源类型/);
  const engines = searchEngineLinks('Python 基础');
  assert.equal(new URL(engines.baidu.bing).searchParams.get('q'), 'Python 基础 百度网盘 分享');
  assert.equal(new URL(engines.quark.google).hostname, 'www.google.com');
});

test('normalizes results and rejects unsafe result URLs', () => {
  assert.equal(normalizeResult({ url: 'javascript:alert(1)', title: 'bad' }, 'baidu'), null);
  const result = normalizeResult({
    url: 'https://example.org/post',
    title: '<b>示例作品</b>',
    description: '分享地址 https://pan.quark.cn/s/abc123 提取码 1234',
  }, 'quark');
  assert.equal(result.title, '示例作品');
  assert.equal(result.shareUrl, 'https://pan.quark.cn/s/abc123');
  assert.equal(result.direct, true);
});

test('deduplicates repeated share links', () => {
  const results = [
    { sourceUrl: 'https://one.example', shareUrl: 'https://pan.baidu.com/s/abc' },
    { sourceUrl: 'https://two.example', shareUrl: 'https://pan.baidu.com/s/abc' },
  ];
  assert.equal(uniqueResults(results).length, 1);
});

test('merges link variants while preserving extraction codes and source labels', () => {
  const results = uniqueResults([
    { sourceUrl: 'https://one.example', shareUrl: 'https://pan.quark.cn/s/abc?x=1', sourceName: '索引' },
    { sourceUrl: 'https://two.example', shareUrl: 'https://pan.quark.cn/s/abc', sourceName: '聚合', accessCode: '1234' },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].accessCode, '1234');
  assert.deepEqual(results[0].sources, ['索引', '聚合']);
  const baidu = normalizeIndexResult({ pan: 'baidu', share_url: 'https://pan.baidu.com/share/init?surl=abc&pwd=1234' }, 'baidu');
  assert.equal(baidu.shareUrl, 'https://pan.baidu.com/s/1abc');
  assert.equal(baidu.accessCode, '1234');
});

test('accepts only matching official netdisk links from index and filters resource types', () => {
  const raw = {
    pan: 'quark',
    title: 'AI漫剧制作教学手册',
    share_url: 'https://pan.quark.cn/s/abc123',
    published_at: '2026-09-23T12:08:49+08:00',
  };
  const result = normalizeIndexResult(raw, 'quark');
  assert.equal(result.shareUrl, raw.share_url);
  assert.equal(matchesKind(result, 'making'), true);
  assert.equal(matchesKind(result, 'works'), false);
  assert.equal(normalizeIndexResult({ ...raw, share_url: 'https://evil.example/s/abc123' }, 'quark'), null);
});
