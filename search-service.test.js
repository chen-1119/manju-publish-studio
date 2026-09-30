import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAll } from './search-service.js';

const ok = (body) => ({ ok: true, json: async () => body });
const indexedItem = (platform) => ({
  pan: platform, title: 'Python 基础教程',
  share_url: `https://${platform === 'baidu' ? 'pan.baidu.com' : 'pan.quark.cn'}/s/shared`,
});

test('combines web results even when the index has matches and deduplicates share links', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.hostname === 'www.pansousuo.com') {
      assert.equal(url.searchParams.get('q'), 'Python 基础');
      return ok({ items: [indexedItem(url.searchParams.get('pan'))] });
    }
    assert.doesNotMatch(url.searchParams.get('q'), /AI漫剧/);
    const platform = url.searchParams.get('q').includes('百度') ? 'baidu' : 'quark';
    return ok({ web: { results: [
      { title: '同一教程', url: indexedItem(platform).share_url },
      { title: 'Python 基础电子书', url: `https://example.org/${platform}` },
    ] } });
  };
  const result = await searchAll('Python 基础', 'all', 'all', 'test-key', { fetcher, includePanSou: false });
  assert.equal(calls.length, 4);
  assert.equal(result.results.baidu.length, 2);
  assert.equal(result.results.quark.length, 2);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.warnings, {});
});

test('preserves available index results and reports web quota failures', async () => {
  const fetcher = async (url) => url.hostname === 'www.pansousuo.com'
    ? ok({ items: [indexedItem(url.searchParams.get('pan'))] })
    : { ok: false, status: 429 };
  const result = await searchAll('Python', 'all', 'all', 'test-key', { fetcher, includePanSou: false });
  assert.equal(result.results.baidu.length, 1);
  assert.equal(result.results.quark.length, 1);
  assert.deepEqual(result.errors, {});
  assert.match(result.warnings.baidu[0], /额度或频率/);
});

test('uses the available web source when the index fails', async () => {
  const fetcher = async (url) => {
    if (url.hostname === 'www.pansousuo.com') throw new Error('索引离线');
    return ok({ web: { results: [{ title: '摄影教程', url: 'https://example.org/photography' }] } });
  };
  const result = await searchAll('摄影教程', 'all', 'all', 'test-key', { fetcher, includePanSou: false });
  assert.equal(result.results.baidu.length, 1);
  assert.deepEqual(result.errors, {});
  assert.match(result.warnings.quark[0], /索引离线/);
});

test('needs no API key for index search and exposes complete source failures', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    assert.equal(url.hostname, 'www.pansousuo.com');
    if (url.searchParams.get('pan') === 'baidu') throw new Error('索引离线');
    return ok({ items: [indexedItem('quark')] });
  };
  const result = await searchAll('Python', undefined, undefined, undefined, { fetcher, includePanSou: false });
  assert.equal(calls.length, 2);
  assert.equal(result.results.baidu.length, 0);
  assert.match(result.errors.baidu, /索引离线/);
  assert.equal(result.results.quark.length, 1);
  assert.equal(result.errors.quark, undefined);
});

test('adds aggregated sources without an API key and only calls the aggregator once', async () => {
  let aggregateCalls = 0;
  const fetcher = async (url) => {
    if (url.hostname === 'www.pansousuo.com') return ok({ items: [], totalPages: 3 });
    aggregateCalls += 1;
    assert.equal(url.searchParams.get('kw'), '电子书');
    return ok({ code: 0, data: { merged_by_type: {
      quark: [{ url: 'https://pan.quark.cn/s/ebook', note: '电子书', source: 'plugin:example' }],
      baidu: [{ url: 'https://evil.example/s/ebook', note: '无效域名' }],
    } } });
  };
  const result = await searchAll('电子书', undefined, undefined, undefined, { fetcher });
  assert.equal(aggregateCalls, 1);
  assert.equal(result.results.quark.length, 1);
  assert.equal(result.results.quark[0].sourceName, 'PanSou · example');
  assert.equal(result.results.baidu.length, 0);
  assert.equal(result.pagination.quark.hasMore, true);
});

test('loads the next index page without repeating aggregation or consuming web quota', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    assert.equal(url.hostname, 'www.pansousuo.com');
    assert.equal(url.searchParams.get('p'), '2');
    return ok({ items: [], totalPages: 2 });
  };
  const result = await searchAll('Python', 'all', 'all', 'test-key', { fetcher, page: 2 });
  assert.equal(calls.length, 2);
  assert.equal(result.pagination.baidu.hasMore, false);
});
