import { buildQuery, matchesKind, normalizeResult } from './search.js';

const labels = { brave: 'Brave Search', qiniu: '七牛云百度搜索' };

export class SearchApiError extends Error {}

async function requestSearch(provider, query, freshness, apiKey, fetcher, count) {
  if (!Object.hasOwn(labels, provider)) throw new SearchApiError('未知搜索 API');
  if (!apiKey) throw new SearchApiError('请先保存搜索密钥');
  let url;
  let options;
  if (provider === 'qiniu') {
    url = new URL('https://api.qnaigc.com/v1/search/web');
    const body = { query, max_results: count, search_type: 'web' };
    const timeFilter = { pd: 'week', pw: 'week', pm: 'month' }[freshness];
    if (timeFilter) body.time_filter = timeFilter;
    options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(18000),
    };
  } else {
    url = new URL('https://api.search.brave.com/res/v1/web/search');
    for (const [key, value] of Object.entries({ q: query, count: String(count), country: 'CN',
      search_lang: 'zh', ui_lang: 'zh-CN', result_filter: 'web', text_decorations: 'false' })) url.searchParams.set(key, value);
    if (freshness !== 'all') url.searchParams.set('freshness', freshness);
    options = { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey }, signal: AbortSignal.timeout(12000) };
  }
  let response;
  try { response = await fetcher(url, options); }
  catch { throw new SearchApiError('搜索 API 连接失败或超时，请检查网络后重试'); }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new SearchApiError('搜索密钥无效或无权限');
    if (response.status === 402) throw new SearchApiError('账号余额或可用资源包不足，请到 API 平台核对');
    if (response.status === 429) throw new SearchApiError('搜索额度或频率已达到上限');
    throw new SearchApiError(`搜索 API 返回 ${response.status}`);
  }
  let data;
  try { data = await response.json(); }
  catch { throw new SearchApiError('搜索 API 结果格式有误'); }
  const results = provider === 'qiniu' ? data?.data?.results : data?.web?.results;
  if (provider === 'qiniu' && data?.success !== true) throw new SearchApiError('七牛搜索未成功，请在控制台检查接口权限和可用额度');
  if (!Array.isArray(results)) throw new SearchApiError('搜索 API 结果格式有误');
  return results;
}

export async function searchProvider(provider, keyword, platform, kind, freshness, apiKey, fetcher = fetch) {
  const rows = await requestSearch(provider, buildQuery(keyword, platform, kind), freshness, apiKey, fetcher, provider === 'qiniu' ? 30 : 12);
  const cutoff = ({ pd: 1, pw: 7, pm: 31 }[freshness] || 0) * 86400000;
  return rows.map((raw) => normalizeResult({ ...raw,
    description: provider === 'qiniu' ? raw.content : raw.description,
    age: provider === 'qiniu' ? raw.date : raw.age,
    publishedAt: provider === 'qiniu' ? raw.date : undefined,
    sourceName: labels[provider],
  }, platform)).filter(Boolean).filter((result) => matchesKind(result, kind))
    // Qiniu has no daily option. Its week response is filtered locally to a day.
    .filter((result) => provider !== 'qiniu' || !cutoff || (result.publishedAt && Date.parse(result.publishedAt) >= Date.now() - cutoff));
}

export async function testSearchProvider(provider, apiKey, fetcher = fetch) {
  const results = await requestSearch(provider, '七牛云', 'all', apiKey, fetcher, 1);
  return { provider, resultCount: results.length };
}
