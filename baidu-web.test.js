import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserTransferResult, transferToBaiduRoot, waitForBaiduTransfer, createBaiduShare, confirmBaiduSavedFiles } from './baidu-web.js';
import { BaiduBrowser } from './baidu-browser.js';

const token = 'a'.repeat(32);
const owned = { fsId: '9001', path: '/作品', name: '作品', isdir: 1 };
const reply = (data) => ({ ok: () => true, json: async () => data });
const page = (text) => ({ ok: () => true, text: async () => text });

function mockContext(overrides = {}) {
  const calls = [];
  const state = { taskReplies: [{ errno: 0, status: 'success', task_errno: 0, list: [{ to: '/作品', to_fs_id: 9001 }] }], ...overrides };
  const context = {
    calls, state,
    cookies: async () => state.cookies ?? [{ name: 'BDUSS', value: 'mock-only' }, { name: 'BAIDUID', value: 'mock-id' }],
    request: {
      get: async (address, options) => {
        const url = new URL(address); calls.push({ method: 'get', url, options });
        const custom = await state.get?.(url, options);
        if (custom) return custom;
        if (url.pathname === '/disk/main') return page(state.diskHtml ?? `{"bdstoken":"${token}"}`);
        if (url.pathname === '/api/gettemplatevariable') return reply(state.template ?? { errno: 0, result: { bdstoken: token } });
        if (url.pathname.startsWith('/s/')) return page(url.pathname === '/s/1Owned' ? 'share_uk:"789",shareid:"999"' : 'share_uk:"123",shareid:"456"');
        if (url.pathname === '/share/taskquery') return reply(state.taskReplies.length > 1 ? state.taskReplies.shift() : state.taskReplies[0]);
        if (url.pathname === '/api/filemetas') {
          const targets = JSON.parse(url.searchParams.get('target'));
          return reply(state.metadata ?? { errno: 0, info: targets.map((target) => ({ fs_id: 9001, path: target, server_filename: target.split('/').pop(), isdir: 1 })) });
        }
        if (url.pathname === '/share/list') return reply(url.searchParams.get('shareid') === '999' ? (state.ownList ?? { errno: 0, list: [{ fs_id: 9001 }] }) : { errno: 0, list: [{ fs_id: 101 }] });
        throw new Error(`Unexpected mock GET ${url.pathname}`);
      },
      post: async (address, options) => {
        const url = new URL(address); calls.push({ method: 'post', url, options });
        const custom = await state.post?.(url, options);
        if (custom) return custom;
        if (url.pathname === '/share/verify') return reply({ errno: 0, randsk: 'mock-sekey' });
        if (url.pathname === '/share/transfer') return reply(state.transfer ?? { errno: 0, extra: { list: [{ to: '/作品', to_fs_id: 9001, from_fs_id: 101 }] } });
        if (url.pathname === '/share/set') return reply(state.shareReply ?? { errno: 0, link: 'https://pan.baidu.com/s/1Owned', pwd: options.form.pwd });
        throw new Error(`Unexpected mock POST ${url.pathname}`);
      },
    },
  };
  return context;
}

test('root transfer checks all source pages and resolves destination IDs in the current account', async () => {
  const context = mockContext({
    get: (url) => {
      if (url.pathname === '/share/list') return reply({ errno: 0, list: url.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => ({ fs_id: i + 1 })) : [{ fs_id: 101 }] });
      if (url.pathname === '/api/filemetas') return reply({ errno: 0, info: JSON.parse(url.searchParams.get('target')).map((target) => ({ path: target, fs_id: 10000 + Number(target.slice(3)), server_filename: target.slice(1), isdir: 0 })) });
    },
    transfer: { errno: 0, extra: { list: Array.from({ length: 101 }, (_, i) => ({ to: `/文件${i + 1}`, from_fs_id: i + 1 })) } },
  });
  const result = await transferToBaiduRoot(context, { url: 'https://pan.baidu.com/s/1test', code: 'abcd' });
  assert.equal(result.kind, 'saved');
  assert.equal(result.confirmed, true);
  assert.equal(result.files.length, 101);
  assert.equal(result.files[0].fsId, '10001');
  assert.equal(context.calls.filter((call) => call.url.pathname === '/share/list').length, 2);
  const transfer = context.calls.find((call) => call.url.pathname === '/share/transfer');
  assert.equal(transfer.url.searchParams.get('ondup'), 'newcopy');
  assert.equal(transfer.options.form.path, '/');
  assert.equal(JSON.parse(transfer.options.form.fsidlist).length, 101);
  assert.ok(context.calls.every((call) => call.url.pathname !== '/api/list'));
});

test('parsing a queued or unconfirmed response never invents a completion', () => {
  assert.deepEqual(browserTransferResult({ errno: 0, taskid: 789 }), { kind: 'submitted', taskId: '789', folder: '/' });
  assert.throws(() => browserTransferResult({ errno: 0 }), /未返回保存清单/);
  assert.throws(() => browserTransferResult({ errno: -12 }), /验证/);
  assert.throws(() => browserTransferResult({ errno: 0, extra: { list: [{ to: '/' }] } }), /清单异常/);
  assert.throws(() => browserTransferResult({ errno: 0, extra: { list: [{ to: '/作品', to_fs_id: 9007199254740992 }] } }), /编号异常/);
});

test('preflight errors are safe to retry, while a transfer POST uncertainty is fenced', async () => {
  for (const context of [mockContext({ cookies: [] }), mockContext({ post: (url) => url.pathname === '/share/verify' ? reply({ errno: -9 }) : null })]) {
    await assert.rejects(transferToBaiduRoot(context, { url: 'https://pan.baidu.com/s/1test', code: 'abcd' }), (error) => error.transferStarted === false);
    assert.ok(!context.calls.some((call) => call.url.pathname === '/share/transfer'));
  }
  const offline = mockContext({ post: (url) => { if (url.pathname === '/share/transfer') throw new Error('network failed'); } });
  await assert.rejects(transferToBaiduRoot(offline, { url: 'https://pan.baidu.com/s/1test' }), (error) => error.transferStarted === true);
  await assert.rejects(transferToBaiduRoot(mockContext(), { url: 'https://evil.example/s/test' }), (error) => error.transferStarted === false);
});

test('saved paths with delayed metadata stay pending and can be confirmed without another save', async () => {
  const context = mockContext({ metadata: { errno: 0, info: [] } });
  const pending = await transferToBaiduRoot(context, { url: 'https://pan.baidu.com/s/1test' });
  assert.equal(pending.kind, 'pending');
  assert.equal(pending.files[0].path, '/作品');
  context.state.metadata = undefined;
  const result = await waitForBaiduTransfer(context, pending);
  assert.equal(result.kind, 'saved');
  assert.equal(result.files[0].fsId, '9001');
  assert.equal(context.calls.filter((call) => call.url.pathname === '/share/transfer').length, 1);
});

test('source IDs, changed destination IDs and extra account files cannot become own-share inputs', async () => {
  const context = mockContext();
  await assert.rejects(confirmBaiduSavedFiles(context, [{ ...owned, fsId: '101' }]), /编号.*不一致/);
  await assert.rejects(confirmBaiduSavedFiles(context, [owned], { sourceIds: ['9001'] }), /编号.*不一致/);
  await assert.rejects(confirmBaiduSavedFiles(context, [owned], { expectedCount: 2 }), /不完整/);
  await assert.rejects(confirmBaiduSavedFiles(mockContext({ metadata: { errno: 0, info: [{ fs_id: 9001, path: '/别的文件' }] } }), [owned]), /当前百度账号/);
});

async function submitted(context) {
  context.state.transfer = { errno: 0, taskid: 789 };
  return transferToBaiduRoot(context, { url: 'https://pan.baidu.com/s/1test' });
}

test('task polling includes the originating task metadata and confirms only reported destinations', async () => {
  const context = mockContext({ taskReplies: [{ errno: 0, task_errno: 0, status: 'running' }, { errno: 0, task_errno: 0, status: 'success', list: [{ to: '/作品', to_fs_id: 9001 }] }] });
  const result = await waitForBaiduTransfer(context, await submitted(context), { timeoutMs: 1000, pollIntervalMs: 0 });
  assert.equal(result.confirmed, true);
  assert.equal(result.files[0].fsId, '9001');
  const query = context.calls.find((call) => call.url.pathname === '/share/taskquery');
  assert.equal(query.url.searchParams.get('shareid'), '456');
  assert.equal(query.url.searchParams.get('from'), '123');
  assert.equal(query.url.searchParams.get('taskid'), '789');
  assert.equal(query.url.searchParams.get('bdstoken'), token);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('a success task without destination paths fails closed; pending timeout stays pending', async () => {
  const noFiles = mockContext({ taskReplies: [{ errno: 0, status: 'success', task_errno: 0 }] });
  await assert.rejects(waitForBaiduTransfer(noFiles, await submitted(noFiles)), /保存清单不完整/);
  const running = mockContext({ taskReplies: [{ errno: 0, status: 'pending', task_errno: 0 }] });
  const result = await waitForBaiduTransfer(running, await submitted(running), { timeoutMs: 0 });
  assert.equal(result.kind, 'submitted');
  assert.equal(result.pending, true);
});

test('task failure, login expiry and verification are never interpreted as success', async () => {
  for (const [data, expression] of [
    [{ errno: 0, status: 'failed', task_errno: 111 }, /登录已失效/],
    [{ errno: 0, status: 'failed', task_errno: 132 }, /要求验证/],
    [{ errno: 0, status: 'success', task_errno: -10 }, /剩余空间/],
    [{ errno: 0, status: 'unexpected', task_errno: 0 }, /状态未知/],
  ]) {
    const context = mockContext({ taskReplies: [data] });
    await assert.rejects(waitForBaiduTransfer(context, await submitted(context)), expression);
  }
});

test('share creation sends only verified own IDs and confirms the resulting official link contents', async () => {
  const context = mockContext();
  const share = await createBaiduShare(context, [owned], { period: 7, accessCode: 'abcd' });
  assert.equal(share.shareUrl, 'https://pan.baidu.com/s/1Owned');
  assert.equal(share.accessCode, 'abcd');
  assert.equal(share.verified, true);
  const set = context.calls.find((call) => call.url.pathname === '/share/set');
  assert.deepEqual(JSON.parse(set.options.form.fid_list), [9001]);
  assert.equal(set.options.form.schannel, '4');
  assert.equal(set.options.form.period, '7');
  assert.equal(set.url.searchParams.get('bdstoken'), token);
  assert.ok(!JSON.stringify(share).includes(token));
});

test('missing HTML token uses the template variable API, but missing or logged-out token fails before sharing', async () => {
  const fallback = mockContext({ diskHtml: '<html></html>' });
  await createBaiduShare(fallback, [owned]);
  assert.ok(fallback.calls.some((call) => call.url.pathname === '/api/gettemplatevariable'));
  for (const context of [mockContext({ diskHtml: 'isLogin:0' }), mockContext({ diskHtml: '<html></html>', template: { errno: 0, result: {} } })]) {
    await assert.rejects(createBaiduShare(context, [owned]), /登录|会话/);
    assert.ok(!context.calls.some((call) => call.url.pathname === '/share/set'));
  }
});

test('unexpected share host, changed code, missing files and a mismatched shared list fail closed', async () => {
  for (const context of [
    mockContext({ shareReply: { errno: 0, link: 'https://evil.example/s/Fake' } }),
    mockContext({ shareReply: { errno: 0, link: 'https://pan.baidu.com/s/1Owned', pwd: 'xxxx' } }),
    mockContext({ ownList: { errno: 0, list: [{ fs_id: 101 }] } }),
  ]) await assert.rejects(createBaiduShare(context, [owned], { accessCode: 'abcd' }), /未能确认|不一致/);
  await assert.rejects(createBaiduShare(mockContext(), [{ fsId: '9001', path: '/' }]), /根目录/);
  await assert.rejects(createBaiduShare(mockContext(), [owned], { accessCode: '123' }), /4 位/);
});

async function testBrowser(t, context, directory) {
  const temp = directory || await fs.mkdtemp(path.join(os.tmpdir(), 'manju-baidu-test-'));
  if (!directory) t.after(async () => {
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith('manju-baidu-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const browser = new BaiduBrowser(process.cwd(), temp);
  await browser.receiptsReady;
  browser.context = context;
  browser.status = async () => ({ loggedIn: true });
  return { browser, temp };
}

test('browser receipts persist across restart and reject arbitrary or tampered files', async (t) => {
  const context = mockContext();
  const { browser, temp } = await testBrowser(t, context);
  const saved = await browser.save({ url: 'https://pan.baidu.com/s/1test' });
  assert.ok(saved.receiptId);
  const { browser: restarted } = await testBrowser(t, context, temp);
  await assert.rejects(restarted.createShare({ ...saved, files: [{ ...owned, fsId: '101' }] }), /凭据.*不一致/);
  await assert.rejects(restarted.createShare({ kind: 'saved', confirmed: true, files: [owned] }), /凭据/);
  const result = await restarted.createShare(JSON.parse(JSON.stringify(saved)), { accessCode: 'abcd' });
  assert.equal(result.verified, true);
  assert.equal(context.calls.filter((call) => call.url.pathname === '/share/transfer').length, 1);
});

test('a saved share candidate is reverified after restart without another share/set', async (t) => {
  const context = mockContext({ ownList: { errno: -12 } });
  const { browser, temp } = await testBrowser(t, context);
  const saved = await browser.save({ url: 'https://pan.baidu.com/s/1test' });
  await assert.rejects(browser.createShare(saved, { accessCode: 'abcd' }), /验证/);
  context.state.ownList = undefined;
  const { browser: restarted } = await testBrowser(t, context, temp);
  const share = await restarted.createShare(saved);
  assert.equal(share.accessCode, 'abcd');
  assert.equal(context.calls.filter((call) => call.url.pathname === '/share/set').length, 1);
});

test('unknown share creation outcome never triggers a second share/set', async (t) => {
  const context = mockContext({ post: (url) => { if (url.pathname === '/share/set') throw new Error('network failed after POST'); } });
  const { browser, temp } = await testBrowser(t, context);
  const saved = await browser.save({ url: 'https://pan.baidu.com/s/1test' });
  await assert.rejects(browser.createShare(saved), /未能确认/);
  const { browser: restarted } = await testBrowser(t, context, temp);
  await assert.rejects(restarted.createShare(saved), /不会重复创建/);
  assert.equal(context.calls.filter((call) => call.url.pathname === '/share/set').length, 1);
});

test('pending metadata receipts survive restart and resume only confirmation', async (t) => {
  const context = mockContext({ metadata: { errno: 0, info: [] } });
  const { browser, temp } = await testBrowser(t, context);
  const pending = await browser.save({ url: 'https://pan.baidu.com/s/1test' });
  assert.equal(pending.kind, 'pending');
  context.state.metadata = undefined;
  const { browser: restarted } = await testBrowser(t, context, temp);
  const saved = await restarted.waitForTransfer(pending);
  assert.equal(saved.confirmed, true);
  assert.equal(saved.receiptId, pending.receiptId);
  assert.equal(context.calls.filter((call) => call.url.pathname === '/share/transfer').length, 1);
});

test('metadata waits within its window and preserves task-success candidates across windows', async () => {
  let checks = 0;
  const context = mockContext({ get: (url) => {
    if (url.pathname === '/api/filemetas' && checks++ < 2) return reply({ errno: 0, info: [] });
  } });
  const pending = await transferToBaiduRoot(context, { url: 'https://pan.baidu.com/s/1test' });
  const saved = await waitForBaiduTransfer(context, pending, { timeoutMs: 100, pollIntervalMs: 0 });
  assert.equal(saved.confirmed, true);
  const queued = mockContext({ metadata: { errno: 0, info: [] } });
  const stillPending = await waitForBaiduTransfer(queued, await submitted(queued), { timeoutMs: 0 });
  assert.equal(stillPending.kind, 'pending');
  assert.equal(stillPending.files[0].path, '/作品');
  queued.state.metadata = undefined;
  assert.equal((await waitForBaiduTransfer(queued, stillPending, { timeoutMs: 0 })).confirmed, true);
});

test('a manager with an older pending checkpoint can read the upgraded durable receipt', async (t) => {
  const context = mockContext({ transfer: { errno: 0, taskid: 789 } });
  const { browser, temp } = await testBrowser(t, context);
  const older = await browser.save({ url: 'https://pan.baidu.com/s/1test' });
  const saved = await browser.waitForTransfer(older, { timeoutMs: 0 });
  assert.equal(saved.confirmed, true);
  const { browser: restarted } = await testBrowser(t, context, temp);
  const recovered = await restarted.waitForTransfer(older, { timeoutMs: 0 });
  assert.equal(recovered.confirmed, true);
  assert.deepEqual(recovered.files, saved.files);
  assert.equal(context.calls.filter((call) => call.url.pathname === '/share/transfer').length, 1);
});

test('share uncertainty flag blocks useless retries, while an explicit rejection remains retryable', async (t) => {
  const rejected = mockContext({ shareReply: { errno: -12 } });
  const { browser } = await testBrowser(t, rejected);
  const saved = await browser.save({ url: 'https://pan.baidu.com/s/1test' });
  await assert.rejects(browser.createShare(saved), (error) => !error.shareOutcomeUnknown);
  rejected.state.shareReply = undefined;
  assert.equal((await browser.createShare(saved)).verified, true);
  const unknown = mockContext({ post: (url) => { if (url.pathname === '/share/set') throw new Error('network'); } });
  const { browser: other } = await testBrowser(t, unknown);
  const result = await other.save({ url: 'https://pan.baidu.com/s/1test' });
  await assert.rejects(other.createShare(result), (error) => error.shareOutcomeUnknown === true);
  await assert.rejects(other.createShare(result), (error) => error.shareOutcomeUnknown === true);
  assert.equal(unknown.calls.filter((call) => call.url.pathname === '/share/set').length, 1);
});
