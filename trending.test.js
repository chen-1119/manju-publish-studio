import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTrending } from './trending.js';

test('recent hot list keeps works, filters old entries and deduplicates links', () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  const items = [
    { title: '漫剧教学课程', shareUrl: 'https://pan.quark.cn/s/a', publishedAt: '2026-09-29T00:00:00Z', heat: 8 },
    { title: '旧漫剧全集', shareUrl: 'https://pan.quark.cn/s/b', publishedAt: '2026-08-01T00:00:00Z', heat: 7 },
    { title: '新漫剧全集', shareUrl: 'https://pan.quark.cn/s/c', publishedAt: '2026-09-28T00:00:00Z', heat: 3 },
    { title: '新漫剧全集', shareUrl: 'https://pan.quark.cn/s/c', publishedAt: '2026-09-28T00:00:00Z', heat: 3 },
    { title: '另一部漫剧 更新至12集', shareUrl: 'https://pan.baidu.com/s/d', publishedAt: '2026-09-29T00:00:00Z', heat: 2 },
  ];
  assert.deepEqual(selectTrending(items, now).map((item) => item.shareUrl), [
    'https://pan.quark.cn/s/c', 'https://pan.baidu.com/s/d',
  ]);
});
