import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTransferResult, transferToBaiduRoot } from './baidu-web.js';

test('root transfer verifies the code, lists every page and preserves same-name files', async () => {
  const calls = [];
  const request = {
    get: async (address) => {
      const url = new URL(address); calls.push(url);
      if (url.pathname.startsWith('/s/')) return { ok: () => true, text: async () => 'share_uk:"123",shareid:"456"' };
      return { json: async () => ({ errno: 0, list: url.searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, (_, index) => ({ fs_id: index + 1 })) : [{ fs_id: 101 }] }) };
    },
    post: async (address, options) => {
      const url = new URL(address); calls.push(url);
      if (url.pathname === '/share/verify') {
        assert.equal(url.searchParams.get('surl'), 'test');
        assert.equal(options.form.pwd, 'abcd');
        return { json: async () => ({ errno: 0, randsk: 'test-sekey' }) };
      }
      assert.equal(url.pathname, '/share/transfer');
      assert.equal(url.searchParams.get('ondup'), 'newcopy');
      assert.equal(options.form.path, '/');
      assert.equal(JSON.parse(options.form.fsidlist).length, 101);
      return { json: async () => ({ errno: 0, extra: { list: [{ to: '/电子书.pdf' }] } }) };
    },
  };
  const context = { request, cookies: async () => [{ name: 'BDUSS', value: 'test-session' }, { name: 'BAIDUID', value: 'test-id' }] };
  const result = await transferToBaiduRoot(context, { url: 'https://pan.baidu.com/s/1test', code: 'abcd' });
  assert.equal(result.kind, 'saved');
  assert.equal(result.folder, '/');
  assert.equal(calls.filter((url) => url.pathname === '/share/list').length, 2);
});

test('does not report completion for an unconfirmed or queued transfer', () => {
  assert.deepEqual(browserTransferResult({ errno: 0, taskid: 789 }), { kind: 'submitted', taskId: '789', folder: '/' });
  assert.throws(() => browserTransferResult({ errno: 0 }), /未返回保存清单/);
  assert.throws(() => browserTransferResult({ errno: -12 }), /验证/);
});

test('rejects unexpected hosts and missing login before making any share request', async () => {
  const context = { cookies: async () => [], request: { get: () => { throw new Error('must not request'); } } };
  await assert.rejects(transferToBaiduRoot(context, { url: 'https://evil.example/s/test' }), /有效的百度/);
  await assert.rejects(transferToBaiduRoot(context, { url: 'https://pan.baidu.com/s/1test' }), /登录/);
});
