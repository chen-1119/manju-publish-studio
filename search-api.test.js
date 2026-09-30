import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProvider, testSearchProvider } from './search-api.js';
import { searchAll } from './search-service.js';

const ok = (results) => ({ ok: true, json: async () => ({ success: true, data: { results } }) });

test('Qiniu uses the official authenticated search endpoint and preserves share codes and attribution', async () => {
  const results = await searchProvider('qiniu', 'Python', 'baidu', 'all', 'all', 'fixture-only-key', async (url, options) => {
    assert.equal(url.href, 'https://api.qnaigc.com/v1/search/web');
    assert.equal(url.searchParams.has('api_key'), false);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer fixture-only-key');
    assert.deepEqual(JSON.parse(options.body), { query: 'Python 百度网盘 分享', max_results: 30, search_type: 'web' });
    return ok([
      { title: '<b>Python 教程</b>', url: 'https://pan.baidu.com/s/1python?pwd=a123', content: '公开课程' },
      { title: '课程来源', url: 'https://example.org/course', content: 'https://pan.baidu.com/s/1book 提取码：b456' },
      { title: 'unsafe', url: 'javascript:alert(1)' },
    ]);
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Python 教程');
  assert.equal(results[0].shareUrl, 'https://pan.baidu.com/s/1python');
  assert.equal(results[0].accessCode, 'a123');
  assert.equal(results[1].accessCode, 'b456');
  assert.equal(results[1].sourceUrl, 'https://example.org/course');
  assert.equal(results[0].sourceName, '七牛云百度搜索');
});

test('daily Qiniu search filters its weekly response and excludes unknown dates', async () => {
  const results = await searchProvider('qiniu', '摄影', 'quark', 'all', 'pd', 'fixture-key', async (_url, options) => {
    assert.equal(JSON.parse(options.body).time_filter, 'week');
    return ok([
      { title: '新课程', url: 'https://pan.quark.cn/s/newest?pwd=1234', date: new Date(Date.now() - 3600000).toISOString() },
      { title: '旧课程', url: 'https://pan.quark.cn/s/older', date: new Date(Date.now() - 2 * 86400000).toISOString() },
      { title: '日期未知', url: 'https://pan.quark.cn/s/unknown' },
    ]);
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].accessCode, '1234');
  assert.equal(results[0].shareUrl, 'https://pan.quark.cn/s/newest');
});

test('Qiniu authentication, balance, throttling and malformed replies produce safe actionable errors', async () => {
  for (const [status, pattern] of [[401, /密钥无效/], [402, /余额或可用资源包不足/], [429, /额度或频率/]]) {
    await assert.rejects(testSearchProvider('qiniu', 'secret-fixture-key', async () => ({ ok: false, status })), pattern);
  }
  await assert.rejects(testSearchProvider('qiniu', 'secret-fixture-key', async () => ({ ok: true, json: async () => ({ success: false, message: 'secret-fixture-key' }) })), (error) => !error.message.includes('secret-fixture-key') && /未成功/.test(error.message));
  await assert.rejects(testSearchProvider('qiniu', 'secret-fixture-key', async () => ok([]).json().then((data) => ({ ok: true, json: async () => ({ ...data, data: {} }) }))), /结果格式/);
  await assert.rejects(testSearchProvider('qiniu', 'secret-fixture-key', async () => { throw new Error('secret-fixture-key'); }), (error) => !error.message.includes('secret-fixture-key') && /连接失败/.test(error.message));
});

test('connection test makes one small request and never returns account credentials or raw results', async () => {
  let calls = 0;
  const result = await testSearchProvider('qiniu', 'secret-fixture-key', async (_url, options) => {
    calls += 1;
    assert.equal(JSON.parse(options.body).max_results, 1);
    return ok([{ title: 'result', url: 'https://qiniu.com' }]);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { provider: 'qiniu', resultCount: 1 });
  await assert.rejects(testSearchProvider('qiniu', '', () => { throw new Error('must not run'); }), /先保存/);
});

test('Qiniu is combined with existing sources and only first-page searches consume its quota', async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    if (url.hostname === 'www.pansousuo.com') return { ok: true, json: async () => ({ items: [
      { pan: url.searchParams.get('pan'), title: 'Python', share_url: `https://${url.searchParams.get('pan') === 'baidu' ? 'pan.baidu.com' : 'pan.quark.cn'}/s/shared` },
    ], totalPages: 3 }) };
    calls += 1;
    const platform = JSON.parse(options.body).query.includes('百度') ? 'baidu' : 'quark';
    return ok([{ title: 'Python', url: `https://${platform === 'baidu' ? 'pan.baidu.com' : 'pan.quark.cn'}/s/shared?pwd=1234` }]);
  };
  const first = await searchAll('Python', 'all', 'all', '', { fetcher, includePanSou: false, qiniuApiKey: 'fixture-key' });
  assert.equal(calls, 2);
  assert.equal(first.results.baidu.length, 1);
  assert.equal(first.results.baidu[0].accessCode, '1234');
  assert.deepEqual(first.results.quark[0].sources, ['盘搜索公开索引', '七牛云百度搜索']);
  await searchAll('Python', 'all', 'all', '', { fetcher, includePanSou: false, qiniuApiKey: 'fixture-key', page: 2 });
  assert.equal(calls, 2);
});

test('a Qiniu balance failure retains index results with a provider-specific warning', async () => {
  const result = await searchAll('电子书', 'all', 'all', '', { includePanSou: false, qiniuApiKey: 'fixture-key', fetcher: async (url) => url.hostname === 'www.pansousuo.com'
    ? { ok: true, json: async () => ({ items: [], totalPages: 1 }) } : { ok: false, status: 402 } });
  assert.deepEqual(result.errors, {});
  assert.match(result.warnings.baidu[0], /七牛云百度搜索.*余额/);
});
